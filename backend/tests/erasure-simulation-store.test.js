// Account erasure in the simulation sidecar's own databases
// (simulation/simulation-engine.js deleteStudentSimulations, served at
// DELETE /students/:id). A scenario's base_profile_json is the student's
// whole profile and narrative, so every row of the student goes, expired
// or not, and nobody else's.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initSimulationStore,
  closeSimulationStore,
  createSimulation,
  deleteStudentSimulations,
} from "../simulation/simulation-engine.js";

function scenario(studentId) {
  return {
    studentId,
    baseProfile: {
      gpa: { unweighted: 3.7 },
      activities: [{ name: "Harbor Tide Tutors", role: "Founder", description: "Tutors kids at the harbor." }],
      majorInterest: "Biology",
      narrative: "I tutor kids at the harbor.",
    },
    profilePatch: { gpa: { unweighted: 3.9 } },
  };
}

test("deleteStudentSimulations removes every scenario of one student and reports the counts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sim-erasure-"));
  const store = initSimulationStore(dir);
  try {
    const gone = "student-erased";
    const kept = "student-kept";
    await createSimulation(store, scenario(gone));
    await createSimulation(store, scenario(gone));
    const keptSim = await createSimulation(store, scenario(kept));
    // A scenario past its expiry that the cleanup has not reached yet still
    // holds the profile, so it goes too.
    store.profileDb.prepare("UPDATE simulated_profiles SET expires_at = '2000-01-01T00:00:00.000Z' WHERE student_id = ? AND rowid = (SELECT MIN(rowid) FROM simulated_profiles WHERE student_id = ?)").run(gone, gone);

    const count = (db, table, id) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE student_id = ?`).get(id).n;
    const goneVectors = count(store.vectorDb, "simulated_vectors", gone);
    assert.ok(goneVectors >= 2);

    assert.deepEqual(deleteStudentSimulations(store, gone), { profiles: 2, vectors: goneVectors });
    assert.equal(count(store.profileDb, "simulated_profiles", gone), 0);
    assert.equal(count(store.vectorDb, "simulated_vectors", gone), 0);
    assert.equal(count(store.profileDb, "simulated_profiles", kept), 1);
    assert.equal(count(store.vectorDb, "simulated_vectors", kept), keptSim.vectors.length);
    assert.deepEqual(deleteStudentSimulations(store, gone), { profiles: 0, vectors: 0 });

    // No id, no delete: an empty id must never be read as "everyone".
    assert.throws(() => deleteStudentSimulations(store, ""), { status: 400 });
    assert.equal(count(store.profileDb, "simulated_profiles", kept), 1);

    // The delete by student is an index lookup, not a scan of every scenario.
    const plan = store.vectorDb.prepare("EXPLAIN QUERY PLAN DELETE FROM simulated_vectors WHERE student_id = ?").all("x").map((row) => row.detail).join(" ");
    assert.match(plan, /idx_sim_vectors_student/);
  } finally {
    closeSimulationStore(store);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
