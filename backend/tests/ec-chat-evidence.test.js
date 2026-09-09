// The files a student attaches in chat, read into the activity they concern
// as EC evidence: the preface parser, the activity match, the harvest
// (sealed at rest, deduplicated), and the backfill over stored threads.
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import {
  parseAttachedFilesPreface,
  filesFromInlinedBlocks,
  uploadedFileName,
  activityTokens,
  scoreActivity,
  matchActivity,
  harvestEvidence,
  harvestStudentChatRecords,
} from "../ec-chat-evidence.js";
import { initRAGTables, prepareRAGStatements } from "../rag-engine.js";
import { appendMessage, configureChatEncryption, createThread, openText, sealText } from "../chat-history.js";
import { vectorizeECStrength } from "../ec-strength-vectorizer.js";

configureChatEncryption("ab".repeat(32));

function freshDb() {
  const db = new Database(":memory:");
  initRAGTables(db);
  return { db, stmts: prepareRAGStatements(db) };
}

function preface(files, question = "") {
  const lines = [`[Attached files — read carefully and reference in your answer; ${files.length} text file(s)]`];
  for (const f of files) {
    lines.push("", `═══ FILE: ${f.name} (${f.kb ?? 1} KB) ═══`, "```", f.text, "```");
  }
  lines.push("[End of attached files]", "", question);
  return lines.join("\n");
}

const ACTIVITIES = [
  { name: "USACO", role: "Competitor" },
  { name: "Food Bank", role: "Volunteer" },
  { name: "Robotics Club", role: "Captain" },
];

test("the attached-files preface parses into one entry per file, and a message without one yields nothing", () => {
  const content = preface([
    { name: "usaco-gold.txt", kb: 2, text: "USACO 2026 January Contest\nGold Division — promoted." },
    { name: "notes/letter.md", kb: 1, text: "To whom it may concern: 120 hours at the County Food Bank." },
  ], "Here are my files.");
  const files = parseAttachedFilesPreface(content);
  assert.deepEqual(files.map((f) => f.name), ["usaco-gold.txt", "notes/letter.md"]);
  assert.equal(files[0].text, "USACO 2026 January Contest\nGold Division — promoted.");
  assert.equal(files[0].sizeBytes, 2048);
  assert.deepEqual(parseAttachedFilesPreface("Just a question, no files."), []);
  assert.deepEqual(parseAttachedFilesPreface(null), []);
});

test("a document block inlined on a chat turn is named from the client's priming sentence", () => {
  const userText = 'The student uploaded "frc-award.pdf". If it is a school records document, extract every course; otherwise answer their question. What does this show?';
  assert.equal(uploadedFileName(userText), "frc-award.pdf");
  const files = filesFromInlinedBlocks(userText, [{ index: 0, mime: "application/pdf", text: "FIRST Robotics Competition — Regional Finalist" }, { index: 0, mime: "image/png", text: "second" }]);
  assert.deepEqual(files.map((f) => f.name), ["frc-award.pdf", "attachment-2.png"]);
  assert.deepEqual(filesFromInlinedBlocks("no sentinel", [{ mime: "application/pdf", text: "" }]), []);
});

test("an activity is matched from its name's words in the message, the file name or the file text — never from a bare word alone, never when two tie", () => {
  assert.deepEqual(activityTokens("Robotics Club"), ["robotics"]);
  assert.deepEqual(activityTokens("The Food Bank"), ["food", "bank"]);
  // The student named it in the message.
  assert.equal(matchActivity({ name: "cert.txt", text: "Gold division.", messageText: "My USACO certificate." }, ACTIVITIES).name, "USACO");
  // The file name names it.
  assert.equal(matchActivity({ name: "food-bank-letter.txt", text: "120 volunteer hours.", messageText: "Here is my letter." }, ACTIVITIES).name, "Food Bank");
  // The whole name inside the document is enough; a single word is not.
  assert.equal(matchActivity({ name: "letter.txt", text: "served at the county food bank all year", messageText: "" }, ACTIVITIES).name, "Food Bank");
  assert.equal(matchActivity({ name: "letter.txt", text: "we thank every bank that donated", messageText: "" }, ACTIVITIES), null);
  // Two activities named equally stay unlinked.
  assert.equal(matchActivity({ name: "both.txt", text: "", messageText: "USACO and the Food Bank" }, ACTIVITIES), null);
  assert.equal(matchActivity({ name: "x.txt", text: "", messageText: "" }, []), null);
  assert.ok(scoreActivity({ name: "USACO" }, { messageText: "usaco" }) >= 3);
});

test("harvested files are stored sealed, linked to the matched activity, deduplicated by text, and read by the strength vector", async () => {
  const { db, stmts } = freshDb();
  const sid = "student-evidence";
  const files = [
    { name: "usaco-gold.txt", text: "USACO 2026 January Contest. Gold Division — promoted to Gold." },
    { name: "essay.txt", text: "My college essay draft about resilience." },
  ];
  const first = harvestEvidence(stmts.strength, sid, files, { activities: ACTIVITIES, messageText: "My USACO certificate and an essay.", seal: sealText, threadId: "thr_1", messageId: 7 });
  assert.deepEqual(first.linked.map((l) => [l.name, l.ecName]), [["usaco-gold.txt", "USACO"]]);
  assert.deepEqual(first.unmatched.map((u) => u.name), ["essay.txt"]);

  const row = db.prepare("SELECT * FROM ec_attachments WHERE student_id = ?").get(sid);
  assert.equal(row.ec_name, "USACO");
  assert.equal(row.storage_path, "chat://thr_1/7");
  assert.equal(row.extraction_status, "ok");
  assert.ok(row.extracted_text.startsWith("enc:v1:"), "text is sealed at rest");
  assert.equal(openText(row.extracted_text), files[0].text);

  // The same file again is skipped, whatever the message says.
  const again = harvestEvidence(stmts.strength, sid, [files[0]], { activities: ACTIVITIES, messageText: "USACO again", seal: sealText });
  assert.equal(again.linked.length, 0);
  assert.deepEqual(again.skipped, [{ name: "usaco-gold.txt", reason: "already_stored" }]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ec_attachments").get().n, 1);

  // The strength read opens the sealed text: the level comes from the
  // certificate, and the rationale says the level was read from a document.
  const attachments = stmts.strength.getAttachmentsForEC.all(sid, "USACO");
  const fileText = attachments.map((a) => openText(a.extracted_text)).join("\n");
  const vec = await vectorizeECStrength({ ec: { name: "USACO", role: "Competitor", description: "Weekly practice contests", hoursPerWeek: 4, weeksPerYear: 30, yearsOfParticipation: 1 }, fileText, ragStmts: stmts });
  assert.equal(vec.factors.prestige, 0.65);
  assert.equal(vec.reasoning.prestige.level, "USACO Gold");
  assert.match(vec.reasoning.prestige.rationale, /recognized from the activity's name, read at the "USACO Gold" level from an uploaded document/);
});

test("the backfill reads every stored thread's uploads, links what names an activity, and reports uploads that kept only their name", () => {
  const { stmts } = freshDb();
  const sid = "student-backfill";
  const thread = createThread(stmts, sid, "Uploads");
  appendMessage(stmts, sid, thread.id, "user", "Here is my volunteer letter.", "food-bank-letter.txt",
    preface([{ name: "food-bank-letter.txt", text: "This confirms 120 hours at the County Food Bank, training new volunteers." }], "Here is my volunteer letter."));
  appendMessage(stmts, sid, thread.id, "assistant", "Thanks — that shows sustained service.");
  // A PDF sent through the single-file picker before this build: the chat
  // record kept its name and the question, not its text.
  appendMessage(stmts, sid, thread.id, "user", "What does this award show?", "scan.pdf", "Please analyze this file: scan.pdf");
  appendMessage(stmts, sid, thread.id, "user", "A plain question with no file.");

  const summary = harvestStudentChatRecords(stmts, sid, { activities: ACTIVITIES, seal: sealText });
  assert.equal(summary.threads, 1);
  assert.equal(summary.messagesWithFiles, 2);
  assert.deepEqual(summary.linked.map((l) => [l.name, l.ecName]), [["food-bank-letter.txt", "Food Bank"]]);
  assert.deepEqual(summary.nameOnly.map((n) => n.name), ["scan.pdf"]);
  assert.equal(summary.unmatched.length, 0);

  // Running it again links nothing new.
  const second = harvestStudentChatRecords(stmts, sid, { activities: ACTIVITIES, seal: sealText });
  assert.equal(second.linked.length, 0);
  assert.equal(second.skipped.length, 1);
});
