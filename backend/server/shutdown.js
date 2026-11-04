// server/shutdown.js — closing down on SIGINT/SIGTERM: stop the jobs, stop
// accepting connections and give in-flight requests a moment to finish,
// release the budget reservations no call will now reconcile, close each
// database in its own try, always exit, and force the exit after five
// seconds. Moved out of server.js on 2026-09-21; the process.on wiring stays
// there. `deps` is server.js's routeDeps object: live getters onto the
// bindings these functions read there (db, httpServer, piiVault, vectorStore).
import { stopAllJobs } from "../scouts/batch-jobs.js";
import { releaseStaleReservations } from "../security/usage-budget.js";

let deps;
export function bindShutdown(serverDeps) { deps = serverDeps; }

// Under the five-second force exit, with room left to close the databases.
const DRAIN_MS = 3000;

// Stops accepting connections and resolves once the in-flight requests are
// done or DRAIN_MS has passed, whichever is first. A deploy used to cut every
// answer in progress off at once.
function drainHttpServer(server, waitMs = DRAIN_MS) {
  if (!server || typeof server.close !== "function") return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), waitMs);
    timer.unref?.();
    try {
      server.close(() => { clearTimeout(timer); resolve(true); });
      // Keep-alive sockets with no request on them would hold close() open.
      server.closeIdleConnections?.();
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

// ═══════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════
// Whatever happens below, the process exits: Render and the route tests both
// wait for it. db.close() throws while the boot-time CDS seeding still has a
// statement running (a SIGTERM two seconds after boot, as in a route test's
// teardown), and with the rejection guard below that no longer ends the
// process by itself — CI hung on it on 2026-09-16 (Windows kills the child
// outright, so local runs never reach this handler).
//
// The vault and vector store are wrappers ({ db, vaultPath, encryptionKey },
// { db, vectorPath }) with no close() of their own; calling one threw, was
// logged as "did not close cleanly", and left both databases open. Their
// handles are closed directly.
export async function shutdown(signal) {
  console.log(`\n[SHUTDOWN] ${signal} received. Stopping jobs and closing databases...`);
  const forceExit = setTimeout(() => process.exit(1), 5000);
  forceExit.unref();
  try {
    stopAllJobs();
    await drainHttpServer(deps.httpServer);
    // A reservation still open belongs to a call this process will not
    // finish; release it now rather than leave it for the next boot.
    try {
      const { released } = releaseStaleReservations(deps.db, { createdBefore: new Date(Date.now() + 1) });
      if (released) console.log(`[SHUTDOWN] Released ${released} open budget reservation(s).`);
    } catch (err) {
      console.warn(`[SHUTDOWN] reservation release failed: ${err.message}`);
    }
    const handles = [
      ["counselor.db", () => deps.db],
      ["pii-vault.db", () => deps.piiVault?.db],
      ["vectors.db", () => deps.vectorStore?.db],
    ];
    for (const [name, handle] of handles) {
      try {
        const database = handle();
        if (database?.open) database.close();
      } catch (err) {
        console.warn(`[SHUTDOWN] ${name} did not close cleanly: ${err.message}`);
      }
    }
    console.log("[SHUTDOWN] All databases closed. Exiting.");
    clearTimeout(forceExit);
    process.exit(0);
  } catch (err) {
    console.error("[SHUTDOWN] failed:", err.message);
    clearTimeout(forceExit);
    process.exit(1);
  }
}
