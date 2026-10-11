// ap-entry.js — one check for an AP exam score wherever a student enters
// one: the survey's AP step and the sidebar editor.
//
// The survey took any year at all (its picker suggested 2020-2030 but
// nothing checked it, and it started at 2025 whatever the date) and let the
// same exam and year be added twice; the sidebar took any year from 2000 to
// 2100. A score exists only from the July after the exam, and only from the
// year an exam was first given. AP_FIRST_EXAM_YEAR mirrors firstExamYear in
// backend/academics/ap-exams.js; backend tests/ap-exams.test.js pins the two
// copies and the picker's list together.
import { AP_EXAM_LIST } from "../app-shared.js";

export const AP_FIRST_EXAM_YEAR = Object.freeze({
  "Precalculus": 2024,
  "Business with Personal Finance": 2027,
  "Cybersecurity": 2027,
});

// The latest year with AP scores out: scores are released in early July.
export function latestApScoreYear(now = new Date()) {
  return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
}

// The picker's exams that can have a score by now: AP Cybersecurity and AP
// Business with Personal Finance join after their first exams in May 2027.
export function apExamsWithScores(now = new Date()) {
  const latest = latestApScoreYear(now);
  return AP_EXAM_LIST.filter((name) => (AP_FIRST_EXAM_YEAR[name] ?? 0) <= latest);
}

const bareName = (value) => String(value || "").trim().replace(/^AP\s+/i, "");
const sameExamName = (a, b) => bareName(a).toLowerCase() === bareName(b).toLowerCase();

// { ok: true, entry: { exam, score, year } } or { ok: false, error }.
// `others` are the entries already on the list (not the one being edited);
// the same exam in another year is a retake and is kept.
export function validateApEntry({ exam, score, year } = {}, { others = [], now = new Date() } = {}) {
  const name = String(exam || "").trim().slice(0, 80);
  if (!name) return { ok: false, error: "Pick the AP exam." };
  const value = Number(score);
  if (!Number.isInteger(value) || value < 1 || value > 5) return { ok: false, error: "AP scores run 1-5." };
  const latest = latestApScoreYear(now);
  const first = Math.max(2000, AP_FIRST_EXAM_YEAR[bareName(name)] ?? 2000);
  if (first > latest) return { ok: false, error: `AP ${bareName(name)} is first given in May ${first}, with scores that July.` };
  const taken = String(year ?? "").trim() === "" ? NaN : Number(year);
  if (!Number.isInteger(taken) || taken < first || taken > latest) {
    return { ok: false, error: `Enter the year you took the exam, ${first}–${latest}. Scores come out in July.` };
  }
  if (others.some((o) => sameExamName(o?.exam ?? o?.subject ?? o?.name, name) && Number(o?.year) === taken)) {
    return { ok: false, error: `AP ${bareName(name)} (${taken}) is already on your list.` };
  }
  return { ok: true, entry: { exam: name, score: value, year: taken } };
}
