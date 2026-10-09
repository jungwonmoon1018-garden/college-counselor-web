// The AP catalog: every exam under one stored name, read from the names
// students, transcripts and the College Board use (2026-10-09).
import test from "node:test";
import assert from "node:assert/strict";

import { AP_EXAMS, apExamAliases, apExamKey, apFirstExamYear, apNameWords, isGluedApName } from "../academics/ap-exams.js";
import { readFrontendSources } from "./helpers/frontend-source.mjs";

test("every name in the AP catalog means one exam", () => {
  const seen = new Map();
  for (const exam of AP_EXAMS) {
    for (const label of [exam.name, ...exam.aliases]) {
      const words = apNameWords(label);
      assert.ok(words, `${label} reads as no words`);
      assert.ok(!seen.has(words) || seen.get(words) === exam.name, `${label} also names ${seen.get(words)}`);
      seen.set(words, exam.name);
    }
  }
});

test("the names students, transcripts and the College Board write read as the stored name", () => {
  for (const [written, stored] of [
    ["AP United States History", "US History"],
    ["APUSH", "US History"],
    ["U.S. History", "US History"],
    ["AP Calc BC", "Calculus BC"],
    ["Calculus BC", "Calculus BC"],
    ["AP Physics C: Electricity & Magnetism", "Physics C: E&M"],
    ["AP Physics 1: Algebra-Based", "Physics 1"],
    ["AP 2-D Art and Design", "Studio Art: 2-D"],
    ["AP English Language and Composition", "English Language"],
    ["AP Lit", "English Literature"],
    ["World History: Modern", "World History"],
    ["Advanced Placement Biology", "Biology"],
    ["AP United States Government and Politics", "US Government"],
    ["APES", "Environmental Science"],
    ["APES (period 3)", "Environmental Science"],
    ["AP Cybersecurity", "Cybersecurity"],
  ]) assert.equal(apExamKey(written), stored, written);
  // A name that could mean two exams is left to the words of the names.
  for (const ambiguous of ["AP Calculus", "Physics C", "AP Spanish", "AP Computer Science", "Physics", ""]) {
    assert.equal(apExamKey(ambiguous), null, ambiguous);
  }
});

test("glued abbreviations read as AP, and the word \"apes\" does not", () => {
  assert.equal(isGluedApName("APUSH"), true);
  assert.equal(isGluedApName("apush 2nd period"), true);
  assert.equal(isGluedApName("APES"), true);
  assert.equal(isGluedApName("Apes and Primates"), false);
  assert.equal(isGluedApName("Apparel Design"), false);
  assert.equal(isGluedApName("AP Biology"), false);
});

test("the chat's profile check hears every name for an exam, and the newest exams carry their first year", () => {
  const aliases = apExamAliases("US History");
  for (const name of ["US History", "AP US History", "United States History", "APUSH"]) assert.ok(aliases.includes(name), name);
  assert.ok(apExamAliases("AP Calculus BC").includes("AP Calc BC"));
  // A name the catalog does not know is still heard as written.
  assert.deepEqual(apExamAliases("Korean Language"), ["Korean Language", "AP Korean Language"]);
  assert.equal(apFirstExamYear("AP Precalculus"), 2024);
  assert.equal(apFirstExamYear("Cybersecurity"), 2027);
  assert.equal(apFirstExamYear("Business with Personal Finance"), 2027);
  assert.equal(apFirstExamYear("Biology"), null);
});

// The app's picker stores these names, and its entry check knows the same
// first years; the two copies stay in step.
test("the app's AP picker and its first-exam years match the catalog", () => {
  const sources = Object.fromEntries(readFrontendSources());
  const list = JSON.parse(`[${sources["app-shared.js"].match(/export const AP_EXAM_LIST = \[([\s\S]*?)\];/)[1]}]`);
  assert.deepEqual([...list].sort(), AP_EXAMS.map((e) => e.name).sort());
  const block = sources["profile/ap-entry.js"].match(/AP_FIRST_EXAM_YEAR = Object\.freeze\(\{([\s\S]*?)\}\)/)[1];
  const years = Object.fromEntries([...block.matchAll(/"([^"]+)":\s*(\d{4})/g)].map((m) => [m[1], Number(m[2])]));
  assert.deepEqual(years, Object.fromEntries(AP_EXAMS.filter((e) => e.firstExamYear).map((e) => [e.name, e.firstExamYear])));
});
