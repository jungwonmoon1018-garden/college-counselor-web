// Expiry columns hold ISO strings ("…T…Z"); SQLite's datetime('now') is
// "YYYY-MM-DD HH:MM:SS". Compared as text, "T" sorts after " ", so a row
// stayed current for the whole UTC day it expired on. The simulation store
// keeps minors' what-if profiles for a week, and must drop them on time.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupExpiredSimulations, closeSimulationStore, getSimulation, initSimulationStore } from "../simulation/simulation-engine.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "college-counselor-sim-expiry-"));
const store = initSimulationStore(dir);

after(() => {
  closeSimulationStore(store);
  fs.rmSync(dir, { recursive: true, force: true });
});

function insert(id, expiresAt) {
  store.profileStmts.insert.run(id, "student-1", "scenario", "{}", "{}", "{}", JSON.stringify({ targets: [] }), expiresAt);
  store.vectorStmts.insert.run(`${id}-v`, id, "student-1", "ec_strength", "Robotics", "{}", expiresAt);
}

test("a simulation an hour past its ISO expiry is gone; one an hour short of it is served", () => {
  insert("sim-expired", new Date(Date.now() - 60 * 60 * 1000).toISOString());
  insert("sim-current", new Date(Date.now() + 60 * 60 * 1000).toISOString());
  insert("sim-unreadable", "someday");
  assert.equal(store.profileStmts.get.get("sim-expired", "student-1"), undefined);
  assert.deepEqual(store.vectorStmts.list.all("sim-expired", "student-1"), []);
  const current = getSimulation(store, "student-1", "sim-current");
  assert.equal(current.simulationId, "sim-current");
  assert.equal(current.vectors.length, 1);
  // getSimulation already ran the cleanup; a second pass finds nothing.
  assert.deepEqual(cleanupExpiredSimulations(store), { profiles: 0, vectors: 0 });
  assert.equal(store.profileStmts.count.get().count, 1, "the expired and the unreadable rows were deleted");
  assert.equal(store.vectorStmts.count.get().count, 1);
});
