// Consent at the paid-call chokepoint (server/model-calls.js) and withdrawal
// by type (security/consent.js). Five paid paths, one of them running in the
// background after every sync, never checked consent; the check now sits
// where every paid call passes, before any budget is reserved.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { initPIIVault, preparePIIStatements } from "../storage/pii-vault.js";
import { CONSENT_TYPES, describeConsentTypes, getOnboardingConsentRequirements, grantConsent, hasActiveConsent, revokeConsentType, revokedConsentTypes, validateRequiredConsents } from "../security/consent.js";
import { registerConsentRoutes } from "../routes/consent.js";
import { initUsageBudget } from "../security/usage-budget.js";
import { bindModelCalls, buildStudentCallLLM, respondLLMError } from "../server/model-calls.js";

function vault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-consent-"));
  const piiVault = initPIIVault(dir, "ab".repeat(32), "test");
  return { piiVault, piiStmts: preparePIIStatements(piiVault), close: () => { piiVault.db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("a paid call without the AI consents is refused before any reservation", async () => {
  const { piiStmts, close } = vault();
  const db = new Database(":memory:");
  initUsageBudget(db);
  try {
    bindModelCalls({
      OPERATOR_LLM: { provider: "openrouter", apiKey: "sk-or-test" },
      MAX_TOKENS_LIMIT: 4096,
      piiStmts,
      db,
      authStore: { getStudentGrade: () => 11, studentExists: () => true },
      ragStmts: { insertUsage: { run: () => { throw new Error("no usage row expected"); } } },
    });
    grantConsent(piiStmts, "s1", "data_processing");
    const { callLLM } = buildStudentCallLLM("s1");
    await assert.rejects(callLLM({ messages: [{ role: "user", content: "hi" }] }), (err) => {
      assert.equal(err.code, "consent_required");
      assert.equal(err.status, 403);
      assert.deepEqual(err.missing.sort(), ["ai_interaction", "cross_border_transfer"]);
      return true;
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage_budget_reservations").get().n, 0);

    // The error answers as a consent problem, not a rejected credential.
    let sent;
    const res = { status(code) { sent = { code }; return this; }, json(body) { sent.body = body; return this; } };
    respondLLMError(res, Object.assign(new Error("x"), { status: 403, code: "consent_required", missing: ["ai_interaction"] }), "test");
    assert.equal(sent.code, 403);
    assert.equal(sent.body.code, "consent_required");
    assert.doesNotMatch(sent.body.error, /credential/i);
  } finally {
    db.close();
    close();
  }
});

test("withdrawing a type revokes every active row, is reported as revoked, and a later grant restores it", () => {
  const { piiStmts, close } = vault();
  try {
    for (const type of ["data_processing", "ai_interaction", "cross_border_transfer"]) grantConsent(piiStmts, "s1", type);
    grantConsent(piiStmts, "s1", "ai_interaction"); // a heal that granted twice
    assert.deepEqual(revokedConsentTypes(piiStmts, "s1"), []);

    const result = revokeConsentType(piiStmts, "s1", "ai_interaction");
    assert.equal(result.count, 2);
    assert.equal(hasActiveConsent(piiStmts, "s1", "ai_interaction").hasConsent, false);
    assert.equal(validateRequiredConsents(piiStmts, "s1", "ai_interaction").allowed, false);
    assert.deepEqual(revokedConsentTypes(piiStmts, "s1"), ["ai_interaction"]);
    // Never recorded is not the same as withdrawn.
    assert.equal(revokedConsentTypes(piiStmts, "s1").includes("fafsa_contributor"), false);
    assert.throws(() => revokeConsentType(piiStmts, "s1", "everything"), /Unsupported consent type/);

    grantConsent(piiStmts, "s1", "ai_interaction");
    assert.deepEqual(revokedConsentTypes(piiStmts, "s1"), []);
    assert.equal(validateRequiredConsents(piiStmts, "s1", "ai_interaction").allowed, true);
    // Another student is untouched.
    grantConsent(piiStmts, "s2", "ai_interaction");
    revokeConsentType(piiStmts, "s1", "ai_interaction");
    assert.equal(hasActiveConsent(piiStmts, "s2", "ai_interaction").hasConsent, true);
  } finally {
    close();
  }
});

// The consent panel (frontend components/ConsentNeeded.jsx) offers a type a
// route requires only when GET /api/consent/requirements describes it, and
// the route described only the onboarding three, the very types the panel
// never opens for: a 403 naming fafsa_contributor or any other type left the
// student at "can't describe a required permission" with no way forward.
// Every type an operation can require is now described, in both languages.
const HANGUL = /[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/;
const OPERATIONS = ["ai_interaction", "cross_border", "strategy_council", "fafsa_workflow", "session_persistence", "institutional_sharing", "chat_transcript_graphing", "anything_else"];

test("every consent an operation can require is described in English and Korean", () => {
  const none = { getActiveConsent: { get: () => undefined } };
  const required = new Set(OPERATIONS.flatMap((operation) => validateRequiredConsents(none, "s1", operation).missing));
  assert.deepEqual([...required].sort(), Object.values(CONSENT_TYPES).sort());
  for (const locale of ["en-US", "ko-KR"]) {
    const described = describeConsentTypes([...required], locale);
    assert.deepEqual(described.map((item) => item.consentType).sort(), [...required].sort(), locale);
    for (const item of described) {
      assert.ok(item.label && item.description, `${item.consentType} (${locale})`);
      if (locale.startsWith("ko")) {
        assert.match(item.label, HANGUL, `${item.consentType} label`);
        assert.match(item.description, HANGUL, `${item.consentType} description`);
      } else {
        assert.doesNotMatch(item.label + item.description, HANGUL, item.consentType);
      }
    }
  }
  // The onboarding three read the same words either way.
  for (const requirement of getOnboardingConsentRequirements(true, "en")) {
    const [same] = describeConsentTypes([requirement.consentType], "en");
    assert.equal(same.label, requirement.label);
    assert.equal(same.description, requirement.description);
  }
  // A type the server does not know is left out, never invented.
  assert.deepEqual(describeConsentTypes(["brand_new_consent", "fafsa_contributor", "fafsa_contributor"], "en").map((item) => item.consentType), ["fafsa_contributor"]);
  assert.deepEqual(describeConsentTypes(undefined, "en"), []);
});

test("GET /api/consent/requirements describes the types it is asked about, and the onboarding three otherwise", () => {
  const handlers = new Map();
  const app = { get: (route, ...chain) => handlers.set(`GET ${route}`, chain.at(-1)), post: (route, ...chain) => handlers.set(`POST ${route}`, chain.at(-1)) };
  registerConsentRoutes(app, { studentLimiter: () => {}, requireStudentAuth: () => {} });
  const handler = handlers.get("GET /api/consent/requirements");
  const ask = (query) => { let body; handler({ query }, { json: (value) => { body = value; } }); return body; };

  const asked = ask({ types: "fafsa_contributor,session_persistence,chat_transcript_graphing,institutional_sharing,brand_new_consent", locale: "ko" });
  assert.deepEqual(asked.map((item) => item.consentType), ["fafsa_contributor", "session_persistence", "chat_transcript_graphing", "institutional_sharing"]);
  for (const item of asked) assert.match(item.label, HANGUL, item.consentType);
  // Repeated as ?types=a&types=b, the query parser hands over a list.
  assert.deepEqual(ask({ types: ["fafsa_contributor", "institutional_sharing"], locale: "en-US" }).map((item) => item.label), ["FAFSA contributor consent", "School sharing consent"]);

  assert.deepEqual(ask({}).map((item) => item.consentType), ["data_processing", "ai_interaction", "cross_border_transfer"]);
  assert.deepEqual(ask({ locale: ["ko", "en"] }).map((item) => item.consentType), ["data_processing", "ai_interaction", "cross_border_transfer"]);
});
