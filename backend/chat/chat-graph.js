// Thread graph — the counselor's memory of earlier conversations, kept as
// entities and edges in SQLite rather than as replayed transcripts.
//
// Why this exists. Every specialist call used to carry up to twelve turns
// (60k characters) of raw history plus a "cached counseling context" block
// that re-injected old answers verbatim. That is the mechanism of context
// rot: a stale answer about Brown steered a new thread about Cornell, and
// the model's attention was spent on transcript instead of the question.
//
// What it stores. When an assistant turn is persisted, the preceding
// question and a short excerpt of the answer become one *fact* node, and
// deterministic extraction links it to every *entity* the pair mentions:
// schools (through the same alias table the VERIFIED DATA block uses),
// admission plans, the student's own recorded activities, coarse topics,
// the classifier's intent, and an attachment name. No model call is
// involved; the excerpts are encrypted with the chat-history key.
//
// What a turn gets. The chat route detects the entities in the new
// question, walks the edges to the facts that share them, drops facts
// whose question is already in the verbatim history the client sent, and
// renders a bounded THREAD MEMORY block (a few lines, never transcripts).
// A brand-new thread with no entity match gets the two most recent facts
// so "what did we discuss last time" still works.

import { classifyTopic, isCrisisText } from "./policy-router.js";
import { detectSchoolMentions } from "./chat-grounding.js";
import { sealText, openText } from "./chat-history.js";

export const THREAD_MEMORY_HEADER = "THREAD MEMORY";

const MAX_QUESTION_CHARS = 240;
const MAX_ADVICE_CHARS = 420;
const MIN_ANSWER_CHARS = 80;
const MAX_SCHOOLS_PER_TURN = 4;
const MAX_FACTS_PER_ENTITY = 3;
const DEFAULT_MAX_FACTS = 6;
const DEFAULT_MAX_CHARS = 2400;
const NEW_THREAD_RECALL = 2;

export function ensureChatGraphTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_graph_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      topic TEXT,
      question TEXT NOT NULL,
      advice TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_graph_facts_student ON chat_graph_facts(student_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_graph_facts_thread ON chat_graph_facts(thread_id);
    CREATE TABLE IF NOT EXISTS chat_graph_edges (
      fact_id INTEGER NOT NULL,
      student_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      PRIMARY KEY (fact_id, entity_type, entity_key)
    );
    CREATE INDEX IF NOT EXISTS idx_graph_edges_entity ON chat_graph_edges(student_id, entity_type, entity_key, fact_id DESC);
  `);
}

export function prepareChatGraphStatements(db) {
  return {
    insertFact: db.prepare(`INSERT INTO chat_graph_facts (student_id, thread_id, message_id, topic, question, advice) VALUES (?, ?, ?, ?, ?, ?)`),
    insertEdge: db.prepare(`INSERT OR IGNORE INTO chat_graph_edges (fact_id, student_id, entity_type, entity_key) VALUES (?, ?, ?, ?)`),
    factsForEntity: db.prepare(`
      SELECT f.id, f.thread_id, f.topic, f.question, f.advice, f.created_at
      FROM chat_graph_edges e JOIN chat_graph_facts f ON f.id = e.fact_id
      WHERE e.student_id = ? AND e.entity_type = ? AND e.entity_key = ?
      ORDER BY f.id DESC LIMIT ?
    `),
    latestFacts: db.prepare(`SELECT id, thread_id, topic, question, advice, created_at FROM chat_graph_facts WHERE student_id = ? ORDER BY id DESC LIMIT ?`),
    edgesForFact: db.prepare(`SELECT entity_type, entity_key FROM chat_graph_edges WHERE fact_id = ? ORDER BY entity_type, entity_key`),
    latestUserMessage: db.prepare(`SELECT id, content, attachment_name FROM chat_messages WHERE thread_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1`),
    deleteThreadEdges: db.prepare(`DELETE FROM chat_graph_edges WHERE fact_id IN (SELECT id FROM chat_graph_facts WHERE thread_id = ? AND student_id = ?)`),
    deleteThreadFacts: db.prepare(`DELETE FROM chat_graph_facts WHERE thread_id = ? AND student_id = ?`),
    countFacts: db.prepare(`SELECT COUNT(*) AS n FROM chat_graph_facts WHERE student_id = ?`),
  };
}

// ─── Entity extraction (deterministic) ────────────────────────────────

// Admission plans. The two-letter forms are case-sensitive so "ed" inside
// ordinary words and "ea" in "each" never match.
const PLAN_PATTERNS = [
  { key: "early decision II", tests: [/\bearly decision (?:ii|2)\b/i, /\bED ?(?:II|2)\b/] },
  { key: "early decision", tests: [/\bearly decision\b/i, /\bED\b/] },
  { key: "restrictive early action", tests: [/\b(?:restrictive|single[- ]choice) early action\b/i, /\b(?:REA|SCEA)\b/] },
  { key: "early action", tests: [/\bearly action\b/i, /\bEA\b/] },
  { key: "regular decision", tests: [/\bregular decision\b/i, /\bRD\b/] },
  { key: "rolling admission", tests: [/\brolling (?:admission|basis)\b/i] },
];

const TOPIC_PATTERNS = {
  essays: /\b(?:essay|personal statement|supplemental|common app prompt|why (?:us|this school|major))\b/i,
  "financial aid": /\b(?:fafsa|financial aid|css profile|scholarship|merit aid|tuition|cost of attendance|net price)\b/i,
  testing: /\b(?:sat|act|psat|test[- ]optional|superscore|toefl|ielts|ap (?:exam|score)s?)\b/i,
  courses: /\b(?:course(?:s| selection| load)?|class schedule|honors|dual enroll\w*|transcript|gpa|grades?)\b/i,
  extracurriculars: /\b(?:extracurricular\w*|activit(?:y|ies)|club|volunteer\w*|internship|research|leadership|ecs?)\b/i,
  "college list": /\b(?:college list|school list|reach(?:es)?|match(?:es)?|safet(?:y|ies)|target schools?)\b/i,
  deadlines: /\b(?:deadline|due date)s?\b/i,
  interviews: /\b(?:interview|recommendation(?: letter)?s?|recommender)\b/i,
};

function collapse(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function normalizeQuestion(text) {
  return collapse(text).toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, "").slice(0, 200);
}

// The question as the student typed it: no context appendix, no attached-file
// preface, no upload priming sentence.
export function bareQuestion(text) {
  return collapse(
    String(text || "")
      .replace(/\[context appendix[\s\S]*?(\[end context appendix\]|$)/gi, "")
      .replace(/\[Attached files —[\s\S]*?(\[End of attached files\]|$)/gi, "")
      .replace(/^The student uploaded "[^"]*"\.[\s\S]*?answer their question about it substantively\.\s*/i, ""),
  );
}

// A short excerpt of the advice: footers stripped (fidelity corrections,
// validator notes, support resources), markdown emphasis removed, cut at a
// sentence boundary. Never the whole answer — the point is to remember what
// was said, not to replay it.
export function adviceExcerpt(answer, maxChars = MAX_ADVICE_CHARS) {
  let text = String(answer || "")
    .replace(/\n\n_Correction from your saved profile[\s\S]*$/, "")
    .replace(/\n\n_저장된 프로필 기준 정정[\s\S]*$/, "")
    .replace(/\n\n_Note: This response could not be fully verified[\s\S]*$/, "");
  const paragraphs = text.split(/\n\s*\n/).filter((p) => {
    const t = p.trim();
    if (!t) return false;
    if (/^_[\s\S]*_$/.test(t)) return false; // italic footer lines
    if (/\b988\b|crisis (?:text )?line|hotline/i.test(t)) return false;
    return true;
  });
  text = collapse(paragraphs.join(" ").replace(/[*_`#>]+/g, ""));
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const boundary = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "), cut.lastIndexOf(": "));
  return (boundary > maxChars * 0.5 ? cut.slice(0, boundary + 1) : cut).trim() + (boundary > maxChars * 0.5 ? "" : "…");
}

export function extractEntities(text, { knownSchoolNames = [], activityNames = [], maxSchools = MAX_SCHOOLS_PER_TURN } = {}) {
  const source = String(text || "");
  const entities = [];
  const push = (type, key) => {
    const k = String(key || "").trim();
    if (k && !entities.some((e) => e.type === type && e.key.toLowerCase() === k.toLowerCase())) entities.push({ type, key: k });
  };
  if (!source.trim()) return entities;
  try {
    for (const name of detectSchoolMentions(source, { knownNames: knownSchoolNames, max: maxSchools })) push("school", name);
  } catch { /* school detection is best-effort */ }
  for (const plan of PLAN_PATTERNS) {
    if (plan.tests.some((re) => re.test(source))) push("plan", plan.key);
  }
  for (const name of activityNames) {
    const activity = String(name || "").trim();
    if (activity.length < 3) continue;
    const re = new RegExp(`(?<![A-Za-z0-9])${activity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i");
    if (re.test(source)) push("activity", activity);
  }
  for (const [topic, re] of Object.entries(TOPIC_PATTERNS)) {
    if (re.test(source)) push("topic", topic);
  }
  return entities;
}

// ─── Indexing (at persistence time) ───────────────────────────────────

// The user turn that precedes the assistant turn being persisted.
export function latestUserTurn(stmts, threadId) {
  const row = stmts.latestUserMessage.get(threadId);
  if (!row) return null;
  return {
    id: row.id,
    content: openText(row.content, ""),
    attachmentName: row.attachment_name != null ? openText(row.attachment_name, null) : null,
  };
}

export function indexTurn(stmts, {
  studentId, threadId, messageId, question, answer, attachmentName = null,
  knownSchoolNames = [], activityNames = [],
}) {
  const q = bareQuestion(question).slice(0, MAX_QUESTION_CHARS);
  const advice = adviceExcerpt(answer);
  if (!q || !advice || advice.length < MIN_ANSWER_CHARS) return null;
  // Crisis turns are withheld from history for privacy and never become
  // memory; the placeholder the append route stores is skipped the same way.
  if (isCrisisText(q) || /^\[Crisis-related message withheld/i.test(q)) return null;

  let classification = null;
  try { classification = classifyTopic(q); } catch { classification = null; }
  const topic = classification ? `${classification.topicType}:${classification.subIntent || "general"}` : null;

  const entities = extractEntities(`${q}\n${advice}`, { knownSchoolNames, activityNames });
  if (attachmentName) entities.push({ type: "attachment", key: String(attachmentName).slice(0, 120) });
  if (topic) entities.push({ type: "intent", key: topic });

  const factId = Number(stmts.insertFact.run(studentId, threadId, messageId, topic, sealText(q), sealText(advice)).lastInsertRowid);
  for (const entity of entities) stmts.insertEdge.run(factId, studentId, entity.type, entity.key.toLowerCase());
  return { factId, entities };
}

export function forgetThread(stmts, studentId, threadId) {
  stmts.deleteThreadEdges.run(threadId, studentId);
  stmts.deleteThreadFacts.run(threadId, studentId);
}

// ─── Retrieval (at chat time) ─────────────────────────────────────────

const LABEL_ORDER = { school: 0, plan: 1, activity: 2, attachment: 3 };

function factLabels(stmts, factId) {
  return stmts.edgesForFact.all(factId)
    .filter((edge) => edge.entity_type in LABEL_ORDER)
    .sort((a, b) => (LABEL_ORDER[a.entity_type] - LABEL_ORDER[b.entity_type]) || a.entity_key.localeCompare(b.entity_key))
    .map((edge) => edge.entity_type === "attachment" ? `attachment: ${edge.entity_key}` : edge.entity_key);
}

export function buildThreadGraphContext(stmts, {
  studentId, questionText, knownSchoolNames = [], activityNames = [],
  historyQuestions = [], maxFacts = DEFAULT_MAX_FACTS, maxChars = DEFAULT_MAX_CHARS,
}) {
  const empty = { text: "", count: 0, entities: [] };
  if (!stmts || !studentId) return empty;
  const question = bareQuestion(questionText);
  if (!question) return empty;

  const entities = extractEntities(question, { knownSchoolNames, activityNames });
  // Facts already represented in the verbatim history the client sent are
  // left out: the model has those turns in full.
  const seen = new Set((historyQuestions || []).map((h) => normalizeQuestion(bareQuestion(h))).filter(Boolean));

  const candidates = new Map(); // id -> { row, overlap }
  for (const entity of entities) {
    for (const row of stmts.factsForEntity.all(studentId, entity.type, entity.key.toLowerCase(), MAX_FACTS_PER_ENTITY)) {
      const current = candidates.get(row.id);
      if (current) current.overlap += entity.type === "topic" ? 0.5 : 1;
      else candidates.set(row.id, { row, overlap: entity.type === "topic" ? 0.5 : 1 });
    }
  }
  // A thread that is just starting gets the most recent facts even without
  // an entity match — "what did we talk about last time" must still work.
  if (candidates.size === 0 && (historyQuestions || []).length <= 1) {
    for (const row of stmts.latestFacts.all(studentId, NEW_THREAD_RECALL)) candidates.set(row.id, { row, overlap: 0 });
  }
  if (candidates.size === 0) return { ...empty, entities };

  const ranked = [...candidates.values()]
    .map(({ row, overlap }) => ({ ...row, overlap, question: openText(row.question, ""), advice: openText(row.advice, "") }))
    .filter((f) => f.question && f.advice && !seen.has(normalizeQuestion(f.question)))
    .sort((a, b) => (b.overlap - a.overlap) || (b.id - a.id))
    .slice(0, maxFacts);
  if (ranked.length === 0) return { ...empty, entities };

  const lines = [
    `${THREAD_MEMORY_HEADER} (earlier counseling with this student, most relevant first — reference only: the STUDENT PROFILE and VERIFIED DATA win on any conflict; do not restate these as new facts or repeat the advice word for word; use them to stay consistent and to avoid asking for what the student already told you):`,
  ];
  let used = lines[0].length;
  let count = 0;
  for (const fact of ranked) {
    const labels = factLabels(stmts, fact.id);
    const date = String(fact.created_at || "").slice(0, 10);
    const line = `• ${date}${labels.length ? ` [${labels.join("; ")}]` : ""} Asked: ${fact.question} → Advised: ${fact.advice}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
    count += 1;
  }
  if (count === 0) return { ...empty, entities };
  return { text: lines.join("\n"), count, entities };
}
