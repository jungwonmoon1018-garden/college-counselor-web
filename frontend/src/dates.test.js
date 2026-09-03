import { describe, expect, it } from "vitest";
import { formatServerDate, serverDateToISO } from "./dates.js";

describe("server timestamps", () => {
  it("normalizes SQLite's space-separated UTC form to strict ISO-8601", () => {
    expect(serverDateToISO("2026-09-02 14:05:09")).toBe("2026-09-02T14:05:09Z");
    // Already-ISO values and empties pass through untouched.
    expect(serverDateToISO("2026-09-02T14:05:09.000Z")).toBe("2026-09-02T14:05:09.000Z");
    expect(serverDateToISO(null)).toBe("");
  });

  it("parses as UTC regardless of the runtime timezone", () => {
    expect(new Date(serverDateToISO("2026-09-02 14:05:09")).toISOString()).toBe("2026-09-02T14:05:09.000Z");
  });

  it("renders a date for valid values and nothing for garbage", () => {
    expect(formatServerDate("2026-09-02 14:05:09")).not.toBe("");
    expect(formatServerDate("not a date")).toBe("");
    expect(formatServerDate(undefined)).toBe("");
  });
});
