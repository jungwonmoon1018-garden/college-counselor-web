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
import { grantConsent, hasActiveConsent, revokeConsentType, revokedConsentTypes, validateRequiredConsents } from "../security/consent.js";
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
