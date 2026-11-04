import { describe, expect, it } from "vitest";
import {
  baseFromData, baseFromPayload, buildSyncPayload, describeProfileConflict, isDirty,
  readServerProfile, reconcileProfile, sameValue, vaultSyncRecord,
} from "./profile-reconcile.js";

// The audit's stale-device case: the server holds what the student saved on
// the home laptop, and the school Chromebook's vault is a day old with the
// same number of courses and activities.
const serverBody = {
  revision: "r2",
  profile: {
    gpa: { unweighted: 3.85, weighted: 4.3 },
    classRank: null,
    courses: [{ name: "Chemistry Honors", type: "honors", grade: "A", year: "junior" }],
    apScores: [{ exam: "Biology", score: 5, year: 2026 }],
    testScores: [{ test: "sat", totalScore: 1520 }],
    activities: [{ id: "a1", name: "Robotics", role: "Captain" }],
    majorInterest: "Bioengineering",
    goals: ["STEM-focused"],
    lastUpdated: "2026-11-02 10:00:00",
  },
};

const staleDevice = {
  profile: {
    gpa: { unweighted: 3.8 },
    courses: [{ name: "Chemistry Honors", type: "honors", grade: "B+", year: "junior" }],
    apScores: [{ exam: "Biology", score: 4, year: 2026 }],
    testScores: [{ test: "sat", totalScore: 1450 }],
    majorInterest: "Biology",
  },
  activities: [{ id: "a0", name: "Quit club", role: "Member" }],
  goals: ["STEM-focused"],
  majorInterest: "Biology",
  studyNotes: [{ id: "n1" }],
  surveyCompleted: true,
};

describe("joining the device's profile with the server's", () => {
  it("lets a newer server profile win whole when the device edited nothing since its base", () => {
    const result = reconcileProfile({ local: staleDevice, server: readServerProfile(serverBody), base: baseFromData(staleDevice, "r1") });
    const { profile, activities, majorInterest } = result.data;
    expect(profile.gpa).toEqual({ unweighted: 3.85, weighted: 4.3 });
    expect(profile.testScores).toEqual([{ test: "sat", totalScore: 1520 }]);
    expect(profile.apScores).toEqual([{ exam: "Biology", score: 5, year: 2026 }]);
    expect(profile.courses[0].grade).toBe("A");
    // The activity deleted on the other device stays deleted.
    expect(activities.map((a) => a.name)).toEqual(["Robotics"]);
    expect(majorInterest).toBe("Bioengineering");
    expect(profile.majorInterest).toBe("Bioengineering");
    // What the sync does not carry stays as the device holds it.
    expect(result.data.studyNotes).toEqual([{ id: "n1" }]);
    expect(result.data.surveyCompleted).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(result.base.serverRevision).toBe("r2");
    expect(isDirty(result.data, result.base)).toBe(false);
  });

  it("treats a vault from before sync bases as unedited, so the server wins it", () => {
    const result = reconcileProfile({ local: staleDevice, server: readServerProfile(serverBody), base: null });
    expect(result.data.profile.testScores[0].totalScore).toBe(1520);
    expect(result.data.activities.map((a) => a.name)).toEqual(["Robotics"]);
    expect(isDirty(result.data, result.base)).toBe(false);
  });

  it("keeps a field the device edited since its base, and only that field", () => {
    const base = baseFromData(staleDevice, "r1");
    const edited = { ...staleDevice, profile: { ...staleDevice.profile, testScores: [{ test: "act", totalScore: 34 }] } };
    const result = reconcileProfile({ local: edited, server: readServerProfile(serverBody), base });
    expect(result.data.profile.testScores).toEqual([{ test: "act", totalScore: 34 }]);
    expect(result.data.profile.gpa).toEqual({ unweighted: 3.85, weighted: 4.3 });
    expect(result.kept).toEqual(["testScores"]);
    expect(result.conflicts).toEqual(["testScores"]);
    expect(result.adopted).toEqual(expect.arrayContaining(["gpa", "courses", "apScores", "activities", "majorInterest"]));
    // The kept edit is still to be sent, against the server's revision.
    expect(isDirty(result.data, result.base)).toBe(true);
    expect(buildSyncPayload(result.data, result.base).baseRevision).toBe("r2");
    expect(describeProfileConflict(result)).toMatch(/^Your profile changed on another device\. This device kept your edits to your test scores and took your /);
  });

  it("keeps the device's copy whole when the server has no profile yet", () => {
    const result = reconcileProfile({ local: staleDevice, server: readServerProfile({ profile: null }), base: null });
    expect(result.data).toBe(staleDevice);
    expect(result.changed).toBe(false);
    expect(isDirty(staleDevice, result.base)).toBe(true);
  });

  it("reads the server's no-GPA answer as no GPA, not as a GPA of two nulls", () => {
    const body = { revision: 3, profile: { ...serverBody.profile, gpa: { unweighted: null, weighted: null } } };
    const result = reconcileProfile({ local: { profile: null, activities: [] }, server: readServerProfile(body), base: null });
    expect(result.data.profile.gpa).toBe(null);
  });

  it("keeps the device's 'no GPA yet' when the server does not store that statement, and drops it once a GPA arrives", () => {
    const local = { profile: { gpa: null, gpaStatus: "pending", testingStatus: "planned" }, activities: [] };
    const withoutGpa = { profile: { ...serverBody.profile, gpa: { unweighted: null, weighted: null }, testScores: [] } };
    expect(reconcileProfile({ local, server: readServerProfile(withoutGpa), base: baseFromData(local) }).data.profile).toMatchObject({ gpaStatus: "pending", testingStatus: "planned" });
    const withGpa = reconcileProfile({ local, server: readServerProfile(serverBody), base: baseFromData(local) }).data.profile;
    expect(withGpa.gpaStatus).toBeUndefined();
    expect(withGpa.testingStatus).toBeUndefined();
    // A server that does store them is followed.
    const statusServer = { profile: { ...withoutGpa.profile, gpaStatus: null, testingStatus: "planned" } };
    expect(reconcileProfile({ local, server: readServerProfile(statusServer), base: baseFromData(local) }).data.profile.gpaStatus).toBeUndefined();
  });

  it("keeps a field the server's answer does not report, rather than reading it as deleted", () => {
    // A conflict body that carries only part of the record must not wipe
    // the rest; one that carries the activities beside the profile is read.
    const partial = readServerProfile({ code: "profile_revision_conflict", revision: "r3", profile: { testScores: [{ test: "sat", totalScore: 1520 }] }, activities: [{ name: "Robotics" }] });
    expect(Object.keys(partial.view).sort()).toEqual(["activities", "testScores"]);
    const result = reconcileProfile({ local: staleDevice, server: partial, base: baseFromData(staleDevice, "r1") });
    expect(result.data.profile.courses).toEqual(staleDevice.profile.courses);
    expect(result.data.goals).toEqual(["STEM-focused"]);
    expect(result.data.activities).toEqual([{ name: "Robotics" }]);
    expect(result.data.profile.testScores[0].totalScore).toBe(1520);
  });

  it("raises no conflict when the server only normalized what this device sent", () => {
    const sent = { profile: { gpa: { unweighted: 3.9 }, apScores: [{ exam: "US History", score: 5, year: 2099 }] }, activities: [], goals: [], majorInterest: "" };
    const base = baseFromPayload(buildSyncPayload(sent), "r5");
    const stored = { revision: "r5", profile: { gpa: { unweighted: 3.9, weighted: null }, apScores: [{ exam: "US History", score: 5 }], courses: [], testScores: [], activities: [], goals: [], majorInterest: null } };
    const result = reconcileProfile({ local: sent, server: readServerProfile(stored), base });
    expect(result.data.profile.apScores).toEqual([{ exam: "US History", score: 5 }]);
    expect(result.conflicts).toEqual([]);
    expect(result.kept).toEqual([]);
  });
});

describe("the sync base and what is sent", () => {
  it("counts nothing as unsent until a field moves away from the base", () => {
    const base = baseFromData(staleDevice, "r1");
    expect(isDirty(staleDevice, base)).toBe(false);
    expect(isDirty({ ...staleDevice, goals: ["Campus life"] }, base)).toBe(true);
    // Key order, a missing key and an empty value are the same thing.
    expect(sameValue({ a: 1, b: null, c: [] }, { a: 1 })).toBe(true);
    expect(sameValue([{ name: "x", grade: "" }], [{ grade: undefined, name: "x" }])).toBe(true);
    expect(sameValue({ unweighted: 3.8 }, { unweighted: 3.85 })).toBe(false);
  });

  it("records the revision, the snapshot and the unsent flag for the vault", () => {
    const base = baseFromData(staleDevice, "r1");
    expect(vaultSyncRecord(staleDevice, base)).toEqual({ serverRevision: "r1", snapshot: base.snapshot, dirty: false });
    expect(vaultSyncRecord(staleDevice, null)).toBeUndefined();
  });

  it("sends the base revision only when one is known", () => {
    expect(buildSyncPayload(staleDevice, null)).not.toHaveProperty("baseRevision");
    expect(buildSyncPayload(staleDevice, { serverRevision: 0 }).baseRevision).toBe(0);
    expect(buildSyncPayload({ profile: { majorInterest: "Physics" } }, null).majorInterest).toBe("Physics");
  });
});
