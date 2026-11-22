import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeProviderPayload, screenInput, screenOutput, redactProviderText } from "../chat/content-moderation.js";
import { redactProviderPayload, restoreProviderResponse } from "../chat/orchestration-engine.js";
import { callLLM } from "../llm-adapters/index.js";

const PII_TEXT = "John Doe from Lakeside High lives at 123 Main Street. Email john@example.com, phone 555-123-4567, SSN 123-45-6789, income $180,000, student ID is U-12345.";

function assertNoRawPii(serialized) {
  assert.doesNotMatch(serialized, /john@example\.com/i);
  assert.doesNotMatch(serialized, /555-123-4567/);
  assert.doesNotMatch(serialized, /123-45-6789/);
  assert.doesNotMatch(serialized, /\$180,000/);
  assert.doesNotMatch(serialized, /123 Main Street/);
  assert.doesNotMatch(serialized, /U-12345/);
}

test("sanitizeProviderPayload deep-redacts strings and structured FAFSA data", () => {
  const redacted = sanitizeProviderPayload({
    system: `Counsel ${PII_TEXT}`,
    messages: [{ role: "user", content: [{ type: "text", text: PII_TEXT }] }],
    metadata: {
      fafsaProfile: {
        parentAdjustedGrossIncome: 180000,
        studentAidIndex: -1500,
        householdSize: 4,
      },
    },
  });
  const serialized = JSON.stringify(redacted.sanitizedPayload);
  assertNoRawPii(serialized);
  assert.match(serialized, /\[STUDENT_EMAIL_01\]/);
  assert.match(serialized, /\[SSN_01\]/);
  assert.equal(redacted.structuredSanitization.applied, true);
  assert.equal(redacted.sanitizedPayload.metadata.fafsaProfile.parentAdjustedGrossIncome, undefined);
  assert.equal(redacted.sanitizedPayload.metadata.fafsaProfile.financialNeedCategory, "maximum_need");
});

test("compat provider redactor exports redact and restore only restorable tokens", () => {
  const redacted = redactProviderPayload({
    messages: [{ role: "user", content: PII_TEXT }],
  }, "student-1");
  const serialized = JSON.stringify(redacted.payload);
  assertNoRawPii(serialized);
  assert.ok(redacted.payload.metadata.user_id);
  assert.ok(redacted.masking.applied);

  const restored = restoreProviderResponse({
    content: [{ type: "text", text: "[STUDENT_NAME_01] attends [CURRENT_SCHOOL_01]; [SSN_01] stays masked." }],
  }, redacted.tokenMap);
  assert.match(restored.response.content[0].text, /John Doe/);
  assert.match(restored.response.content[0].text, /Lakeside High/);
  assert.match(restored.response.content[0].text, /\[SSN_01\]/);
});

// The chat payload path, where an aid question carries a parent's income:
// "brought in" and "grossed" used to rewrite it as "N USD" for the provider.
test("a parent's income said with an achievement verb stays masked in the model payload", () => {
  const redacted = redactProviderPayload({
    messages: [
      { role: "user", content: "My parents brought in $60k last year, will I get aid?" },
      { role: "user", content: "My dad grossed $150,000 last year. We raised $4,500 for the food bank." },
    ],
  }, "student-1");
  const serialized = JSON.stringify(redacted.payload.messages);
  assert.doesNotMatch(serialized, /60k|150,000/);
  assert.match(serialized, /My parents brought in \[ANNUAL_INCOME_01\] last year/);
  assert.match(serialized, /My dad grossed \[ANNUAL_INCOME_02\] last year\. We raised 4,500 USD for the food bank\./);
});

test("callLLM redacts the fixed OpenRouter request body before fetch", async () => {
  let captured = "";
  const result = await callLLM({
    provider: "openrouter",
    apiKey: "sk-or-test",
    model: "google/gemma-4-26b-a4b-it",
    messages: [{ role: "user", content: PII_TEXT }],
    fetchImpl: async (_url, init) => {
      captured = init.body;
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ choices: [{ message: { content: "ok" } }], usage: {} }) };
    },
  });
  assertNoRawPii(captured);
  assertNoRawPii(JSON.stringify(result));
  assert.equal(Object.hasOwn(result, "_raw"), false);
  assert.equal(Object.hasOwn(result, "_tokenMap"), false);
});

test("screenInput and screenOutput expose compatibility aliases", () => {
  const input = screenInput("password: hunter2");
  assert.equal(input.blocked, true);
  assert.equal(input.reason, input.message);

  const output = screenOutput("Do not leak 123-45-6789 or sk-proj-abcdefghijklmnopqrstuvwxyz.");
  assert.equal(output.modified, true);
  assert.doesNotMatch(output.text, /123-45-6789/);
  assert.doesNotMatch(output.text, /sk-proj-/);
});

// ─── L2: output screening covers non-restorable PII (not just SSN) ───
test("screenOutput redacts leaked phone numbers but keeps legitimate counseling content", () => {
  const out = screenOutput("Reach the office at admissions@uni.edu, tuition is about $40,000 — call 555-123-4567 for details.");
  assert.equal(out.modified, true);
  assert.doesNotMatch(out.text, /555-123-4567/);            // non-restorable phone → redacted
  assert.match(out.text, /admissions@uni\.edu/);            // restorable email → kept (round-tripped by restorePII)
  assert.match(out.text, /\$40,000/);                        // restorable financial → kept (legit tuition figure)
  assert.ok(out.issues.some((i) => i.type === "phone_leak"));
});

test("screenOutput leaves clean counselor text untouched", () => {
  const clean = "Focus your essay on the robotics project and ask your counselor about deadlines.";
  const out = screenOutput(clean);
  assert.equal(out.safe, true);
  assert.equal(out.text, clean);
});

// ─── L1: profile-context system prompt is masked before dispatch ───
test("redactProviderText masks PII in an auto-injected profile context", () => {
  const { text, tokenMap } = redactProviderText(
    "STUDENT PROFILE — Activities: founded a club, contact john@example.com; family income $180,000; SSN 123-45-6789."
  );
  assert.doesNotMatch(text, /john@example\.com/);   // email masked
  assert.doesNotMatch(text, /\$180,000/);            // income masked (non-restorable)
  assert.doesNotMatch(text, /123-45-6789/);          // SSN masked
  // restorable email token is recoverable so the student sees their own value if echoed
  assert.ok(Object.values(tokenMap).includes("john@example.com"));
});

test("redactProviderText is a no-op on non-strings and clean text", () => {
  assert.deepEqual(redactProviderText("").text, "");
  assert.equal(redactProviderText(undefined).text, "");
  const clean = "You are a college counselor. Cite official sources for FAFSA questions.";
  const r = redactProviderText(clean);
  assert.equal(r.text, clean);
  assert.equal(r.applied, false);
});

// ─── A school document's identity fields ───
// A mock run on 2026-11-22 sent an international school's transcript
// header to the provider with the student's name, ID number, date of
// birth, a +82 phone number, a Korean street address and the signing
// counselor's name intact. The identities below are invented.
const TRANSCRIPT_HEADER = [
  "NORTHGATE INTERNATIONAL SCHOOL",
  "HIGH SCHOOL TRANSCRIPT",
  "Student Information School Information",
  "Name: Minji Park",
  "NIS Student ID Number: 48213",
  "Date of Birth: Mar/04/2008",
  "Date of Graduation: June/18/2027",
  "Northgate International School",
  "12 Banpo-daero 3-gil, Seocho-gu,",
  "Seoul, South Korea 06500",
  "CEEB: 682000",
  "Phone: (+82) 02-555-0142",
  "Counselor: Hana Lee",
  "Unweighted Cumulative GPA :",
  "3.86",
  "SCHOOL YEAR: 2024-25 GRADE: 11 SCHOOL YEAR: 2025-26 GRADE: 12",
  "AP Calculus BC A 1.0 AP Statistics A 1.0",
  "Algebra II A+ A+ 1.0 AP Biology A 1.0",
  "Credits: 7 GPA: 4.85 (Unweighted: 4.00)",
  "Authorized by: Hana Lee",
].join("\n");

test("a transcript header reaches the provider without the student's identifiers, and its course rows intact", () => {
  const { text, tokenMap } = redactProviderText(TRANSCRIPT_HEADER);
  for (const raw of ["Minji Park", "48213", "Mar/04/2008", "02-555-0142", "Banpo-daero", "Hana Lee"]) {
    assert.doesNotMatch(text, new RegExp(raw.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")), raw);
  }
  // The labels stay, so the parser can tell the header from the record.
  assert.match(text, /^Name: \[PERSON_NAME_\d{2}\]$/m);
  assert.match(text, /^NIS Student ID Number: \[STUDENT_ID_\d{2}\]$/m);
  assert.match(text, /^Date of Birth: \[DATE_OF_BIRTH_\d{2}\]$/m);
  assert.match(text, /^Counselor: \[PERSON_NAME_\d{2}\]$/m);
  for (const kept of [
    "AP Calculus BC A 1.0 AP Statistics A 1.0",
    "Algebra II A+ A+ 1.0 AP Biology A 1.0",
    "Credits: 7 GPA: 4.85 (Unweighted: 4.00)",
    "SCHOOL YEAR: 2024-25 GRADE: 11 SCHOOL YEAR: 2025-26 GRADE: 12",
    "CEEB: 682000",
    "3.86",
  ]) assert.ok(text.includes(kept), kept);
  // Names are restorable if the model echoes them; numbers are not kept.
  assert.ok(Object.values(tokenMap).includes("Minji Park"));
  assert.ok(!Object.values(tokenMap).includes("48213"));
});

test("Korean record fields, resident numbers and domestic phone numbers are masked", () => {
  const { text } = redactProviderText([
    "성명: 김민지  생년월일: 2008년 3월 4일",
    "주민등록번호 080304-4123456, 080304-4******",
    "학번: 20231234",
    "주소: 서울특별시 서초구 반포대로 12",
    "Tel: 010-9876-5432",
    "DOB 2008-03-04, Student No. 48213, Home Address: 12 Elm St Apt 4, Springfield",
    "my student id is 48213",
  ].join("\n"));
  for (const raw of ["김민지", "2008년 3월 4일", "080304", "20231234", "반포대로", "010-9876-5432", "2008-03-04", "48213", "Elm St", "Apt 4"]) {
    assert.ok(!text.includes(raw), `${raw} reached the provider: ${text}`);
  }
});

test("the student's registered name is masked in any form a document prints it, and its parts alone are not", () => {
  const { text, tokenMap } = redactProviderText(
    "MINJI PARK\nPark, Minji — roster\nPark Minji attended. Minji led the club near Central Park.\n김민지 학생",
    { knownNames: ["Minji Park", "김민지"] },
  );
  assert.doesNotMatch(text, /minji park|park,? minji|김민지/i);
  assert.match(text, /Minji led the club near Central Park/);
  assert.ok(Object.values(tokenMap).includes("MINJI PARK"));
});

test("ordinary counseling text and the app's own figures pass the identity patterns unchanged", () => {
  for (const clean of [
    "My GPA is 3.86 and I scored 1480 on the SAT (720 + 760).",
    "AP Euro 5, AP Calc BC 4. AP/IB +1.0 weighted, honors +0.5.",
    "I volunteered 3 hours a week for 30 weeks; scores rose +60.",
    "The deadline is 11/01/2026 and the middle 50% SAT is 1330-1490.",
    "Club name: Robotics\nActivity name: Debate\nGrade Level: 11\nCredits earned: 2.0",
    "A question for my counselor: should I take AP Physics C or AP Statistics next year?",
    "My birthday party is next week, will that affect my essay?",
    "SCHOOL YEAR: 2024-25 GRADE: 11 Credits: 7 GPA: 4.85 (Unweighted: 4.00)",
    "Class of 2027, CEEB: 682490, school year 2023-24",
    "내 이름은 민지야. 이름 바꾸는 것도 지원서에 영향이 있을까?",
    "Central Park and Grace Hopper Academy",
  ]) {
    const r = redactProviderText(clean, { knownNames: ["Minji Park"] });
    assert.equal(r.text, clean, clean);
  }
});

test("an attachment in the chat payload is masked with the registered name and restored in the reply", () => {
  const redacted = redactProviderPayload({
    messages: [{ role: "user", content: [
      { type: "text", text: `${TRANSCRIPT_HEADER}\n\nPARK, MINJI — page 2` },
      { type: "text", text: "Which of my senior classes should I list first?" },
    ] }],
  }, "student-1", { knownNames: ["Minji Park"] });
  const serialized = JSON.stringify(redacted.payload);
  for (const raw of ["Minji", "48213", "Mar/04/2008", "02-555-0142", "Hana Lee"]) {
    assert.ok(!serialized.includes(raw), raw);
  }
  const token = Object.keys(redacted.tokenMap).find((key) => /^\[STUDENT_NAME_/.test(key));
  const restored = restoreProviderResponse({ content: [{ type: "text", text: `Hi ${token}, list AP Calculus BC first.` }] }, redacted.tokenMap);
  assert.match(restored.response.content[0].text, /Minji Park|PARK, MINJI/);
});

// ─── Server-side essay ghost-writing refusal ───
test("screenInput blocks essay ghost-writing requests with a coaching redirect", () => {
  for (const req of [
    "Write my college essay for me",
    "Can you write my personal statement?",
    "compose the whole 650-word common app essay about my grandmother",
    "draft my admissions essay please",
  ]) {
    const r = screenInput(req);
    assert.equal(r.blocked, true, `should block: ${req}`);
    assert.match(r.message, /brainstorm|outline|feedback/i);
  }
});

test("screenInput allows legitimate essay coaching requests", () => {
  for (const req of [
    "Can you give me feedback on my essay draft?",
    "Help me outline my personal statement",
    "I wrote my essay — how can I improve the intro?",
    "Brainstorm topics for my common app essay",
    "Revise this paragraph I wrote for clarity",
  ]) {
    const r = screenInput(req);
    assert.equal(r.blocked, false, `should NOT block: ${req}`);
  }
});
