import crypto from "node:crypto";
import { decrypt, encrypt } from "../storage/pii-vault.js";
import { isCrisisText } from "./policy-router.js";

const MAX_THREADS_PER_LIST = 50;
const MAX_MESSAGES_PER_THREAD = 500;
const MAX_MESSAGE_CHARS = 50_000;
const MAX_MODEL_CONTENT_CHARS = 120_000; // file prefaces can dwarf the display copy
const MAX_SEARCH_SCAN = 5_000;
const MAX_SEARCH_RESULTS = 30;
const DEFAULT_TITLE = "New conversation";
export const CRISIS_SAFE_TITLE = "Support resources";
const ENCRYPTED_PREFIX = "enc:v1:";

let encryptionKey = null;

export function configureChatEncryption(keyHex) {
  if (!/^[0-9a-f]{64}$/i.test(String(keyHex || ""))) {
    throw new Error("Chat history requires a 32-byte hex encryption key.");
  }
  encryptionKey = keyHex;
}

function requireEncryptionKey() {
  if (!encryptionKey) throw new Error("Chat history encryption is not configured.");
  return encryptionKey;
}

function seal(value) {
  if (value == null) return null;
  return ENCRYPTED_PREFIX + encrypt(String(value), requireEncryptionKey());
}

function open(value, fallback = "") {
  if (value == null) return value;
  const stored = String(value);
  if (!stored.startsWith(ENCRYPTED_PREFIX)) return stored;
  const plaintext = decrypt(stored.slice(ENCRYPTED_PREFIX.length), requireEncryptionKey());
  return plaintext == null ? fallback : plaintext;
}

// The thread graph (chat-graph.js) stores excerpts of student turns under
// the same key and prefix, so its rows read back with the same helpers.
export const sealText = seal;
export const openText = open;

// Every column written through seal(), by table. The data export opens these
// (server/student-data.js collectStudentRows), and before this map it handed
// the student every conversation, thread title and thread-memory fact as
// "enc:v1:" ciphertext only the server could read. A newly sealed column is
// added here and nowhere else. openText passes unsealed text through, so a
// column that holds both (attachment text before direct uploads were sealed)
// reads correctly either way.
export const SEALED_COLUMNS = Object.freeze({
  chat_threads: Object.freeze(["title"]),
  chat_messages: Object.freeze(["content", "attachment_name", "model_content"]),
  chat_graph_facts: Object.freeze(["question", "advice"]),
  ec_attachments: Object.freeze(["extracted_text"]),
});

// A row with its sealed columns opened, for a table in SEALED_COLUMNS.
export function openSealedRow(table, row, openFn = open) {
  const columns = SEALED_COLUMNS[table];
  if (!columns || !row) return row;
  const out = { ...row };
  for (const column of columns) {
    if (out[column] != null) out[column] = openFn(out[column], null);
  }
  return out;
}

function publicThread(row) {
  if (!row) return row;
  return { ...row, title: open(row.title, "Conversation unavailable") };
}

function publicMessage(row) {
  if (!row) return row;
  return {
    ...row,
    content: open(row.content, "[Unable to decrypt message]"),
    attachment_name: open(row.attachment_name, null),
    model_content: row.model_content != null ? open(row.model_content, null) : null,
  };
}

export function createThread(stmts, studentId, title) {
  const id = "thr_" + crypto.randomBytes(8).toString("hex");
  const safeTitle = String(title || DEFAULT_TITLE).slice(0, 200);
  stmts.createThread.run(id, studentId, seal(safeTitle));
  return { id, title: safeTitle };
}

export function listThreads(stmts, studentId, limit = MAX_THREADS_PER_LIST) {
  return stmts.listThreads
    .all(studentId, Math.min(Math.max(1, limit), MAX_THREADS_PER_LIST))
    .map(publicThread);
}

// A thread reopens at its newest MAX_MESSAGES_PER_THREAD messages, oldest
// first. It used to reopen at its oldest 500, so in a long thread every
// newer answer disappeared on reload. One row past the cap is read to know
// whether earlier messages are hidden; `truncated` says so and `olderCount`
// says how many, so the client can tell the student instead of the history
// silently starting part-way.
export function getThreadWithMessages(stmts, studentId, threadId) {
  const storedThread = stmts.getThread.get(threadId, studentId);
  if (!storedThread || storedThread.archived_at) return null;
  let rows = stmts.listMessages.all(threadId, MAX_MESSAGES_PER_THREAD + 1)
    .slice()
    .sort((a, b) => Number(a.id) - Number(b.id));
  const truncated = rows.length > MAX_MESSAGES_PER_THREAD;
  if (truncated) rows = rows.slice(-MAX_MESSAGES_PER_THREAD);
  let olderCount = 0;
  if (truncated) {
    const total = Number(stmts.countMessages?.get(threadId)?.n);
    olderCount = Number.isFinite(total) ? Math.max(0, total - rows.length) : 1;
  }
  return { thread: publicThread(storedThread), messages: rows.map(publicMessage), truncated, olderCount };
}

export function appendMessage(stmts, studentId, threadId, role, content, attachmentName = null, modelContent = null) {
  const storedThread = stmts.getThread.get(threadId, studentId);
  if (!storedThread || storedThread.archived_at) return { ok: false, error: "thread_not_found" };
  if (!["user", "assistant", "system"].includes(role)) return { ok: false, error: "bad_role" };
  const safe = String(content || "").slice(0, MAX_MESSAGE_CHARS);
  if (!safe.trim() && !attachmentName) return { ok: false, error: "empty_message" };
  // The model-facing copy of a user turn (file-attachment context included),
  // stored encrypted alongside the display copy so reopening a thread can
  // replay the full context. Only kept when it differs from the display copy.
  const safeModel = modelContent != null && String(modelContent) !== safe
    ? String(modelContent).slice(0, MAX_MODEL_CONTENT_CHARS)
    : null;

  stmts.insertMessage.run(threadId, role, seal(safe), seal(attachmentName), seal(safeModel));
  stmts.touchThread.run(1, threadId);

  const currentTitle = open(storedThread.title, DEFAULT_TITLE);
  if (role === "user" && storedThread.message_count === 0 && currentTitle === DEFAULT_TITLE) {
    const derived = isCrisisText(safe)
      ? CRISIS_SAFE_TITLE
      : (safe.split(/\r?\n/)[0].trim().slice(0, 60) || DEFAULT_TITLE);
    stmts.updateThreadTitle.run(seal(derived), threadId, studentId);
  }
  return { ok: true };
}

export function renameThread(stmts, studentId, threadId, newTitle) {
  const title = String(newTitle || "").trim().slice(0, 200);
  if (!title) return false;
  return stmts.updateThreadTitle.run(seal(title), threadId, studentId).changes > 0;
}

export function archiveThread(stmts, studentId, threadId) {
  return stmts.archiveThread.run(threadId, studentId).changes > 0;
}

export function deleteThread(stmts, studentId, threadId) {
  stmts.deleteThreadMessages.run(threadId, studentId);
  return stmts.deleteThreadHard.run(threadId, studentId).changes > 0;
}

export function searchMessages(stmts, studentId, query) {
  const normalizedQuery = String(query || "").trim().toLocaleLowerCase();
  if (normalizedQuery.length < 2) return [];

  const matches = [];
  for (const stored of stmts.searchMessages.all(studentId, MAX_SEARCH_SCAN)) {
    const row = {
      ...publicMessage(stored),
      title: open(stored.title, "Conversation unavailable"),
    };
    if (row.content.toLocaleLowerCase().includes(normalizedQuery)) matches.push(row);
    if (matches.length >= MAX_SEARCH_RESULTS) break;
  }
  return matches;
}
