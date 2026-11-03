// The deadline form says up front what the server holds a deadline to (a
// 200-character name, a date from 2000-01-01 through six years out, five
// known categories). The two copies agreed by luck: nothing compared them,
// so a raised server cap would have been cut short by the form's maxLength.
import test from "node:test";
import assert from "node:assert/strict";
import * as server from "../shared/deadline-rules.js";
import * as client from "../../frontend/src/profile/deadline-limits.js";
import * as serverDates from "../shared/calendar-date.js";
import * as clientDates from "../../frontend/src/profile/dates.js";

test("the tracker's form limits equal the server's", () => {
  assert.equal(client.DEADLINE_TITLE_MAX, server.DEADLINE_TITLE_MAX);
  assert.equal(client.DEADLINE_EARLIEST_DATE, new Date(server.DEADLINE_EARLIEST_MS).toISOString().slice(0, 10));
  assert.equal(client.DEADLINE_YEARS_AHEAD, server.DEADLINE_YEARS_AHEAD);
  assert.deepEqual(client.DEADLINE_CATEGORIES, server.DEADLINE_CATEGORIES);
});

test("the latest date the form offers is the last one the server accepts", () => {
  for (const iso of ["2026-11-03T15:00:00Z", "2028-02-29T23:59:00Z", "2030-12-31T00:00:00Z"]) {
    const now = Date.parse(iso);
    const latest = client.latestDeadlineDate(new Date(now));
    assert.equal(server.deadlineDateOutside(Date.parse(`${latest}T00:00:00Z`), now), null, iso);
    const after = Date.parse(`${latest}T00:00:00Z`) + 86_400_000;
    assert.notEqual(server.deadlineDateOutside(after, now), null, iso);
  }
  assert.equal(server.deadlineDateOutside(Date.parse(`${client.DEADLINE_EARLIEST_DATE}T00:00:00Z`)), null);
});

test("both sides read the same due values as calendar dates", () => {
  for (const value of ["2027-01-01", "2027-01-01T00:00:00.000Z", "2027-01-01T00:00:00Z", "2027-01-01T17:00:00.000Z", "2027-02-30", "", null, "junk"]) {
    assert.equal(clientDates.calendarDateOf(value), serverDates.calendarDateOf(value), String(value));
  }
});
