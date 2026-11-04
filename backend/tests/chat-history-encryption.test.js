import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  appendMessage,
  configureChatEncryption,
  createThread,
  getThreadWithMessages,
  listThreads,
  searchMessages,
} from "../chat/chat-history.js";

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
    searchMessages: db.prepare(`
      SELECT m.id, m.thread_id, m.role, m.content, m.created_at, t.title
      FROM chat_messages m JOIN chat_threads t ON m.thread_id = t.id
      WHERE t.student_id = ? AND t.archived_at IS NULL ORDER BY m.id DESC LIMIT ?
    `),
  };
  return { db, stmts };
}

test("chat titles, messages, and attachment names are encrypted at rest", () => {
  configureChatEncryption("ab".repeat(32));
  const { db, stmts } = fixture();
  const thread = createThread(stmts, "student-1", "Essay planning");
  appendMessage(stmts, "student-1", thread.id, "user", "My private essay idea", "draft.txt",
    "[Attached files]\nSECRET FILE BODY\n[End]\nMy private essay idea");

  const rawThread = db.prepare("SELECT title FROM chat_threads WHERE id = ?").get(thread.id);
  const rawMessage = db.prepare("SELECT content, attachment_name, model_content FROM chat_messages WHERE thread_id = ?").get(thread.id);
  assert.match(rawThread.title, /^enc:v1:/);
  assert.match(rawMessage.content, /^enc:v1:/);
  assert.match(rawMessage.attachment_name, /^enc:v1:/);
  assert.match(rawMessage.model_content, /^enc:v1:/);
  assert.doesNotMatch(JSON.stringify({ rawThread, rawMessage }), /private essay|draft\.txt|SECRET FILE BODY/i);

  assert.equal(listThreads(stmts, "student-1")[0].title, "Essay planning");
  const restored = getThreadWithMessages(stmts, "student-1", thread.id);
  assert.equal(restored.messages[0].content, "My private essay idea");
  assert.equal(restored.messages[0].attachment_name, "draft.txt");
  assert.match(restored.messages[0].model_content, /SECRET FILE BODY/);
  assert.equal(searchMessages(stmts, "student-1", "PRIVATE essay")[0].thread_id, thread.id);
  db.close();
});

test("chat encryption rejects malformed keys", () => {
  assert.throws(() => configureChatEncryption("not-a-key"), /32-byte hex/);
});

// ─── store-8: a long thread reopens at its newest messages ───────────────
test("a thread past 500 messages reopens at its newest 500, oldest first, and says earlier ones are hidden", async () => {
  configureChatEncryption("ab".repeat(32));
  const { initRAGTables, prepareRAGStatements } = await import("../storage/rag-engine.js");
  const db = new Database(":memory:");
  initRAGTables(db);
  const stmts = prepareRAGStatements(db);
  const long = createThread(stmts, "student-1", "Main thread");
  for (let i = 0; i < 520; i += 1) appendMessage(stmts, "student-1", long.id, i % 2 ? "assistant" : "user", `turn ${i}`);
  const reopened = getThreadWithMessages(stmts, "student-1", long.id);
  assert.equal(reopened.messages.length, 500);
  assert.equal(reopened.messages[0].content, "turn 20");
  assert.equal(reopened.messages.at(-1).content, "turn 519");
  assert.ok(reopened.messages.every((m, i, all) => i === 0 || all[i - 1].id < m.id));
  assert.equal(reopened.truncated, true);
  assert.equal(reopened.olderCount, 20);

  const short = createThread(stmts, "student-1", "Short");
  for (let i = 0; i < 10; i += 1) appendMessage(stmts, "student-1", short.id, "user", `short ${i}`);
  const small = getThreadWithMessages(stmts, "student-1", short.id);
  assert.equal(small.messages.length, 10);
  assert.equal(small.messages[0].content, "short 0");
  assert.equal(small.truncated, false);
  assert.equal(small.olderCount, 0);
  db.close();
});

// ─── store-2: the export opens what is sealed ───────────────────────────
test("collectStudentRows with openText returns every sealed column as plaintext; without it the rows stay sealed", async () => {
  configureChatEncryption("ab".repeat(32));
  const { initRAGTables, prepareRAGStatements } = await import("../storage/rag-engine.js");
  const { ensureChatGraphTables, prepareChatGraphStatements, indexTurn } = await import("../chat/chat-graph.js");
  const { harvestEvidence } = await import("../activities/ec-chat-evidence.js");
  const { collectStudentRows } = await import("../server/student-data.js");
  const { SEALED_COLUMNS, openText, sealText } = await import("../chat/chat-history.js");
  const db = new Database(":memory:");
  initRAGTables(db);
  ensureChatGraphTables(db);
  const stmts = prepareRAGStatements(db);
  const graph = prepareChatGraphStatements(db);
  const thread = createThread(stmts, "student-1", "New conversation");
  appendMessage(stmts, "student-1", thread.id, "user", "Should I apply ED to Columbia or Cornell?", "award.txt", "[Attached files]\nFILE BODY\n[End]\nShould I apply ED to Columbia or Cornell?");
  appendMessage(stmts, "student-1", thread.id, "assistant", "Early decision is binding, so apply ED only to the school you would attend if admitted. Compare the net price calculators for Columbia and Cornell before you commit.");
  const userMessage = db.prepare("SELECT id FROM chat_messages WHERE role = 'user'").get();
  indexTurn(graph, {
    studentId: "student-1", threadId: thread.id, messageId: userMessage.id,
    question: "Should I apply ED to Columbia or Cornell?",
    answer: "Early decision is binding, so apply ED only to the school you would attend if admitted. Compare the net price calculators for Columbia and Cornell before you commit.",
  });
  harvestEvidence(stmts.strength, "student-1", [{ name: "robotics-award.txt", text: "Robotics Club regional award certificate for the student" }], {
    activities: [{ name: "Robotics Club" }], messageText: "my Robotics Club award", seal: sealText, threadId: thread.id, messageId: userMessage.id,
  });

  const opened = collectStudentRows(db, "student-1", { open: openText });
  const sealedRaw = collectStudentRows(db, "student-1");
  const messages = db.prepare("SELECT * FROM chat_messages").all();
  const walk = (value, out = []) => {
    if (typeof value === "string") out.push(value);
    else if (value && typeof value === "object") for (const v of Object.values(value)) walk(v, out);
    return out;
  };
  assert.equal(walk(opened).some((s) => s.startsWith("enc:v1:")), false);
  assert.equal(opened.chat_threads[0].title, "Should I apply ED to Columbia or Cornell?");
  assert.match(opened.chat_graph_facts[0].question, /Columbia or Cornell/);
  assert.match(opened.ec_attachments[0].extracted_text, /regional award/);
  assert.match(sealedRaw.chat_threads[0].title, /^enc:v1:/);
  assert.match(sealedRaw.chat_graph_facts[0].advice, /^enc:v1:/);
  assert.match(messages[0].content, /^enc:v1:/);
  for (const table of Object.keys(SEALED_COLUMNS)) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), `${table} exists`);
  }
  db.close();
});
