import { describe, expect, it } from "vitest";
import { schoolsDueForNewCycle } from "./deadline-cycle-refresh.js";

const row = (title, dueDate, status = "open") => ({ id: title, title, dueAt: dueDate, dueDate, status });

// Reminders made for the 2026-27 cycle (Early Nov 1 2026 through the May 1
// 2027 commit date) and for 2028-29.
const harvard2026 = [
  row("Harvard University — Early (EA/ED) (approximate — verify)", "2026-11-01"),
  row("Harvard University — Regular Decision (approximate — verify)", "2027-01-01", "done"),
  row("Harvard University — Commit by (approximate — verify)", "2027-05-01"),
];
const rice2028 = [
  row("Rice University — Early (EA/ED) (approximate — for Fall 2029 entry)", "2028-11-01"),
  row("Rice University — Commit by (approximate — for Fall 2029 entry)", "2029-05-01"),
];

describe("schoolsDueForNewCycle", () => {
  it("names a school whose reminders all belong to a cycle before the student's", () => {
    const deadlines = [...harvard2026, ...rice2028, row("Harvard essay draft", "2026-12-01")];
    const due = schoolsDueForNewCycle({
      targetSchools: ["Harvard University", "Rice University"],
      deadlines,
      studentCycle: { startYear: 2028, classOf: 2029 },
    });
    expect(due).toEqual(["Harvard University"]);
  });

  it("leaves a school alone once it has a row in the student's cycle", () => {
    const deadlines = [...harvard2026, row("Harvard University — Regular Decision (approximate — for Fall 2028 entry)", "2028-01-01")];
    expect(schoolsDueForNewCycle({ targetSchools: ["Harvard University"], deadlines, studentCycle: { startYear: 2027, classOf: 2028 } })).toEqual([]);
  });

  it("leaves a school with no reminders alone, so removed ones are not made again", () => {
    expect(schoolsDueForNewCycle({ targetSchools: ["Yale University"], deadlines: harvard2026, studentCycle: { startYear: 2027, classOf: 2028 } })).toEqual([]);
  });

  it("makes nothing for a student whose own cycle has passed", () => {
    // The class of 2027 applied in 2026-27; from Feb 2027 the server plans in 2027-28.
    expect(schoolsDueForNewCycle({ targetSchools: ["Harvard University"], deadlines: harvard2026, studentCycle: { startYear: 2027, classOf: 2027 } })).toEqual([]);
  });

  it("rolls over with the planning cycle when the class year is unknown", () => {
    expect(schoolsDueForNewCycle({ targetSchools: ["Harvard University"], deadlines: harvard2026, studentCycle: { startYear: 2027, classOf: null } })).toEqual(["Harvard University"]);
  });

  it("does nothing without the student's cycle", () => {
    expect(schoolsDueForNewCycle({ targetSchools: ["Harvard University"], deadlines: harvard2026, studentCycle: null })).toEqual([]);
  });
});
