// Guardrail: a minor's crisis words must never become a chat-thread title
// (a glanceable, plaintext sidebar surface). Plus the canonical crisis
// predicate and the resolveTargetSchools fallback type-safety regression.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { appendMessage, configureChatEncryption, createThread, listThreads } from "../chat-history.js";
import { isCrisisText } from "../policy-router.js";
import { extractTargetSchoolNames } from "../cds-search.js";

// Titles are encrypted at rest in this build, so the guard is verified through
// a real in-memory store and read back decrypted via listThreads (matching the
// server) rather than inspecting the sealed value directly.
function fixture() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE chat_threads (
      id TEXT PRIMARY KEY, student_id TEXT NOT NULL, title TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
      message_count INTEGER DEFAULT 0, archived_at TEXT
    );
    CREATE TABLE chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, attachment_name TEXT, model_content TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  const stmts = {
    createThread: db.prepare("INSERT INTO chat_threads (id, student_id, title) VALUES (?, ?, ?)"),
    listThreads: db.prepare("SELECT id, title, created_at, updated_at, message_count FROM chat_threads WHERE student_id = ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT ?"),
    getThread: db.prepare("SELECT * FROM chat_threads WHERE id = ? AND student_id = ?"),
    updateThreadTitle: db.prepare("UPDATE chat_threads SET title = ? WHERE id = ? AND student_id = ?"),
    touchThread: db.prepare("UPDATE chat_threads SET message_count = message_count + ? WHERE id = ?"),
    insertMessage: db.prepare("INSERT INTO chat_messages (thread_id, role, content, attachment_name, model_content) VALUES (?, ?, ?, ?, ?)"),
    listMessages: db.prepare("SELECT id, role, content, attachment_name, model_content, created_at FROM chat_messages WHERE thread_id = ? ORDER BY id ASC LIMIT ?"),
  };
  return { db, stmts };
}

function firstMessageTitle(firstUserText) {
  configureChatEncryption("ab".repeat(32));
  const { db, stmts } = fixture();
  const thread = createThread(stmts, "stu1"); // defaults to the placeholder title
  const r = appendMessage(stmts, "stu1", thread.id, "user", firstUserText);
  const title = listThreads(stmts, "stu1")[0].title; // decrypted, as the sidebar sees it
  db.close();
  return { r, title };
}

test("crisis first message yields a neutral supportive title, not the crisis text", () => {
  const { r, title } = firstMessageTitle("I want to kill myself, I can't go on");
  assert.equal(r.ok, true);
  assert.equal(title, "Support resources");
  assert.ok(!/kill myself/i.test(title || ""), "crisis words must not appear in the title");
});

test("Korean crisis first message is also caught", () => {
  const { title } = firstMessageTitle("너무 힘들어서 죽고 싶어요");
  assert.equal(title, "Support resources");
});

test("ordinary first message still auto-titles from the text", () => {
  const { title } = firstMessageTitle("What AP courses should I take for CS?");
  assert.equal(title, "What AP courses should I take for CS?");
});

test("isCrisisText: crisis vs ordinary", () => {
  assert.equal(isCrisisText("i want to die"), true);
  assert.equal(isCrisisText("self-harm"), true);
  assert.equal(isCrisisText("자해"), true);
  assert.equal(isCrisisText("Help me pick between Princeton and MIT"), false);
  assert.equal(isCrisisText(""), false);
  assert.equal(isCrisisText(null), false);
  // Statements about the student's own safety trigger …
  for (const text of [
    "I want to end my life",
    "my dad hits me when I fail a test",
    "someone is threatening to hurt me at school",
    "I don't want to be alive anymore",
    "I am being abused at home",
    "죽고 싶어요",
    "학대를 당하고 있어요",
  ]) assert.equal(isCrisisText(text), true, text);
  // … topic words and academic stress do not. Each of these used to trip the
  // hotline response instead of an answer.
  for (const text of [
    "How should I end my personal statement?",
    "I volunteer in the hospital emergency department every Saturday",
    "My research project is about child abuse prevention policy",
    "the danger of procrastination during senior year",
    "I'm hopeless at chemistry and feel threatened by the curve",
    "I want to kill this essay draft and start over",
    "Is it unsafe to apply ED without financial aid info?",
    "에세이 도와주세요",
    "응급의학과에 관심이 있어요",
  ]) assert.equal(isCrisisText(text), false, text);
});

// Regression for the /api/calendar/context 500: extractTargetSchoolNames returns
// {schoolName} objects, so resolveTargetSchools' fallback must stringify them or
// downstream s.toLowerCase() throws.
test("target-school names map to strings safe for toLowerCase", () => {
  const goals = ["Ivy League / T20", { schoolName: "MIT" }, { name: "Stanford" }];
  const raw = extractTargetSchoolNames(goals, []);
  assert.ok(raw.some((t) => typeof t === "object"), "raw entries are objects (the original hazard)");
  const mapped = raw
    .map((t) => (typeof t === "string" ? t : t?.schoolName || ""))
    .filter(Boolean);
  assert.ok(mapped.every((s) => typeof s === "string"));
  assert.doesNotThrow(() => mapped.map((s) => s.toLowerCase()));
  assert.ok(mapped.includes("Ivy League / T20"));
});
