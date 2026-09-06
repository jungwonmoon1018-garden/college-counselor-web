import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { configureChatEncryption, sealText } from "../chat-history.js";
import {
  adviceExcerpt,
  bareQuestion,
  buildThreadGraphContext,
  ensureChatGraphTables,
  extractEntities,
  forgetThread,
  indexTurn,
  latestUserTurn,
  prepareChatGraphStatements,
  THREAD_MEMORY_HEADER,
} from "../chat-graph.js";

configureChatEncryption("a".repeat(64));

function freshStore() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      attachment_name TEXT,
      model_content TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  ensureChatGraphTables(db);
  return { db, stmts: prepareChatGraphStatements(db) };
}

const KNOWN = ["Brown University", "Cornell University", "New Jersey Institute of Technology"];
const LONG_ADVICE = "Brown's early decision plan is binding, so only apply ED if Brown is your clear first choice and the net price calculator works for your family. Your 3.7 unweighted GPA and your Robotics Club captaincy are solid; strengthen the why-Brown essay with the open curriculum.";

test("extractEntities links schools, plans, activities, and topics deterministically", () => {
  const entities = extractEntities(
    "Should I apply ED to Brown University or EA to Cornell University? My Robotics Club work matters for the essay.",
    { knownSchoolNames: KNOWN, activityNames: ["Robotics Club", "Debate"] },
  );
  const keys = entities.map((e) => `${e.type}:${e.key}`);
  assert.ok(keys.includes("school:Brown University"), keys.join(", "));
  assert.ok(keys.includes("school:Cornell University"), keys.join(", "));
  assert.ok(keys.includes("plan:early decision"));
  assert.ok(keys.includes("plan:early action"));
  assert.ok(keys.includes("activity:Robotics Club"));
  assert.ok(!keys.includes("activity:Debate"));
  assert.ok(keys.includes("topic:essays"));
});

test("two-letter plan codes are case-sensitive so ordinary words never match", () => {
  const keys = extractEntities("I need each grade listed and edited before the deadline", { knownSchoolNames: KNOWN }).map((e) => `${e.type}:${e.key}`);
  assert.ok(!keys.some((k) => k.startsWith("plan:")), keys.join(", "));
  assert.ok(keys.includes("topic:deadlines"));
});

test("bareQuestion strips the context appendix, file prefaces, and upload priming", () => {
  const q = bareQuestion("What should I fix?\n\n[Context appendix — reference data]\nFAFSA opens Oct 1\n[End context appendix]");
  assert.equal(q, "What should I fix?");
  const primed = bareQuestion("The student uploaded \"essay.pdf\". If it is a school records document (report card, transcript, score report), extract the academic data (grades, scores, courses, GPA). Otherwise treat it as the student's own material (project, competition entry, essay draft, resume, award, notes) — whatever its subject — and answer their question about it substantively. Is my hook strong?");
  assert.equal(primed, "Is my hook strong?");
});

test("adviceExcerpt drops correction and support footers and cuts at a sentence", () => {
  const answer = `${LONG_ADVICE}\n\n_Correction from your saved profile: your GPA is 3.7._\n\n_If things feel heavy, the 988 Suicide & Crisis Lifeline is there._`;
  const excerpt = adviceExcerpt(answer, 200);
  assert.ok(!/Correction|988/.test(excerpt), excerpt);
  assert.ok(excerpt.length <= 201, String(excerpt.length));
  assert.match(excerpt, /\.$/);
});

test("indexTurn stores an encrypted fact with edges; crisis and short turns are skipped", () => {
  const { db, stmts } = freshStore();
  db.prepare("INSERT INTO chat_messages (thread_id, role, content) VALUES (?, ?, ?)").run("thr_1", "user", "plain");
  const indexed = indexTurn(stmts, {
    studentId: "stu_1", threadId: "thr_1", messageId: 1,
    question: "Should I apply ED to Brown University?", answer: LONG_ADVICE,
    knownSchoolNames: KNOWN, activityNames: ["Robotics Club"],
  });
  assert.ok(indexed?.factId);
  const row = db.prepare("SELECT * FROM chat_graph_facts WHERE id = ?").get(indexed.factId);
  assert.match(row.question, /^enc:v1:/);
  assert.match(row.advice, /^enc:v1:/);
  const edges = db.prepare("SELECT entity_type, entity_key FROM chat_graph_edges WHERE fact_id = ? ORDER BY entity_type, entity_key").all(indexed.factId);
  const keys = edges.map((e) => `${e.entity_type}:${e.entity_key}`);
  assert.ok(keys.includes("school:brown university"), keys.join(", "));
  assert.ok(keys.includes("plan:early decision"));
  assert.ok(keys.includes("activity:robotics club"));
  assert.ok(keys.some((k) => k.startsWith("intent:")));

  assert.equal(indexTurn(stmts, { studentId: "stu_1", threadId: "thr_1", messageId: 2, question: "I want to kill myself", answer: LONG_ADVICE }), null);
  assert.equal(indexTurn(stmts, { studentId: "stu_1", threadId: "thr_1", messageId: 3, question: "Thanks", answer: "You're welcome." }), null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_graph_facts").get().n, 1);
});

test("buildThreadGraphContext recalls facts by shared entity and skips turns already in history", () => {
  const { stmts } = freshStore();
  indexTurn(stmts, { studentId: "stu_1", threadId: "thr_1", messageId: 1, question: "Should I apply ED to Brown University?", answer: LONG_ADVICE, knownSchoolNames: KNOWN });
  indexTurn(stmts, { studentId: "stu_1", threadId: "thr_2", messageId: 2, question: "How do I strengthen my Cornell engineering application?", answer: "Cornell Engineering weighs math and physics rigor heavily; your AP Physics C and Calculus BC are the right signals, and the supplemental essay should show a specific project you want to build there.", knownSchoolNames: KNOWN });
  indexTurn(stmts, { studentId: "stu_2", threadId: "thr_9", messageId: 3, question: "Is Brown University a reach for me?", answer: "For another student entirely, Brown remains a reach; this line must never appear in the first student's memory block because rows are keyed by student.", knownSchoolNames: KNOWN });

  const brown = buildThreadGraphContext(stmts, { studentId: "stu_1", questionText: "What did you say about Brown University's binding plan?", knownSchoolNames: KNOWN, historyQuestions: ["What did you say about Brown University's binding plan?"] });
  assert.equal(brown.count, 1);
  assert.match(brown.text, new RegExp(`^${THREAD_MEMORY_HEADER}`));
  assert.match(brown.text, /\[brown university; early decision\] Asked: Should I apply ED to Brown University\? → Advised: Brown's early decision plan is binding/);
  assert.doesNotMatch(brown.text, /Cornell|another student/);

  // The Brown turn is in the verbatim history this time, so only a new-thread
  // recall could surface it — and this is not a new thread.
  const inHistory = buildThreadGraphContext(stmts, { studentId: "stu_1", questionText: "And the deadline for that plan?", knownSchoolNames: KNOWN, historyQuestions: ["Should I apply ED to Brown University?", "And the deadline for that plan?"] });
  assert.equal(inHistory.count, 0);

  // A brand-new thread with no entity match gets the most recent facts.
  const fresh = buildThreadGraphContext(stmts, { studentId: "stu_1", questionText: "What did we talk about last time?", knownSchoolNames: KNOWN, historyQuestions: ["What did we talk about last time?"] });
  assert.equal(fresh.count, 2);
  assert.doesNotMatch(fresh.text, /another student/);

  // An unrelated student sees nothing from stu_1.
  const other = buildThreadGraphContext(stmts, { studentId: "stu_3", questionText: "Should I apply ED to Brown University?", knownSchoolNames: KNOWN, historyQuestions: [] });
  assert.equal(other.count, 0);
});

test("the block stays within its character budget", () => {
  const { stmts } = freshStore();
  for (let i = 0; i < 12; i++) {
    indexTurn(stmts, { studentId: "stu_1", threadId: `thr_${i}`, messageId: i + 1, question: `Question ${i} about Brown University and its early decision round?`, answer: `${LONG_ADVICE} Variant ${i}.`, knownSchoolNames: KNOWN });
  }
  const block = buildThreadGraphContext(stmts, { studentId: "stu_1", questionText: "Brown ED again?", knownSchoolNames: KNOWN, historyQuestions: ["Brown ED again?"], maxChars: 900 });
  assert.ok(block.text.length <= 900, String(block.text.length));
  assert.ok(block.count >= 1 && block.count <= 3, String(block.count));
});

test("latestUserTurn decrypts the preceding question and forgetThread removes a thread's memory", () => {
  const { db, stmts } = freshStore();
  db.prepare("INSERT INTO chat_messages (thread_id, role, content, attachment_name) VALUES (?, ?, ?, ?)").run("thr_1", "user", sealText("Should I apply ED to Brown University?"), sealText("essay.pdf"));
  const prior = latestUserTurn(stmts, "thr_1");
  assert.equal(prior.content, "Should I apply ED to Brown University?");
  assert.equal(prior.attachmentName, "essay.pdf");
  indexTurn(stmts, { studentId: "stu_1", threadId: "thr_1", messageId: prior.id, question: prior.content, answer: LONG_ADVICE, attachmentName: prior.attachmentName, knownSchoolNames: KNOWN });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_graph_edges WHERE entity_type = 'attachment'").get().n, 1);
  forgetThread(stmts, "stu_1", "thr_1");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_graph_facts").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_graph_edges").get().n, 0);
});
