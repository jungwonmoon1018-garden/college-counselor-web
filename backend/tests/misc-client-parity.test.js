// Client copies of server rules that nothing compared (debt-11): the
// narrative editor's limits and the onboarding consents the client grants
// and heals. They agreed by luck. A changed server limit would have left a
// form that lets a student type what the server refuses (or refuses what it
// accepts), and a newly required consent would have left every AI feature
// answering 403 with no consent prompt.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as server from "../activities/narrative-store.js";
import * as client from "../../frontend/src/profile/narrative-limits.js";
import { ONBOARDING_CONSENT_TYPES } from "../../frontend/src/session/server-session.js";
import { CONSENT_TYPES, getOnboardingConsentRequirements, validateRequiredConsents } from "../security/consent.js";

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend", "src");

test("the narrative editor's limits equal the server's", () => {
  assert.equal(client.NARRATIVE_MIN_CHARS, server.NARRATIVE_MIN_CHARS);
  assert.equal(client.NARRATIVE_MAX_CHARS, server.NARRATIVE_MAX_CHARS);
  assert.equal(client.NARRATIVE_MIN_WORDS, server.NARRATIVE_MIN_WORDS);
});

test("the editor's copy of the limits, wherever it lives, equals the shared module", () => {
  // NarrativeEditor.jsx held its own constants; until it imports
  // profile/narrative-limits.js, its literals must still match.
  const source = fs.readFileSync(path.join(FRONTEND, "components", "NarrativeEditor.jsx"), "utf8");
  if (/from\s+["']\.\.\/profile\/narrative-limits\.js["']/.test(source)) return;
  const literal = (name) => Number(source.match(new RegExp(`const ${name}\\s*=\\s*(\\d+)`))?.[1]);
  assert.equal(literal("MIN_CHARS"), client.NARRATIVE_MIN_CHARS);
  assert.equal(literal("MAX_CHARS"), client.NARRATIVE_MAX_CHARS);
  assert.equal(literal("MIN_WORDS"), client.NARRATIVE_MIN_WORDS);
});

test("the client and the server refuse the same narratives, for the same reason", () => {
  const words = (n, word = "robotics") => Array.from({ length: n }, () => word).join(" ");
  const cases = [
    "",
    "   ",
    words(5),
    words(19, "aaaaaaa"),           // long enough in characters, too few words
    words(20, "aaaa"),              // 99 characters
    words(20, "aaaaa"),             // 119 characters, 20 words
    `   ${words(20, "aaaaa")}   `,  // padding is trimmed on both sides
    words(166, "abcdefghi"),        // 1659 characters
    words(150, "abcdefghi"),        // 1499 characters
    "가".repeat(120),               // one long word
    `${"가나다라 ".repeat(25)}`,     // 25 Korean words
  ];
  for (const text of cases) {
    let serverCode = null;
    try { server.validateNarrativeText(String(text).trim()); } catch (err) { serverCode = err.code || "refused"; }
    assert.equal(client.narrativeTextProblem(text) === null, serverCode === null, `accept/refuse differs for ${JSON.stringify(text.slice(0, 40))}`);
    if (serverCode !== null && serverCode !== "refused") assert.equal(client.narrativeTextProblem(text), serverCode, JSON.stringify(text.slice(0, 40)));
  }
});

test("the onboarding consents the client grants are exactly what every AI operation requires", () => {
  // No consent active: every requirement is missing.
  const none = { getActiveConsent: { get: () => undefined } };
  for (const operation of ["ai_interaction", "strategy_council", "cross_border"]) {
    const result = validateRequiredConsents(none, 1, operation);
    assert.deepEqual([...result.missing].sort(), [...ONBOARDING_CONSENT_TYPES].sort(), operation);
  }
  assert.deepEqual(getOnboardingConsentRequirements().map((c) => c.consentType).sort(), [...ONBOARDING_CONSENT_TYPES].sort());
  for (const type of ONBOARDING_CONSENT_TYPES) assert.ok(Object.values(CONSENT_TYPES).includes(type), type);
});
