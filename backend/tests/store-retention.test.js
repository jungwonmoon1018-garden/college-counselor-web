// Conversation retention takes the thread memory built from the purged
// messages with it, and recounts what the sidebar shows. It used to delete
// messages only: the facts kept resurfacing as THREAD MEMORY forever, and
// the thread kept claiming its old message count.
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initRAGTables, prepareRAGStatements } from "../storage/rag-engine.js";
import { appendMessage, configureChatEncryption, createThread, getThreadWithMessages, listThreads } from "../chat/chat-history.js";
import { buildThreadGraphContext, ensureChatGraphTables, indexTurn, prepareChatGraphStatements } from "../chat/chat-graph.js";
import { runRetentionCleanup } from "../storage/retention.js";

configureChatEncryption("cd".repeat(32));

const ADVICE = "Brown's early decision plan is binding, so apply ED only if Brown is your clear first choice and the net price works for your family. Strengthen the why-Brown essay with the open curriculum.";

function fixture() {
  const db = new Database(":memory:");
  initRAGTables(db);
  ensureChatGraphTables(db);
  db.exec(`
    CREATE TABLE audit_events (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, type TEXT NOT NULL, user_hint TEXT, details TEXT, ip_hash TEXT);
    CREATE TABLE notification_queue (id TEXT PRIMARY KEY, created_at TEXT);
  `);
  return { db, stmts: prepareRAGStatements(db), graph: prepareChatGraphStatements(db) };
}

// One question/answer pair indexed into the thread graph, as the append
// route does when the assistant turn is persisted.
function exchange({ stmts, graph }, threadId, question) {
  appendMessage(stmts, "student-1", threadId, "user", question);
  appendMessage(stmts, "student-1", threadId, "assistant", ADVICE);
  const user = stmts.listMessages.all(threadId, 1000).filter((m) => m.role === "user").at(-1);
  return indexTurn(graph, { studentId: "student-1", threadId, messageId: user.id, question, answer: ADVICE, knownSchoolNames: ["Brown University"] });
}

function backdate(db, threadId, ids, days) {
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`UPDATE chat_messages SET created_at = datetime('now', ?) WHERE thread_id = ? AND id IN (${placeholders})`).run(`-${days} days`, threadId, ...ids);
}

test("consumer retention removes the facts and edges of purged messages and recounts the thread", () => {
  const ctx = fixture();
  const { db, stmts, graph } = ctx;
  const thread = createThread(stmts, "student-1", "Brown ED");
  const old1 = exchange(ctx, thread.id, "Should I apply early decision to Brown?");
  const old2 = exchange(ctx, thread.id, "Is Brown early decision binding for financial aid?");
  const recent = exchange(ctx, thread.id, "What should my why-Brown essay focus on?");
  const ids = db.prepare("SELECT id FROM chat_messages WHERE thread_id = ? ORDER BY id").all(thread.id).map((r) => r.id);
  backdate(db, thread.id, ids.slice(0, 4), 40);
  assert.equal(listThreads(stmts, "student-1")[0].message_count, 6);

  const result = runRetentionCleanup(db, null, "consumer");
  assert.equal(result.results.conversation_logs.messagesDeleted, 4);
  assert.equal(result.results.conversation_logs.factsDeleted, 2);
  const factIds = db.prepare("SELECT id FROM chat_graph_facts").all().map((r) => r.id);
  assert.deepEqual(factIds, [recent.factId]);
  const edgeFacts = new Set(db.prepare("SELECT fact_id FROM chat_graph_edges").all().map((r) => r.fact_id));
  assert.equal(edgeFacts.has(old1.factId) || edgeFacts.has(old2.factId), false);
  assert.ok(edgeFacts.has(recent.factId));
  assert.equal(listThreads(stmts, "student-1")[0].message_count, 2);
  assert.equal(getThreadWithMessages(stmts, "student-1", thread.id).messages.length, 2);

  // A new thread's recall no longer brings back the purged turns.
  const memory = buildThreadGraphContext(graph, { studentId: "student-1", questionText: "Remind me about Brown early decision", knownSchoolNames: ["Brown University"] });
  assert.doesNotMatch(memory.text, /financial aid|Should I apply early decision/);
  db.close();
});

test("a thread that ages out entirely leaves no thread, fact or edge", () => {
  const ctx = fixture();
  const { db, stmts } = ctx;
  const thread = createThread(stmts, "student-1", "Old thread");
  exchange(ctx, thread.id, "Should I apply early decision to Brown?");
  db.prepare("UPDATE chat_messages SET created_at = datetime('now', '-45 days')").run();
  db.prepare("UPDATE chat_threads SET updated_at = datetime('now', '-45 days')").run();
  runRetentionCleanup(db, null, "consumer");
  for (const table of ["chat_threads", "chat_messages", "chat_graph_facts", "chat_graph_edges"]) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  }
  db.close();
});

test("institutional mode keeps conversations and their memory", () => {
  const ctx = fixture();
  const { db, stmts } = ctx;
  const thread = createThread(stmts, "student-1", "Kept");
  exchange(ctx, thread.id, "Should I apply early decision to Brown?");
  db.prepare("UPDATE chat_messages SET created_at = datetime('now', '-400 days')").run();
  runRetentionCleanup(db, null, "institutional");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get().n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_graph_facts").get().n, 1);
  db.close();
});
