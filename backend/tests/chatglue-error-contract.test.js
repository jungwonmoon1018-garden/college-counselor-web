// The error contract between /api/chat and /api/council/convene and the
// client that words their failures. Each side was fixed on its own: the
// server gave every failure a stable code (shared/model-errors.js), and the
// client gave codes English and Korean copy (frontend/src/chat/chat-errors.js
// and profile/strategy-council.js). Nothing held them together, so a code the
// server started sending (request_id_released, request_cancelled,
// internal_error) fell through to "Something went wrong", and the Council's
// outage copy keyed on a field the route never set.
//
// This file collects every code literal from the modules that build those
// two routes' failure bodies, fails on one the table below does not know, and
// checks that the client has copy of its own for each, in both languages.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { chatErrorCopyKey, chatErrorFromResponse, chatErrorRetryable, formatChatError } from "../../frontend/src/chat/chat-errors.js";
import { councilErrorMessage } from "../../frontend/src/profile/strategy-council.js";
import { modelErrorResponse } from "../shared/model-errors.js";
import { initUsageBudget, releaseBudget, reserveBudget } from "../security/usage-budget.js";
import { readFrontendSource } from "./helpers/frontend-source.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const between = (text, start, end) => {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `cannot find ${start} .. ${end}`);
  return text.slice(from, to);
};

// Where the two routes' failure bodies come from. Whole modules where every
// code is one of these routes'; the one function of a module whose other
// codes belong to other routes.
const SOURCES = [
  ["shared/model-errors.js", (t) => t],
  ["security/usage-budget.js", (t) => t],
  ["routes/chat.js", (t) => t],
  ["routes/server-routes-pillars.js", (t) => t],
  ["server/model-calls.js", (t) => t],
  ["server/pillars.js", (t) => t],
  ["council/index.js", (t) => t],
  ["server/auth.js", (t) => between(t, "export function requireStudentAuth", "export function requireSelf")],
  ["security/security-hardening.js", (t) => between(t, "export function rateLimitedHandler", "export function createChatRateLimiters")],
];

// Every string literal assigned to `code` or `councilCode` (`code: "x"`,
// `error.code = a ? "x" : "y"`, `code: c || "x"`), comparisons and comment
// lines left out.
function codeLiterals(source) {
  const text = source.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
  const found = new Set();
  for (const match of text.matchAll(/\b(?:code|councilCode)\s*(?::|=(?!=))\s*([^,;}\n]+)/g)) {
    const expression = match[1].replace(/[!=]==\s*["'][^"']*["']/g, "");
    for (const literal of expression.matchAll(/["']([A-Za-z_]+)["']/g)) found.add(literal[1]);
  }
  return found;
}

// What /api/chat can answer, with the status each code travels under.
// A code whose status depends on its source (request_failed is any 4xx
// without a code) is listed under the one the client sees most.
const CHAT_CODES = {
  session_invalid: 401,
  invalid_request: 400,
  too_many_messages: 400,
  model_not_allowed: 400,
  request_id_required: 400,
  request_failed: 400,
  input_blocked: 400,
  consent_required: 403,
  monthly_cap_exceeded: 402,
  budget_exceeded: 402,
  grade_required: 402,
  unknown_model_pricing: 402,
  identity_required: 402,
  invalid_token_limit: 402,
  request_id_conflict: 402,
  request_id_released: 409,
  duplicate_request_id: 409,
  rate_limited: 429,
  request_cancelled: 499,
  internal_error: 500,
  server_error: 500,
  provider_auth_failed: 502,
  provider_error: 502,
  empty_model_reply: 502,
  openrouter_not_configured: 503,
  installation_setup_required: 503,
  provider_timeout: 504,
};

// What /api/council/convene can answer. Its budget codes come from
// server/pillars.js's reservations; COUNCIL_DUPLICATE_REQUEST and
// BUDGET_EXCEEDED have statuses mapped in the route though nothing throws
// them today.
const COUNCIL_CODES = {
  session_invalid: 401,
  COUNCIL_QUESTION_INVALID: 400,
  COUNCIL_QUESTION_MISSING: 400,
  COUNCIL_QUESTION_TOO_LONG: 400,
  COUNCIL_EXPLICIT_ACTION_REQUIRED: 400,
  COUNCIL_DECISION_TYPE_INVALID: 400,
  COUNCIL_INPUT_BLOCKED: 400,
  request_failed: 400,
  consent_required: 403,
  monthly_cap_exceeded: 402,
  grade_required: 402,
  unknown_model_pricing: 402,
  identity_required: 402,
  invalid_token_limit: 402,
  request_id_conflict: 402,
  council_budget_denied: 402,
  COUNCIL_BUDGET_DENIED: 402,
  BUDGET_EXCEEDED: 402,
  COUNCIL_DUPLICATE_REQUEST: 409,
  rate_limited: 429,
  request_cancelled: 499,
  council_budget_conflict: 500,
  internal_error: 500,
  provider_auth_failed: 502,
  provider_error: 502,
  openrouter_not_configured: 503,
  installation_setup_required: 503,
  COUNCIL_BUDGET_UNAVAILABLE: 503,
  provider_timeout: 504,
};

// Codes that carry the counselor's own reply ({ blocked: true }): the
// client shows that reply, not error copy.
const BLOCKED = new Set(["input_blocked", "COUNCIL_INPUT_BLOCKED"]);

// Literals the scan finds that never reach the browser as a code.
const NOT_SENT = {
  aborted: "the chat route's marker for a closed request; modelErrorResponse turns it into request_cancelled, for a client already gone",
  http_error: "an adapter code on a Council provider failure; modelErrorResponse sends provider_error",
  COUNCIL_PROVIDER_UNAVAILABLE: "the councilCode beside a provider code, not a code of its own (checked below)",
  reservation_required: "a reconcile or release result returned to the caller, never thrown",
  reservation_not_found: "a reconcile or release result returned to the caller, never thrown",
  reservation_released: "a reconcile or release result returned to the caller, never thrown",
  student_required: "getBudgetStatus without a student, for the budget poll, not these routes",
  route_moved: "the /api/strategy-council tombstone, not /api/council/convene",
};

// A code whose only honest copy is the generic line for its status.
const GENERIC_BY_DESIGN = {
  request_failed: "a 4xx that came without a code: its status is all there is",
  internal_error: "a fault on our side with nothing more to tell: the generic try-again copy (chatErrorCopyKey names it)",
  server_error: "a 5xx that came without a code: the generic try-again copy (chatErrorCopyKey names it)",
};

const HANGUL = /[가-힣]/;

test("every code the two routes can send is in the contract", () => {
  const found = new Set();
  for (const [rel, slice] of SOURCES) for (const code of codeLiterals(slice(read(rel)))) found.add(code);
  // The scan itself works: these come from four different modules.
  for (const anchor of ["rate_limited", "session_invalid", "request_id_released", "provider_auth_failed", "COUNCIL_QUESTION_MISSING"]) {
    assert.ok(found.has(anchor), `the scan missed ${anchor}`);
  }
  const unknown = [...found].filter((code) => !(code in CHAT_CODES) && !(code in COUNCIL_CODES) && !(code in NOT_SENT));
  assert.deepEqual(unknown, [], `codes with no decision in the client contract: ${unknown.join(", ")}`);
});

test("the server's translation sends each code under the status in the contract", () => {
  const cases = [
    [{ status: 401, code: "auth_rejected", provider: "openrouter" }, "provider_auth_failed"],
    [{ status: 500, code: "http_error", provider: "openrouter" }, "provider_error"],
    [{ status: 504, code: "provider_timeout", provider: "openrouter" }, "provider_timeout"],
    [{ status: 499, code: "aborted", provider: "openrouter" }, "request_cancelled"],
    [{ code: "missing_api_key", provider: "openrouter" }, "openrouter_not_configured"],
    [{ status: 402, code: "monthly_cap_exceeded" }, "monthly_cap_exceeded"],
    [{ status: 409, code: "request_id_released" }, "request_id_released"],
    [{ status: 409, code: "duplicate_request_id" }, "duplicate_request_id"],
    [{ status: 502, code: "empty_model_reply" }, "empty_model_reply"],
    [{ status: 403, code: "consent_required", missing: ["ai_interaction"] }, "consent_required"],
    [{}, "internal_error"],
  ];
  for (const [error, code] of cases) {
    const { status, body } = modelErrorResponse(Object.assign(new Error("x"), error));
    assert.equal(body.code, code, JSON.stringify(error));
    assert.equal(status, CHAT_CODES[code], code);
  }
});

test("every /api/chat code has copy of its own in English and Korean", () => {
  for (const [code, status] of Object.entries(CHAT_CODES)) {
    const body = { error: "Server English that a student should never see as the copy.", code, ...(BLOCKED.has(code) ? { blocked: true } : {}) };
    const err = chatErrorFromResponse(status, body);
    if (BLOCKED.has(code)) {
      // orchestrate() and send() show the block's own reply (err.message).
      assert.equal(err.blocked, true, code);
      continue;
    }
    const key = chatErrorCopyKey(err);
    if (!(code in GENERIC_BY_DESIGN)) assert.doesNotMatch(key, /^generic_/, `${code} falls through to the generic copy`);
    const en = formatChatError(err, "en-US");
    const ko = formatChatError(err, "ko");
    assert.ok(en && !HANGUL.test(en), `${code}: English copy ${en}`);
    assert.ok(HANGUL.test(ko), `${code}: Korean copy ${ko}`);
    assert.notEqual(en, body.error, code);
  }
});

test("every Council code has copy in English and Korean", () => {
  for (const [code, status] of Object.entries(COUNCIL_CODES)) {
    const body = {
      error: "Server English that a student should never see as the copy.",
      code,
      ...(BLOCKED.has(code) ? { blocked: true } : {}),
      // The route's provider-failure shape (server-routes-pillars.js).
      ...(/^provider_/.test(code) ? { councilCode: "COUNCIL_PROVIDER_UNAVAILABLE", stage: "Strategist" } : {}),
    };
    const en = councilErrorMessage(status, body, "en-US");
    const ko = councilErrorMessage(status, body, "ko");
    if (BLOCKED.has(code)) {
      assert.equal(en, body.error, "a blocked question shows the screen's reply");
      continue;
    }
    assert.ok(en && !HANGUL.test(en), `${code}: English copy ${en}`);
    assert.notEqual(en, body.error, `${code} shows the server's English`);
    assert.ok(HANGUL.test(ko), `${code}: Korean copy ${ko}`);
  }
  // The outage copy keys on councilCode, which the route sets beside the
  // shared code; a refused key keeps the chat's "still signed in" copy.
  assert.match(councilErrorMessage(502, { code: "provider_error", councilCode: "COUNCIL_PROVIDER_UNAVAILABLE" }, "en-US"), /isn't about your profile/);
  assert.match(councilErrorMessage(502, { code: "provider_auth_failed", councilCode: "COUNCIL_PROVIDER_UNAVAILABLE" }, "en-US"), /still signed in/);
});

// From the ledger's refusal to the student's words, through the same
// translation the route uses. `now` is fixed, and the reset is midnight in
// the process's own calendar, which the copy reads back in the same one.
test("a used-up budget's reset date and a released id reach the student", () => {
  const db = new Database(":memory:");
  try {
    initUsageBudget(db);
    const now = new Date(2026, 10, 15, 12, 0, 0);
    const pricey = () => ({ input: 1_000_000, output: 1_000_000 });
    const denied = reserveBudget(db, { studentId: "s1", grade: 11, requestId: "r1", model: "test/model", maxInputTokens: 1000, maxOutputTokens: 1000, now, pricingLookup: pricey });
    assert.equal(denied.code, "monthly_cap_exceeded");
    // reserveStudentModelCall's error for a refusal (server/model-calls.js).
    const capped = modelErrorResponse(Object.assign(new Error(denied.reason), { status: 402, code: denied.code, budget: denied }));
    assert.equal(capped.body.budget.resetsAt, denied.resetsAt);
    const capErr = chatErrorFromResponse(capped.status, capped.body);
    assert.match(formatChatError(capErr, "en-US"), /resets on December 1\b/);
    assert.match(formatChatError(capErr, "ko"), /12월 1일에/);
    assert.equal(chatErrorRetryable(capErr), false);

    const cheap = () => ({ input: 0.01, output: 0.01 });
    const first = reserveBudget(db, { studentId: "s1", grade: 11, requestId: "r2", model: "test/model", maxInputTokens: 1000, maxOutputTokens: 1000, now, pricingLookup: cheap });
    assert.equal(first.allowed, true);
    releaseBudget(db, { reservationId: first.reservationId, now });
    const again = reserveBudget(db, { studentId: "s1", grade: 11, requestId: "r2", model: "test/model", maxInputTokens: 1000, maxOutputTokens: 1000, now, pricingLookup: cheap });
    assert.equal(again.code, "request_id_released");
    const released = modelErrorResponse(Object.assign(new Error("released"), { status: 409, code: again.code }));
    const releasedErr = chatErrorFromResponse(released.status, released.body);
    assert.match(formatChatError(releasedErr, "en-US"), /goes as a new request/);
    assert.equal(chatErrorRetryable(releasedErr), true);
  } finally {
    db.close();
  }
});

// The resend the copy promises is a new request: requestChat puts a fresh
// id after the caller's payload, so no id the ledger released is sent again.
test("the client sends a fresh request_id on every post", () => {
  assert.match(readFrontendSource(), /JSON\.stringify\(\{ \.\.\.payload, request_id: newChatRequestId\(\) \}\)/);
});
