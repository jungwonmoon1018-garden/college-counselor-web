import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  MONTHLY_CAPS_USD,
  initUsageBudget,
  estimateRequestCost,
  reserveBudget,
  reconcileBudget,
  releaseBudget,
  getBudgetStatus,
} from "../security/usage-budget.js";

const pricing = () => ({ input: 1, output: 2 });

function ledger() {
  const db = new Database(":memory:");
  initUsageBudget(db);
  return db;
}

describe("usage budget pricing", () => {
  it("fails closed when model pricing is unknown", () => {
    const result = estimateRequestCost({
      model: "unknown/model",
      maxInputTokens: 1000,
      maxOutputTokens: 1000,
      pricingLookup: () => null,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "unknown_model_pricing");
  });

  it("uses fixed grade caps", () => {
    assert.equal(MONTHLY_CAPS_USD[9], 10);
    assert.equal(MONTHLY_CAPS_USD[11], 10);
    assert.equal(MONTHLY_CAPS_USD[12], 15);
  });
});

describe("usage reservations", () => {
  it("reserves worst-case cost and rejects a request beyond the cap", () => {
    const db = ledger();
    for (let index = 0; index < 3; index++) {
      const result = reserveBudget(db, {
        studentId: "student",
        grade: 9,
        requestId: "request-" + index,
        model: "priced/model",
        maxInputTokens: 1_000_000,
        maxOutputTokens: 1_000_000,
        pricingLookup: pricing,
      });
      assert.equal(result.allowed, true);
      assert.equal(result.reservedUsd, 3);
    }
    const denied = reserveBudget(db, {
      studentId: "student",
      grade: 9,
      requestId: "request-over",
      model: "priced/model",
      maxInputTokens: 1_000_000,
      maxOutputTokens: 1_000_000,
      pricingLookup: pricing,
    });
    assert.equal(denied.allowed, false);
    assert.equal(denied.code, "monthly_cap_exceeded");
    db.close();
  });

  it("reconciles actual tokens and releases unused reservation", () => {
    const db = ledger();
    const reservation = reserveBudget(db, {
      studentId: "student",
      grade: 12,
      requestId: "request",
      model: "priced/model",
      maxInputTokens: 1_000_000,
      maxOutputTokens: 1_000_000,
      pricingLookup: pricing,
    });
    const result = reconcileBudget(db, {
      reservationId: reservation.reservationId,
      inputTokens: 100_000,
      outputTokens: 100_000,
    });
    assert.equal(result.ok, true);
    assert.equal(result.actualUsd, 0.3);
    assert.equal(result.releasedUsd, 2.7);
    assert.equal(getBudgetStatus(db, { studentId: "student", grade: 12 }).committedUsd, 0.3);
    db.close();
  });

  it("is idempotent by request ID and can release failed calls", () => {
    const db = ledger();
    const input = {
      studentId: "student",
      grade: 10,
      requestId: "same-request",
      model: "priced/model",
      maxInputTokens: 1000,
      maxOutputTokens: 1000,
      pricingLookup: pricing,
    };
    const first = reserveBudget(db, input);
    const second = reserveBudget(db, input);
    assert.equal(second.idempotent, true);
    assert.equal(second.reservationId, first.reservationId);
    assert.equal(releaseBudget(db, { reservationId: first.reservationId }).ok, true);
    assert.equal(getBudgetStatus(db, { studentId: "student", grade: 10 }).committedUsd, 0);
    db.close();
  });

  it("resets on the first day of each local calendar month", () => {
    const db = ledger();
    reserveBudget(db, {
      studentId: "student",
      grade: 9,
      requestId: "january",
      model: "priced/model",
      maxInputTokens: 3_000_000,
      maxOutputTokens: 3_000_000,
      pricingLookup: pricing,
      now: new Date(2026, 0, 31, 23, 59),
    });
    assert.equal(
      getBudgetStatus(db, {
        studentId: "student",
        grade: 9,
        now: new Date(2026, 1, 1, 0, 1),
      }).committedUsd,
      0,
    );
    db.close();
  });

  it("requires a grade before any paid reservation", () => {
    const db = ledger();
    const result = reserveBudget(db, {
      studentId: "student",
      requestId: "no-grade",
      model: "priced/model",
      maxInputTokens: 1000,
      maxOutputTokens: 1000,
      pricingLookup: pricing,
    });
    assert.equal(result.allowed, false);
    assert.equal(result.code, "grade_required");
    db.close();
  });
});

// A reservation cut off by a restart stayed 'reserved' and counted at its
// full estimate until the month ended. The boot sweep releases everything
// from before the process started; the hourly one only rows older than any
// live call can hold.
describe("stale reservations", () => {
  const reserve = (db, requestId, now = new Date()) => reserveBudget(db, {
    studentId: "student",
    grade: 11,
    requestId,
    model: "priced/model",
    maxInputTokens: 100_000,
    maxOutputTokens: 4_096,
    pricingLookup: pricing,
    now,
  });

  it("the boot sweep releases a reservation the last process left open", async () => {
    const { releaseStaleReservations } = await import("../security/usage-budget.js");
    const db = ledger();
    reserve(db, "cut-off-by-deploy");
    assert.ok(getBudgetStatus(db, { studentId: "student", grade: 11 }).committedUsd > 0);
    const swept = releaseStaleReservations(db, { createdBefore: new Date(Date.now() + 1) });
    assert.equal(swept.released, 1);
    assert.equal(getBudgetStatus(db, { studentId: "student", grade: 11 }).committedUsd, 0);
    assert.equal(db.prepare("SELECT status FROM usage_budget_reservations").get().status, "released");
    db.close();
  });

  it("the periodic sweep keeps a young reservation and never touches a reconciled one", async () => {
    const { releaseStaleReservations } = await import("../security/usage-budget.js");
    const { staleReservationAgeMs } = await import("../scouts/batch-jobs.js");
    const db = ledger();
    const ageMs = staleReservationAgeMs({});
    assert.ok(ageMs >= 30 * 60 * 1000);
    assert.equal(staleReservationAgeMs({ LLM_CALL_TIMEOUT_MS: "600000" }), 3_600_000);
    const old = new Date(Date.now() - ageMs - 60_000);
    reserve(db, "orphaned", old);
    const done = reserve(db, "finished", old);
    reconcileBudget(db, { reservationId: done.reservationId, inputTokens: 10, outputTokens: 10 });
    reserve(db, "in-flight");
    const swept = releaseStaleReservations(db, { createdBefore: new Date(Date.now() - ageMs) });
    assert.equal(swept.released, 1);
    const statuses = Object.fromEntries(db.prepare("SELECT request_id, status FROM usage_budget_reservations").all().map((r) => [r.request_id, r.status]));
    assert.deepEqual(statuses, { orphaned: "released", finished: "reconciled", "in-flight": "reserved" });
    db.close();
  });
});

describe("the monthly cap follows the grade read from the class", () => {
  it("a junior registered in October 2026 has the senior cap from Aug 1 2027", async () => {
    const { initAuthStore } = await import("../security/security-auth.js");
    const { monthlyCapForGrade } = await import("../security/usage-budget.js");
    const db = new Database(":memory:");
    const auth = initAuthStore(db, { sessionTtlMs: 60_000 });
    initUsageBudget(db);
    auth.createStudentCredential("s1", "email-hash", "correct horse battery staple", { grade: 11 });
    db.prepare("UPDATE student_credentials SET class_of = 2028 WHERE student_id = 's1'").run();
    assert.equal(monthlyCapForGrade(auth.getStudentGrade("s1", new Date("2027-07-15T00:00:00Z"))), 10);
    const senior = auth.getStudentGrade("s1", new Date("2027-09-01T00:00:00Z"));
    assert.equal(senior, 12);
    assert.equal(getBudgetStatus(db, { studentId: "s1", grade: senior }).capUsd, 15);
    db.close();
  });
});
