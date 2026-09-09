// ═══════════════════════════════════════════════════════════════════════
// EC EVIDENCE FROM CHAT — the files a student attaches in chat, read into
// the activity they concern.
// ═══════════════════════════════════════════════════════════════════════
// The only way a student uploads a file is in chat: a certificate, an award
// letter, a project write-up, a resume. The file's text used to live only on
// the chat record (the message's model-facing copy, encrypted) and in the
// vault's document list; the EC strength read, built to consume attachment
// text (achievement, prestige, narrative fit), never saw it, and nothing in
// the UI reaches /api/ec/upload. This module bridges the two:
//
//   1. parseAttachedFilesPreface — the "[Attached files — …]" block the client
//      builds for text-extracted uploads, one entry per file.
//   2. filesFromInlinedBlocks — a PDF or image sent as a document block, whose
//      text the chat route extracts on the way to the model; the file name
//      comes from the client's priming sentence.
//   3. matchActivity — which of the student's activities a file concerns,
//      from the activity name's words in the student's message, in the file
//      name and in the file text. A file that names no activity, or two
//      equally, stays unlinked rather than guessed.
//   4. harvestEvidence — store each matched file as an EC attachment (the
//      text sealed at rest like the chat history, deduplicated by text hash)
//      so the next strength recompute reads it.
//   5. harvestStudentChatRecords — the backfill over every stored thread;
//      an upload whose text is not in its chat record (a PDF or image sent
//      before this build kept only its name) is reported, not guessed.
//
// Deterministic; no model call.

import crypto from "node:crypto";
import { listThreads, getThreadWithMessages } from "./chat-history.js";

const PREFACE_START = /\[Attached files —[^\]]*\]/i;
const PREFACE_END = /\[End of attached files\]/i;
const FILE_HEADER = /^═══ FILE: (.+?) \((\d+) KB\) ═══$/;
const UPLOAD_SENTINEL = /The student uploaded "([^"]+)"/;
const MAX_EVIDENCE_CHARS = 20_000;
const MIN_SCORE = 2;
const MIN_MARGIN = 1;

// Words that appear in most activity names and so identify none of them.
const STOPWORDS = new Set([
  "the", "and", "for", "of", "in", "at", "to", "with", "club", "team", "society", "program", "programme",
  "project", "group", "committee", "council", "association", "organization", "organisation", "activity",
  "member", "volunteer", "volunteering", "high", "school", "student", "students",
]);

export function parseAttachedFilesPreface(modelContent) {
  const text = String(modelContent || "");
  const start = text.search(PREFACE_START);
  if (start < 0) return [];
  const rest = text.slice(start);
  const end = PREFACE_END.exec(rest);
  const block = end ? rest.slice(0, end.index) : rest;
  const files = [];
  let current = null;
  let inFence = false;
  for (const line of block.split(/\r?\n/)) {
    if (!inFence) {
      const header = FILE_HEADER.exec(line);
      if (header) { current = { name: header[1].trim(), kb: Number(header[2]) || 0, lines: [] }; continue; }
      if (current && line.trim() === "```") { inFence = true; continue; }
      continue;
    }
    if (line.trim() === "```") {
      files.push({ name: current.name, sizeBytes: current.kb * 1024 || null, text: current.lines.join("\n").trim() });
      current = null;
      inFence = false;
      continue;
    }
    current.lines.push(line);
  }
  return files.filter((f) => f.text);
}

export function uploadedFileName(userText) {
  const m = UPLOAD_SENTINEL.exec(String(userText || ""));
  return m ? m[1].trim() : null;
}

// The document and image blocks the chat route inlined for one turn, as
// files: the client sends one binary attachment per turn and names it in
// its priming sentence; anything else gets a generic name.
export function filesFromInlinedBlocks(userText, inlined = []) {
  const named = uploadedFileName(userText);
  const out = [];
  let n = 0;
  for (const block of Array.isArray(inlined) ? inlined : []) {
    const text = String(block?.text || "").trim();
    if (!text) continue;
    n += 1;
    const ext = extensionForMime(block?.mime);
    out.push({ name: n === 1 && named ? named : `attachment-${n}${ext}`, sizeBytes: null, text });
  }
  return out;
}

function extensionForMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m === "application/pdf") return ".pdf";
  if (m === "image/png") return ".png";
  if (m === "image/jpeg" || m === "image/jpg") return ".jpg";
  if (m === "image/webp") return ".webp";
  if (m.includes("wordprocessingml")) return ".docx";
  if (m === "text/plain") return ".txt";
  return "";
}

function mimeForName(name) {
  const ext = String(name || "").toLowerCase().split(".").pop();
  return ({ pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", md: "text/markdown", txt: "text/plain" })[ext] || "text/plain";
}

export function activityTokens(name) {
  return [...new Set(String(name || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOPWORDS.has(t)))];
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasWord(text, word) {
  return new RegExp(`(^|[^a-z0-9])${escapeRe(word)}(?![a-z0-9])`, "i").test(text);
}

function hasPhrase(text, phrase) {
  const norm = String(phrase || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!norm) return false;
  const pattern = norm.split(" ").map(escapeRe).join("[^a-z0-9]+");
  return new RegExp(`(^|[^a-z0-9])${pattern}(?![a-z0-9])`, "i").test(String(text || "").toLowerCase());
}

// Score one activity against a file: the activity name's words in the
// student's own message weigh most (they said which activity this is), in
// the file name next, in the file text least; the whole name verbatim
// anywhere adds a step. A bare word inside a long document is not enough on
// its own. When a turn carries several files, the message speaks for all of
// them, so it counts for a file only when that file's own name or text also
// names the activity (`soloFile` false); with one file it stands alone.
export function scoreActivity(activity, { name = "", text = "", messageText = "" } = {}, { soloFile = true } = {}) {
  const tokens = activityTokens(activity?.name);
  if (!tokens.length) return 0;
  const share = (haystack) => tokens.filter((t) => hasWord(String(haystack || ""), t)).length / tokens.length;
  const own = 2 * share(name) + 1 * share(text) + (hasPhrase(name, activity.name) || hasPhrase(text, activity.name) ? 2 : 0);
  const fromMessage = soloFile || own > 0
    ? 3 * share(messageText) + (hasPhrase(messageText, activity.name) ? 2 : 0)
    : 0;
  return Math.round((own + fromMessage) * 100) / 100;
}

export function matchActivity(file, activities = [], { soloFile = true } = {}) {
  const scored = (Array.isArray(activities) ? activities : [])
    .filter((a) => a && a.name)
    .map((a) => ({ name: a.name, score: scoreActivity(a, file, { soloFile }) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < MIN_SCORE) return null;
  const second = scored[1];
  if (second && best.score - second.score < MIN_MARGIN) return null;
  return best;
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * Store the files of one chat record as EC attachments.
 *
 * @param {object} stmts — prepareECStrengthStatements output (insertAttachment,
 *   getAttachmentsForStudent).
 * @param {string} studentId
 * @param {Array<{name, text, sizeBytes?}>} files
 * @param {object} [options]
 * @param {Array} [options.activities] — the student's activities (name, …).
 * @param {string} [options.messageText] — the student's own words in that turn.
 * @param {function} [options.seal] — seals the text at rest (chat-history's
 *   sealText in the server); identity by default.
 * @param {string} [options.threadId]
 * @param {string|number} [options.messageId]
 * @returns {{ linked: Array, unmatched: Array, skipped: Array }}
 */
export function harvestEvidence(stmts, studentId, files, {
  activities = [],
  messageText = "",
  seal = (t) => t,
  threadId = null,
  messageId = null,
} = {}) {
  const result = { linked: [], unmatched: [], skipped: [] };
  if (!stmts?.insertAttachment || !studentId) return result;
  const known = new Set((stmts.getAttachmentsForStudent?.all(studentId) || []).map((r) => r.extracted_text_hash).filter(Boolean));
  const list = (Array.isArray(files) ? files : []).filter((f) => String(f?.text || "").trim());
  const soloFile = list.length === 1;
  for (const file of list) {
    const text = String(file?.text || "").trim().slice(0, MAX_EVIDENCE_CHARS);
    if (!text) continue;
    const name = String(file?.name || "attachment").slice(0, 240);
    const hash = sha256(text);
    if (known.has(hash)) { result.skipped.push({ name, reason: "already_stored" }); continue; }
    const match = matchActivity({ name, text, messageText }, activities, { soloFile });
    if (!match) { result.unmatched.push({ name }); continue; }
    const id = crypto.randomUUID();
    const storagePath = `chat://${threadId || "turn"}/${messageId ?? hash.slice(0, 16)}`;
    stmts.insertAttachment.run(
      id, studentId, match.name,
      name, mimeForName(name), Number(file?.sizeBytes) || text.length,
      storagePath, seal(text), hash, text.length,
      "ok", null,
    );
    known.add(hash);
    result.linked.push({ id, name, ecName: match.name, score: match.score });
  }
  return result;
}

/**
 * The backfill: every stored thread's user turns that carried a file, read
 * into the activities they concern. `stmts` is the RAG statement set (thread
 * and message readers, plus `.strength` for the attachments).
 */
export function harvestStudentChatRecords(stmts, studentId, { activities = [], seal } = {}) {
  const summary = { threads: 0, messagesWithFiles: 0, linked: [], unmatched: [], skipped: [], nameOnly: [] };
  if (!stmts?.strength || !studentId) return summary;
  for (const thread of listThreads(stmts, studentId)) {
    const full = getThreadWithMessages(stmts, studentId, thread.id);
    if (!full) continue;
    summary.threads += 1;
    for (const message of full.messages) {
      if (message.role !== "user" || !message.attachment_name) continue;
      summary.messagesWithFiles += 1;
      const files = parseAttachedFilesPreface(message.model_content);
      if (!files.length) {
        summary.nameOnly.push({ name: message.attachment_name, threadId: thread.id, messageId: message.id });
        continue;
      }
      const r = harvestEvidence(stmts.strength, studentId, files, {
        activities, messageText: message.content, seal, threadId: thread.id, messageId: message.id,
      });
      summary.linked.push(...r.linked);
      summary.unmatched.push(...r.unmatched);
      summary.skipped.push(...r.skipped);
    }
  }
  return summary;
}
