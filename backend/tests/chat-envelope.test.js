// The client's envelope around a chat question, stripped for classification
// whether or not its sentinel brackets survived the client's sanitizer.
import test from "node:test";
import assert from "node:assert/strict";

import { hasAttachmentPreface, stripClientEnvelope } from "../chat/chat-envelope.js";

const PREFACE = [
  "[Attached files — read carefully and reference in your answer; 1 text file(s)]",
  "", "═══ FILE: usaco-gold.txt (0 KB) ═══", "```", "USACO certificate. FAFSA opens October 1.", "```", "[End of attached files]", "",
].join("\n");
const APPENDIX = "\n\n[Context appendix — reference data for the assistant; not part of the student's question]\nFAFSA opens Oct 1. Early Decision deadlines Nov 1.\n[End context appendix]";

test("the question alone is classified: file preface and context appendix are stripped, with or without brackets", () => {
  const withBrackets = `${PREFACE}What does this certificate say?${APPENDIX}`;
  assert.equal(stripClientEnvelope(withBrackets), "What does this certificate say?");
  // The client's sanitizer drops every "[" and "]" before sending.
  const sanitized = withBrackets.replace(/[[\]]/g, "");
  assert.equal(stripClientEnvelope(sanitized), "What does this certificate say?");
  assert.ok(!/FAFSA/.test(stripClientEnvelope(sanitized)));
});

test("a turn that is only a file keeps its text, and the priming sentence of a single upload is dropped", () => {
  const onlyFile = PREFACE.replace(/[[\]]/g, "");
  assert.equal(stripClientEnvelope(onlyFile), onlyFile);
  const primed = 'The student uploaded "transcript.pdf". If it is a school records document, read it and answer their question about it substantively. Summarize my transcript';
  assert.equal(stripClientEnvelope(primed), "Summarize my transcript");
  assert.equal(stripClientEnvelope(""), "");
});

test("an attachment turn is recognized with or without the sentinel brackets", () => {
  assert.equal(hasAttachmentPreface(`${PREFACE}Read this`), true);
  assert.equal(hasAttachmentPreface(PREFACE.replace(/[[\]]/g, "") + "Read this"), true);
  assert.equal(hasAttachmentPreface('The student uploaded "x.pdf". Read it'), true);
  assert.equal(hasAttachmentPreface("Suggest ECs for me"), false);
});
