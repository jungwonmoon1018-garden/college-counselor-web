// Shutdown closes all three databases by their real handles, drains the
// HTTP server, and releases the budget reservations no call will reconcile.
// The vault and vector store are wrappers without a close() of their own,
// and calling one threw and left both databases open.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import Database from "better-sqlite3";
import { bindShutdown, shutdown } from "../server/shutdown.js";
import { initUsageBudget, reserveBudget } from "../security/usage-budget.js";

test("shutdown drains the server, releases open reservations and closes every database", async () => {
  const counselor = new Database(":memory:");
  initUsageBudget(counselor);
  reserveBudget(counselor, {
    studentId: "s1", grade: 11, requestId: "in-flight", model: "priced/model",
    maxInputTokens: 1000, maxOutputTokens: 1000, pricingLookup: () => ({ input: 1, output: 1 }),
  });
  const vault = { db: new Database(":memory:"), vaultPath: ":memory:", encryptionKey: "ab".repeat(32) };
  const vectors = { db: new Database(":memory:"), vectorPath: ":memory:" };
  const server = http.createServer((_req, res) => res.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  bindShutdown({ db: counselor, piiVault: vault, vectorStore: vectors, httpServer: server });

  const warnings = [];
  const originalExit = process.exit;
  const originalWarn = console.warn;
  const originalLog = console.log;
  let exitCode = null;
  process.exit = (code) => { exitCode = code; };
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  console.log = () => {};
  try {
    await shutdown("SIGTERM");
  } finally {
    process.exit = originalExit;
    console.warn = originalWarn;
    console.log = originalLog;
  }

  assert.equal(exitCode, 0);
  assert.equal(counselor.open, false);
  assert.equal(vault.db.open, false);
  assert.equal(vectors.db.open, false);
  assert.equal(server.listening, false);
  assert.deepEqual(warnings.filter((w) => /did not close/.test(w)), []);
});

test("shutdown marks an open reservation released before closing", async () => {
  const path = await import("node:path");
  const os = await import("node:os");
  const fs = await import("node:fs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-shutdown-"));
  const file = path.join(dir, "counselor.db");
  const counselor = new Database(file);
  initUsageBudget(counselor);
  reserveBudget(counselor, {
    studentId: "s1", grade: 11, requestId: "in-flight", model: "priced/model",
    maxInputTokens: 1000, maxOutputTokens: 1000, pricingLookup: () => ({ input: 1, output: 1 }),
  });
  bindShutdown({ db: counselor, piiVault: { db: new Database(":memory:") }, vectorStore: { db: new Database(":memory:") }, httpServer: null });
  const originalExit = process.exit;
  const originalLog = console.log;
  process.exit = () => {};
  console.log = () => {};
  try {
    await shutdown("SIGINT");
  } finally {
    process.exit = originalExit;
    console.log = originalLog;
  }
  const reopened = new Database(file, { readonly: true });
  assert.equal(reopened.prepare("SELECT status FROM usage_budget_reservations").get().status, "released");
  reopened.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
