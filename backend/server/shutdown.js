// server/shutdown.js — closing down on SIGINT/SIGTERM: stop the jobs, close each
// database in its own try, always exit, and force the exit after five seconds.
// Moved out of server.js on 2026-09-21; the process.on wiring stays there.
// `deps` is server.js's routeDeps object: live getters onto the bindings
// these functions read there (db, piiVault, vectorStore).
import { stopAllJobs } from "../scouts/batch-jobs.js";

let deps;
export function bindShutdown(serverDeps) { deps = serverDeps; }

// ═══════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════
// Whatever happens below, the process exits: Render and the route tests both
// wait for it. db.close() throws while the boot-time CDS seeding still has a
// statement running (a SIGTERM two seconds after boot, as in a route test's
// teardown), and with the rejection guard below that no longer ends the
// process by itself — CI hung on it on 2026-09-16 (Windows kills the child
// outright, so local runs never reach this handler).
export async function shutdown(signal) {
  console.log(`\n[SHUTDOWN] ${signal} received. Stopping jobs and closing databases...`);
  const forceExit = setTimeout(() => process.exit(1), 5000);
  forceExit.unref();
  try {
    stopAllJobs();
    for (const [name, close] of [["counselor.db", () => deps.db.close()], ["pii-vault.db", () => deps.piiVault.close()], ["vectors.db", () => deps.vectorStore.close()]]) {
      try { close(); } catch (err) { console.warn(`[SHUTDOWN] ${name} did not close cleanly: ${err.message}`); }
    }
    console.log("[SHUTDOWN] All databases closed. Exiting.");
    process.exit(0);
  } catch (err) {
    console.error("[SHUTDOWN] failed:", err.message);
    process.exit(1);
  }
}
