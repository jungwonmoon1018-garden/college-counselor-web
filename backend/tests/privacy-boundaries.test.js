import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CONSENT_TYPES,
  grantConsent,
  validateRequiredConsents,
} from "../consent.js";
import {
  ensureStudentStorage,
  getStudentKnowledgeGraphPath,
  removeStudentStorage,
} from "../student-storage.js";

test("college value scoring has no legacy network extraction path", () => {
  const source = fs.readFileSync(new URL("../college-values.js", import.meta.url), "utf8");
  const forbidden = [
    "extractCollegeValues",
    "callLLM",
    "wantsWeb",
    "web_search",
    "web_fetch",
    "BYOK",
  ];
  for (const token of forbidden) {
    assert.equal(source.includes(token), false, `college-values.js must not contain ${token}`);
  }
});

test("consent rejects obsolete or caller-invented types and grantors", () => {
  const inserted = [];
  const stmts = {
    insertConsent: { run: (...args) => inserted.push(args) },
    getActiveConsent: {
      get: (_studentId, type) => type === CONSENT_TYPES.DATA_PROCESSING ? { id: "ok" } : null,
    },
  };
  grantConsent(stmts, "student-1", CONSENT_TYPES.DATA_PROCESSING);
  assert.equal(inserted.length, 1);
  assert.throws(() => grantConsent(stmts, "student-1", "obsolete_vault"), /Unsupported/);
  assert.throws(
    () => grantConsent(stmts, "student-1", CONSENT_TYPES.DATA_PROCESSING, { grantedBy: "admin" }),
    /Unsupported/,
  );
  const result = validateRequiredConsents(stmts, "student-1", "ai_interaction");
  assert.equal(result.allowed, false);
  assert.deepEqual(result.missing.sort(), ["ai_interaction", "cross_border_transfer"]);
});

test("student storage creates only the encrypted knowledge-graph area", async () => {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cc-storage-"));
  try {
    ensureStudentStorage("student-1", dataDir);
    assert.equal(fs.existsSync(getStudentKnowledgeGraphPath("student-1", dataDir)), true);
    await removeStudentStorage("student-1", dataDir);
    assert.equal(fs.existsSync(getStudentKnowledgeGraphPath("student-1", dataDir)), false);
  } finally {
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  }
});
