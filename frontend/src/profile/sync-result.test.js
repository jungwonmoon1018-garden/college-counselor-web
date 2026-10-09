import { describe, expect, it } from "vitest";
import { describeSetAside, syncFailureMessage } from "./sync-result.js";

describe("what the student hears after a profile save", () => {
  it("names the reason a save was refused", () => {
    expect(syncFailureMessage(413)).toMatch(/too large to save/);
    expect(syncFailureMessage(429)).toMatch(/Too many saves in a row/);
    expect(syncFailureMessage(401)).toMatch(/sign in again/);
    expect(syncFailureMessage(503)).toMatch(/isn't available right now/);
    expect(syncFailureMessage(500)).toBe("Your profile didn't reach your counselor — try again.");
    expect(syncFailureMessage(undefined)).toBe("Your profile didn't reach your counselor — try again.");
  });

  it("names what the server set aside, once each, with the right pronoun", () => {
    expect(describeSetAside([])).toBe("");
    expect(describeSetAside(undefined)).toBe("");
    expect(describeSetAside([{ field: "gpa.unweighted", reason: "out_of_range" }]))
      .toBe("Saved, except your GPA, which couldn't be read — check it in your profile.");
    expect(describeSetAside([{ field: "testScores", reason: "invalid_entry", count: 2 }]))
      .toBe("Saved, except 2 test scores, which couldn't be read — check them in your profile.");
    expect(describeSetAside([
      { field: "gpa.unweighted", reason: "out_of_range" },
      { field: "gpa", reason: "not_an_object" },
      { field: "apScores", reason: "invalid_entry", count: 1 },
      { field: "courses", reason: "not_a_list" },
    ])).toBe("Saved, except your GPA, 1 AP score and your course list, which couldn't be read — check them in your profile.");
    expect(describeSetAside([{ field: "somethingNew", reason: "x" }]))
      .toBe("Saved, except one field, which couldn't be read — check it in your profile.");
  });
});
