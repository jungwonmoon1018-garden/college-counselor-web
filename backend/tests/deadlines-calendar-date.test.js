// A deadline the student types is a calendar date. It used to be stored as
// UTC midnight and counted with Math.round of milliseconds, so a Jan 1 row
// read "overdue" (and, before Aug 1, vanished) from 12:00 UTC on Jan 1, and
// a New York student saw it as Dec 31. Every clock here is fixed.
import test from "node:test";
import assert from "node:assert/strict";
import {
  anywhereOnEarthToday,
  calendarDateOf,
  calendarDaysBetween,
  daysUntilDue,
  normalizeDueValue,
  referenceToday,
  sqliteUtcToIso,
} from "../shared/calendar-date.js";
import { shapeDeadline } from "../server/ec-ranking.js";

const at = (iso) => Date.parse(iso);

test("a date-only value and an older UTC-midnight row both read as the date typed", () => {
  assert.equal(calendarDateOf("2027-01-01"), "2027-01-01");
  assert.equal(calendarDateOf("2027-01-01T00:00:00.000Z"), "2027-01-01");
  assert.equal(calendarDateOf("2027-01-01T00:00:00Z"), "2027-01-01");
  assert.equal(calendarDateOf("2027-01-01T17:00:00.000Z"), null, "a real instant stays an instant");
  assert.equal(calendarDateOf("2027-02-30"), null, "not a real date");
  assert.equal(normalizeDueValue("2027-01-01"), "2027-01-01");
  assert.equal(normalizeDueValue("2027-01-01T00:00:00.000Z"), "2027-01-01");
  assert.equal(normalizeDueValue("2027-01-02T12:00:00.000Z"), "2027-01-02T12:00:00.000Z");
  assert.equal(normalizeDueValue("next tuesday"), null);
});

test("Anywhere-on-Earth today runs twelve hours behind UTC", () => {
  assert.equal(anywhereOnEarthToday(at("2027-01-01T12:01:00Z")), "2027-01-01");
  assert.equal(anywhereOnEarthToday(at("2027-01-02T11:59:00Z")), "2027-01-01");
  assert.equal(anywhereOnEarthToday(at("2027-01-02T12:00:00Z")), "2027-01-02");
  assert.equal(calendarDaysBetween("2026-12-31", "2027-01-01"), 1);
  assert.equal(calendarDaysBetween("2027-03-01", "2027-02-27"), -2);
});

test("a claimed local date counts only when it is today somewhere on Earth", () => {
  const now = at("2027-01-01T12:00:00Z");
  assert.equal(referenceToday("2027-01-02", now), "2027-01-02", "Seoul at 21:00 on Jan 1 UTC is Jan 2");
  assert.equal(referenceToday("2027-01-01", now), "2027-01-01");
  assert.equal(referenceToday("2026-12-25", now), "2027-01-01", "a stale clock falls back to AoE");
  assert.equal(referenceToday("2027-01-05", now), "2027-01-01");
  assert.equal(referenceToday("junk", now), "2027-01-01");
});

test("a Jan 1 deadline is not overdue anywhere while Jan 1 is still running", () => {
  const row = { id: "d1", title: "RD", due_at: "2027-01-01T00:00:00.000Z", status: "open" };
  // 12:01 UTC on the due day: 21:01 in Seoul, 07:01 in New York.
  const noon = shapeDeadline(row, at("2027-01-01T12:01:00Z"));
  assert.equal(noon.daysUntil, 0);
  assert.equal(noon.dueAt, "2027-01-01", "sent back as the date typed, so no browser shifts it");
  assert.equal(noon.dueDate, "2027-01-01");
  // 23:00 on Jan 1 in New York (04:00 UTC Jan 2): still due today there.
  assert.equal(shapeDeadline(row, at("2027-01-02T04:00:00Z")).daysUntil, 0);
  assert.equal(shapeDeadline(row, at("2027-01-02T04:00:00Z"), "2027-01-01").daysUntil, 0);
  // The same instant is 13:00 on Jan 2 in Seoul: a Seoul client that says so sees it passed.
  assert.equal(shapeDeadline(row, at("2027-01-02T04:00:00Z"), "2027-01-02").daysUntil, -1);
  // Once Jan 1 has ended everywhere, the server counts it overdue on its own.
  assert.equal(shapeDeadline(row, at("2027-01-02T12:01:00Z")).daysUntil, -1);
  // The evening before in Seoul is one day out, not "in 0 days".
  assert.equal(shapeDeadline(row, at("2026-12-31T13:00:00Z"), "2026-12-31").daysUntil, 1);
});

test("a timed deadline is overdue as soon as its instant has passed", () => {
  const due = "2027-01-01T17:00:00.000Z";
  assert.equal(daysUntilDue(due, { nowMs: at("2027-01-01T16:00:00Z") }), 0);
  assert.equal(daysUntilDue(due, { nowMs: at("2027-01-01T18:00:00Z") }), -1);
  assert.equal(daysUntilDue(due, { nowMs: at("2026-12-30T18:00:00Z") }), 1);
  const shaped = shapeDeadline({ id: "d2", title: "Portal", due_at: due, status: "open" }, at("2027-01-01T16:00:00Z"));
  assert.equal(shaped.dueAt, due);
  assert.equal(shaped.dueDate, null);
});

test("a SQLite UTC time goes out as ISO-8601 with its zone", () => {
  assert.equal(sqliteUtcToIso("2026-11-03 05:00:00"), "2026-11-03T05:00:00Z");
  assert.equal(sqliteUtcToIso("2026-11-03T05:00:00.000Z"), "2026-11-03T05:00:00.000Z");
  assert.equal(sqliteUtcToIso(null), null);
  assert.equal(new Date(sqliteUtcToIso("2026-11-03 05:00:00")).toISOString(), "2026-11-03T05:00:00.000Z");
});
