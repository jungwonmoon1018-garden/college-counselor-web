// The three crisis layers must agree (CLAUDE.md). The server lexicon
// (PATTERNS.crisis in chat/policy-router.js) and the client's copy
// (frontend/src/chat/crisis-lexicon.js) were written separately and drifted:
// in 2026-11 24 of 30 probe phrases disagreed, the client had no Hangul, and
// the server missed "everyone would be better off without me". Nothing
// failed, because no test read both. This one imports the client module by
// file URL (it is a pure module with no imports) and holds the two to one
// contract: the same pattern sources, the same verdict on every case in the
// shared fixture, and the same resource list, reply text and footers.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CRISIS_PATTERNS,
  CRISIS_TOPIC_RE,
  TOPIC_TYPES,
  classifyTopic,
  isCrisisText,
  isCrisisTopicMention,
  normalizeForLexicon,
} from "../chat/policy-router.js";
import { buildCrisisResponse, crisisResourceFooter, renderCrisisText } from "../chat/rules-engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_LEXICON = path.resolve(__dirname, "..", "..", "frontend", "src", "chat", "crisis-lexicon.js");
const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "crisis-lexicon-cases.json"), "utf8"));
const client = await import(pathToFileURL(CLIENT_LEXICON).href);

test("the client lexicon is the server lexicon, pattern for pattern", () => {
  const source = (list) => list.map((pattern) => `/${pattern.source}/${pattern.flags}`);
  assert.deepEqual(source(client.CRISIS_PATTERNS), source(CRISIS_PATTERNS));
  assert.equal(`/${client.CRISIS_TOPIC_RE.source}/${client.CRISIS_TOPIC_RE.flags}`, `/${CRISIS_TOPIC_RE.source}/${CRISIS_TOPIC_RE.flags}`);
  for (const pattern of CRISIS_PATTERNS) assert.ok(!pattern.global && !pattern.sticky, "a stateful flag would make .test() skip matches");
});

test("both lexicons call every crisis case a crisis, and the router routes it to the crisis path", () => {
  assert.ok(CASES.crisis.length >= 50);
  for (const text of CASES.crisis) {
    assert.equal(isCrisisText(text), true, `server: ${text}`);
    assert.equal(client.isCrisisStatement(text), true, `client: ${text}`);
    assert.equal(classifyTopic(text).topicType, TOPIC_TYPES.CRISIS, `classifyTopic: ${text}`);
  }
});

test("topic mentions are answered with the footer on both sides, never blocked", () => {
  for (const text of CASES.topic) {
    assert.equal(isCrisisText(text), false, `server crisis: ${text}`);
    assert.equal(client.isCrisisStatement(text), false, `client crisis: ${text}`);
    assert.equal(isCrisisTopicMention(text), true, `server topic: ${text}`);
    assert.equal(client.isCrisisTopicMention(text), true, `client topic: ${text}`);
    assert.notEqual(classifyTopic(text).topicType, TOPIC_TYPES.CRISIS, `classifyTopic: ${text}`);
  }
});

test("ordinary counseling words, idioms and Korean hyperbole are neither crisis nor topic on either side", () => {
  for (const text of CASES.not_crisis) {
    assert.equal(isCrisisText(text), false, `server: ${text}`);
    assert.equal(client.isCrisisStatement(text), false, `client: ${text}`);
    assert.equal(isCrisisTopicMention(text), false, `server topic: ${text}`);
    assert.equal(client.isCrisisTopicMention(text), false, `client topic: ${text}`);
  }
});

test("both normalizers map typographic apostrophes and drop zero-width characters", () => {
  const raw = "I’m​ not  safe\nat home ‘really’ ＇";
  assert.equal(normalizeForLexicon(raw), "I'm not safe at home 'really' '");
  assert.equal(client.normalizeForLexicon(raw), normalizeForLexicon(raw));
  assert.equal(isCrisisText("I’m not safe at home"), true);
  assert.equal(isCrisisText("Iʼm being abused"), true);
});

test("the client renders the same crisis reply, resource list and footers as the server", () => {
  for (const locale of ["en-US", "ko"]) {
    assert.equal(client.crisisResponseText(locale), renderCrisisText(locale), locale);
    assert.deepEqual(client.crisisResources(locale), buildCrisisResponse(locale).crisis_response.resources, locale);
    assert.equal(client.crisisDisclaimer(locale), buildCrisisResponse(locale).crisis_response.disclaimer, locale);
    assert.equal(client.crisisResourceFooter(locale), crisisResourceFooter(locale), locale);
  }
});

// The client sends drafts back through /api/chat for the supervisor merge
// and the validator. A footer or reply that tripped the lexicon would turn
// an answered topic question into a crisis reply on its own.
test("the deterministic replies and footers never trip the crisis lexicon themselves", () => {
  for (const locale of ["en-US", "ko"]) {
    assert.equal(isCrisisText(renderCrisisText(locale)), false, `reply ${locale}`);
    assert.equal(isCrisisText(crisisResourceFooter(locale)), false, `footer ${locale}`);
    assert.equal(isCrisisText(client.supportFooter(locale)), false, `support footer ${locale}`);
  }
});
