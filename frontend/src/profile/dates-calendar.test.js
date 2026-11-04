import { describe, expect, it } from "vitest";
import {
  calendarDateOf,
  daysUntilDue,
  dueSortKey,
  formatDueDate,
  formatServerDateTime,
  localDateString,
  parseServerDate,
} from "./dates.js";

// Every clock here is built from local parts, so each case holds in any
// time zone the suite runs in: the property under test is that a typed date
// never moves, whatever the zone.
describe("deadline dates are calendar dates", () => {
  it("shows a typed date as that date, and an older UTC-midnight row too", () => {
    expect(formatDueDate("2026-11-01", "en-US")).toBe("Nov 1, 2026");
    expect(formatDueDate("2026-11-01T00:00:00.000Z", "en-US")).toBe("Nov 1, 2026");
    expect(formatDueDate("not a date", "en-US")).toBe("");
    expect(calendarDateOf("2026-11-01T17:00:00.000Z")).toBe(null);
  });

  it("is due all through its own local day and overdue only after it", () => {
    expect(daysUntilDue("2026-11-01", new Date(2026, 10, 1, 0, 0))).toBe(0);
    expect(daysUntilDue("2026-11-01", new Date(2026, 10, 1, 23, 59))).toBe(0);
    expect(daysUntilDue("2026-11-01", new Date(2026, 10, 2, 0, 1))).toBe(-1);
    expect(daysUntilDue("2026-11-01", new Date(2026, 9, 31, 21, 0))).toBe(1);
    // Across a month and a year end.
    expect(daysUntilDue("2027-01-01", new Date(2026, 11, 31, 22, 0))).toBe(1);
    // A real instant is overdue the moment it passes.
    const instant = new Date(2026, 10, 1, 17, 0);
    expect(daysUntilDue(instant.toISOString(), new Date(2026, 10, 1, 16, 0))).toBe(0);
    expect(daysUntilDue(instant.toISOString(), new Date(2026, 10, 1, 18, 0))).toBe(-1);
    expect(daysUntilDue("junk")).toBe(null);
  });

  it("names today's local date and sorts dates among instants", () => {
    expect(localDateString(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(dueSortKey("2026-11-01")).toBeLessThan(dueSortKey("2026-11-02"));
    expect(dueSortKey("junk")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("server timestamps", () => {
  it("reads SQLite's UTC time as UTC, with or without the T", () => {
    expect(parseServerDate("2026-11-03 05:00:00").toISOString()).toBe("2026-11-03T05:00:00.000Z");
    expect(parseServerDate("2026-11-03T05:00:00").toISOString()).toBe("2026-11-03T05:00:00.000Z");
    expect(parseServerDate("2026-11-03T05:00:00.000Z").toISOString()).toBe("2026-11-03T05:00:00.000Z");
    expect(parseServerDate(null)).toBe(null);
    expect(parseServerDate("garbage")).toBe(null);
  });

  it("formats the viewer's local date and time, never Invalid Date", () => {
    const expected = new Date("2026-11-03T05:00:00Z").toLocaleString("en-US");
    expect(formatServerDateTime("2026-11-03 05:00:00", "en-US")).toBe(expected);
    expect(formatServerDateTime("garbage", "en-US")).toBe("");
  });
});
