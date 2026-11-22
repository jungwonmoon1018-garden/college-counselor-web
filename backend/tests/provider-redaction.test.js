import test from "node:test";
import assert from "node:assert/strict";
import { MAX_REGISTERED_NAME_CHARS, sanitizeProviderPayload, screenInput, screenOutput, redactProviderText } from "../chat/content-moderation.js";
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

// PR #7 review: a value ran across a line break, so a phone number took the
// GPA printed under it; and Korean labels without a colon took ordinary
// words ("보호자 동의가" lost 동의가).
test("an identity value stays on its own line, so the figures printed under it reach the parser", () => {
  for (const [text, expected] of [
    ["Phone: +82 02-555-0142\n3.86\nAP Biology A", "Phone: [PHONE_01]\n3.86\nAP Biology A"],
    ["(+82) 02-555-0142\n4.00\nCredits: 7", "[PHONE_01]\n4.00\nCredits: 7"],
    ["Tel: 02-555-0142\n3.86", "Tel: [PHONE_01]\n3.86"],
    ["Phone: 02-555-0142    3.86", "Phone: [PHONE_01]    3.86"],
    ["Date of Birth: Mar/04/2008\n3.86", "Date of Birth: [DATE_OF_BIRTH_01]\n3.86"],
    ["Date of Birth:\n3.86", "Date of Birth:\n3.86"],
    ["86\nBanpo-daero 3-gil", "86\nBanpo-daero 3-gil"],
    ["080304\n-4123456", "080304\n-4123456"],
  ]) assert.equal(redactProviderText(text).text, expected, JSON.stringify(text));
  // A date on the line after its label is still a date of birth.
  assert.equal(redactProviderText("Date of Birth:\nMar/04/2008").text, "Date of Birth:\n[DATE_OF_BIRTH_01]");
});

test("Korean labels that are also everyday words mask a value only with a colon or as a form field", () => {
  for (const clean of [
    "보호자 동의가 필요한가요?",
    "교장상을 받았어요",
    "담임 선생님께 추천서를 부탁드렸어요",
    "성명서를 냈어요",
    "주소 좀 알려줄래요?",
    "학번 2023학번이에요",
  ]) assert.equal(redactProviderText(clean).text, clean, clean);
  const fields = redactProviderText("성명 김민지\n학번 20231234\n보호자: 김영희\n담임 교사: 이수진\n주소: 서울특별시 서초구 반포대로 12").text;
  for (const raw of ["김민지", "20231234", "김영희", "이수진", "반포대로"]) assert.ok(!fields.includes(raw), `${raw}: ${fields}`);
  assert.match(fields, /^성명 \[PERSON_NAME_\d{2}\]$/m);
  assert.match(fields, /^학번 \[STUDENT_ID_\d{2}\]$/m);
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

// PR #7 security review: a pattern is compiled from the registered name on
// every chat turn, and a megabyte-long name held the process for seconds.
test("a registered name past the bound is never made into a pattern", () => {
  const huge = Array.from({ length: 150_000 }, (_, i) => `Ab${i % 10}`).join(" ");
  const started = process.hrtime.bigint();
  const { text } = redactProviderText("MINJI PARK asked about AP Biology.", { knownNames: [huge] });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(text, "MINJI PARK asked about AP Biology.");
  assert.ok(ms < 250, `took ${ms} ms`);
  // Seven parts is not a name either; a real one at the bound still works.
  assert.equal(redactProviderText("Ana Bo Cy Di Ed Fa Gu", { knownNames: ["Ana Bo Cy Di Ed Fa Gu"] }).text, "Ana Bo Cy Di Ed Fa Gu");
  const long = `${"Maria".padEnd(49, "a")} ${"Lopez".padEnd(50, "z")}`;
  assert.equal(long.length, MAX_REGISTERED_NAME_CHARS);
  assert.doesNotMatch(redactProviderText(`Heading: ${long}`, { knownNames: [long] }).text, /Maria/);
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

// ─── Adversarial cases (PR #7) ───
// An adversarial pass over the first version of the identity patterns
// confirmed these inputs broken: student writing altered, academic figures
// swallowed, identifiers let through. Identities are invented.
const UNCHANGED = [
  "모의고사 국수영탐 2 1 2 1 받았어요. 수시 최저로 3합 6 맞출 수 있을까요?",
  "혹시 내신으로 1.5면 서울대 지균 가능한가요?",
  "축구 주장으로 2년 동안 활동했어요. 이거 리더십으로 쓸 수 있을까요?",
  "교내 설문조사 실시 결과로 120명의 응답을 분석하여 급식 개선안을 제시함.",
  "물리학Ⅰ: 역학적 에너지 보존을 탐구 주제로 2차시 발표를 진행함.",
  "정시는 가군 연세대로 1개, 나군 고려대로 1개 쓸래요. 다군은 어디가 좋을까요?",
  "2026학년도 수시 모집요강으로 1차 서류 70% 면접 30%래요",
  "커먼앱에 쓰는 이메일 주소: 학교 계정으로 써야 하나요, 개인 계정으로 써야 하나요?",
  "제 내신 현주소: 1학년 2.1 2학년 1.8 이면 상향 가능할까요?",
  "동아리 이름: 과학탐구반 (2학년 때 부장)",
  "듣고 싶은 과목 이름: 미적분, 기하, 물리학Ⅱ",
  "보호자: 할머니 (부모님은 해외에 계세요)",
  "화학 연구 과제로 2학년 2학기에 촉매 반응을 조사함.",
  "학교장 추천전형으로 지원하려고요",
  "I got deferred in Early Action from Georgetown. Should I send a letter of continued interest?",
  "Planned monthly birthday parties for 25 residents at a senior living center; led 3 Blood Drive events.",
  "Do B students with 1400 SAT scores get into UCLA?",
  "This is what happened:\nPrincipal: you are suspended for 2 days for the group chat\nMe: ok",
  "What do I put for Legal name: my passport name or the name on my transcript?",
  "My permanent address: Texas, but I live in Seoul for school. Do I count as in-state for UT Austin?",
  "My schedule: Period 1 AP Calc BC Mr. Lee, Period 2 AP Bio Dr. Kim, Period 3 APUSH",
  "Class Size Rank Graduation Year\n412 12 2026",
  "Should I take AP Computer Science A (Course ID: 1220) or AP Stats (Course ID: 1310)?",
  "Grade 10 2024-2025\nWorld History A 1.0\nReligious St. B+ 0.5\nBiology A- 1.0",
  "Test Section Score Percentile Year\nSAT Math 780 99 2025",
  "Date of Birth:\nGrade 11          Cumulative GPA 3.86",
  "\n1 AP Calculus BC Dr. Nguyen Rm 204\n2 AP Physics C Dr. Patel Rm 118",
  "Student: What should I list first, AP Bio or Robotics?",
  "Counselor: How many APs did you take?\nStudent: Seven so far.",
  // Second round: a name is also the whole field.
  "Name: Drama Club\nPosition: Stage Manager",
  "First: Draft UChicago essay",
  "Father: Taxi Driver",
  "Interviewer: Tell me about yourself.\nStudent: Sure! I'm a junior who loves organic chemistry.",
  "Counselor: So, which schools are on your list?\nStudent: Well, I have Michigan, UCLA and Rice.\nCounselor: Great, let's talk about Rice.",
  "Advice from my counselor: Apply Early Action to Michigan and Regular to the rest.",
  "Parents: Divorced, I live with my mom\nFather: Deceased\nMother: Registered Nurse",
  "Mother: Korean citizen\nFather: US citizen",
  "Finding My Voice\nMy English teacher once told me I mumbled.",
  "Won 2 First Place awards at regional DECA and 1 Second Place trophy.",
  "Hosted 8 Story Circle nights at the library.",
  "Name: Varsity Soccer\nRole: Captain\nHours: 10/wk   |   Family: Single Mom, two younger brothers",
  "Are birthdate 2009 juniors eligible for the summer program?",
  "Birthday 2026 decisions: when do RD results come?",
  "Join the info session: Meeting ID: 845 2231 0098, Passcode: 2026",
  "커먼앱 Legal name: 여권 영문 이름 그대로 써야 하나요?",
  "면접 연습 대본 봐주세요\nCounselor: 왜 이 전공을 선택했나요?\nStudent: 어릴 때부터 물리 실험을 좋아했어요",
  "제 내신 현주소: 서울 소재 대학은 무리인가요?",
  "커먼앱 이메일 주소: 학교 계정이면 졸업 후에 막히는데 혹시 진로 상담 메일도 거기로 와요?",
  "활동 1\n이름: 방송부\n역할: 부장\n시간: 주 3시간",
  "보호자: 엄마가 반대해요",
  "담임: 생기부에 리더십 써주신대요",
  "필요 서류: 자기소개서, 학교장 확인서",
  "정시 계획: 서울 가군 연세대로 1, 나군 고려대로 1, 다군은 미정",
  "학번: 2023학번이면 몇 학년이에요?",
  "Grade: 09 2023-2024 / Grade 09 2022-2023 Grade 10 2023-2024\nEnglish 9 A 1.0 Biology A- 1.0\nTerm 01 2025-2026",
  "Hours: 10/wk   |   Emergency contact: Mom",
];

const MASKED = [
  // [input, identity values that must be gone, academic text that must stay]
  ["Student: Ellis, Jordan A Student ID: 204871\nAddress: 1427 Maple Ridge Rd Grade: 11\nSpringfield, IL 62704 Birthdate: 03/04/2008\nCounselor: Dana Whitfield Cumulative GPA: 3.86\nPrincipal: Dr. Helen Moore Weighted GPA: 4.21\nAP Chemistry A 1.0",
    ["Ellis, Jordan", "204871", "Maple Ridge", "03/04/2008", "Dana Whitfield", "Helen Moore"], ["Cumulative GPA: 3.86", "Weighted GPA: 4.21", "Grade: 11", "AP Chemistry A 1.0"]],
  ["Name:\tJordan Ellis\tGrade:\t11\nHome Address:\t1427 Maple Ridge Rd, Springfield, IL 62704\tCumulative GPA:\t3.86\nCounselor:\tDana Whitfield\tClass Rank:\t15 / 412",
    ["Jordan Ellis", "Maple Ridge", "Dana Whitfield"], ["Grade:\t11", "Cumulative GPA:\t3.86", "Class Rank:\t15 / 412"]],
  ["Name: Jordan | Grade: 11 | GPA: 3.86 | SAT: 1480", ["Jordan"], ["Grade: 11 | GPA: 3.86 | SAT: 1480"]],
  ["Address: 100 Main St, Springfield, IL 62704 CEEB Code: 141234", ["100 Main St"], ["CEEB Code: 141234"]],
  ["Tel: (217) 555-0142 2025-2026 Official Transcript", ["555-0142"], ["2025-2026 Official Transcript"]],
  ["Class of 2026 Banpo-daero 58, Seocho-gu, Seoul\nGrade: 11 Tel +82-2-3015-8500", ["Banpo-daero 58", "3015-8500"], ["Class of 2026", "Grade: 11"]],
  ["Student Name:\nMinji Park\nStudent ID:\n204871\nDate of Birth:\n03/04/2008\nCounselor:\nRachel Lin\nCumulative GPA:\n3.86",
    ["Minji Park", "204871", "03/04/2008", "Rachel Lin"], ["Cumulative GPA:\n3.86"]],
  ["Student: Minji Park    Preferred: Grace\nDate of Birth (MM/DD/YYYY): 03/04/2008\nCounselor Name: Rachel Lin\nCounselor's Signature: Rachel Lin\nPhone (555) 867-5309 ext. 214\nSchool Address: 2210 Lakeshore Pkwy, Fairview, OH 44120",
    ["Minji Park", "Grace", "03/04/2008", "Rachel Lin", "867-5309", "Lakeshore"], []],
  ["Tel +82 2 555 0142   Fax +82 2 555 0143\nStudent: PARK, MINJI          Date of Birth: 4 March 2008\nIB Diploma Programme Coordinator: Ms. Ana Duarte\nUniversity Counsellor: Ms. Rachel Lin",
    ["555 0142", "555 0143", "PARK, MINJI", "4 March 2008", "Ana Duarte", "Rachel Lin"], ["IB Diploma Programme Coordinator:"]],
  ["성 적 증 명 서 (Transcript)\n성명(Name) : 박민지\n생 년 월 일 : 2008. 03. 04.\n주민등록번호 : 080304-*******\n학 번 : 20230512\n위와 같이 증명함.\n2026년 11월 20일\n한빛고등학교장  김철수  [직인]",
    ["박민지", "2008. 03. 04", "080304", "20230512", "김철수"], ["2026년 11월 20일", "위와 같이 증명함"]],
  ["Parent/Guardian: Daniel and Sora Park\nMother: Sora Choi\nFather: Daniel Park", ["Daniel", "Sora"], []],
  ["Fairview High School  |  (555) 867-5309  |  Fax (555) 867-5310", ["867-5309", "867-5310"], ["Fairview High School"]],
  ["Student ID 204871     Grade 12     CEEB 361234\nSASID: 10483726\nPerm #: 204871", ["204871", "10483726"], ["CEEB 361234", "Grade 12"]],
  ["1420 Juniper Way\nFairview, OH 44120\n88 Willow Creek Circle, Apt 2", ["Juniper", "Willow Creek"], []],
  ["서울특별시 서초구 반포대로 12 (반포동)\n경기도 수원시 장안구 정조로 940", ["반포대로 12", "정조로 940"], []],
  ["Counselor: Mrs. Rachel Lin   |   Student Name: Frank Lee", ["Rachel Lin", "Frank Lee", "Mrs"], []],
  ["기숙사 주소: 경기도 수원시 영통구 월드컵로 206 이렇게 써요?", ["월드컵로 206"], ["이렇게 써요?"]],
  ["Name: 박민지  Grade: 11", ["박민지"], ["Grade: 11"]],
  ["Rachel Lin\nDirector of College Counseling", ["Rachel Lin"], ["Director of College Counseling"]],
  ["Student Name: María José García López\nStudent: Sofía Hernández", ["María", "García", "Sofía"], []],
  ["Student Name: Lucas van der Berg\nCounselor: Ms. Ana de la Cruz", ["Lucas", "Berg", "Ana", "Cruz"], []],
  ["Grade: 11 Counselor: Dana Whitfield\nCumulative GPA: 3.86 Parent/Guardian: Mrs. Sora Ellis\nWeighted GPA: 4.21 Principal: Dr. Helen Moore\nGPA: 3.86 Student: Jordan Ellis",
    ["Dana Whitfield", "Sora Ellis", "Helen Moore", "Jordan Ellis"], ["Grade: 11", "Cumulative GPA: 3.86", "Weighted GPA: 4.21", "GPA: 3.86"]],
  ["Student: Jordan Ellis Class of 2027\nCounselor: Dana Whitfield Class Rank 15 of 412\nPrincipal: Dr. Helen Moore Economics A 0.5",
    ["Jordan Ellis", "Dana Whitfield", "Helen Moore"], ["Class of 2027", "Class Rank 15 of 412", "Economics A 0.5"]],
  ["Parent 1: Daniel Park\nParent 2: Sora Choi\nParent(s)/Guardian(s): Daniel and Sora Park\nEmergency Contact Name: Sora Choi\nName (Last, First, M.I.): Ellis, Jordan A.",
    ["Daniel", "Sora", "Ellis, Jordan"], []],
  ["Address: 1427 Maple Ridge Rd Grade 11 2025-2026\nHome Address: 1427 Maple Ridge Rd, Springfield, IL 62704 Weighted GPA 4.21 Class Rank 15/412",
    ["Maple Ridge"], ["Grade 11 2025-2026", "Weighted GPA 4.21 Class Rank 15/412"]],
];

test("adversarial student writing and record lines pass the identity patterns unchanged", () => {
  for (const text of UNCHANGED) assert.equal(redactProviderText(text).text, text, text);
});

test("adversarial record headers lose their identifiers and keep their figures", () => {
  for (const [input, gone, kept] of MASKED) {
    const { text } = redactProviderText(input);
    for (const raw of gone) assert.ok(!text.includes(raw), `${raw} survived in: ${text}`);
    for (const keep of kept) assert.ok(text.includes(keep), `${keep} lost from: ${text}`);
  }
});

test("the registered name is masked with a middle name, an initial or another romanization", () => {
  const { text } = redactProviderText("MINJI GRACE PARK\nClass of 2027\nMinji G. Park\nStudent: PARK, MIN-JI\nPark Min-ji (Grace)", { knownNames: ["Minji Park"] });
  assert.doesNotMatch(text, /minji|min-ji/i);
  assert.match(text, /Class of 2027/);
  assert.match(text, /\(Grace\)/);
  // A word between the parts is not a middle name, and a title before the
  // family name is someone else.
  for (const clean of ["Hi, I'm Minji from Park City, Utah. Is Utah a good fit?", "The two finalists were Minji and Park Jiwoo.", "Hi Ms. Park, Minji here! Could you write my rec?", "Park Avenue and Min Street; Jim Park; Minji alone"]) {
    assert.equal(redactProviderText(clean, { knownNames: ["Minji Park"] }).text, clean, clean);
  }
  // Korean order and syllable splits; accents and their absence.
  assert.doesNotMatch(redactProviderText("MINJI PARK\nPark Min-ji\nMin-Ji Park\nPARK MIN JI", { knownNames: ["Park Min Ji"] }).text, /min|park/i);
  assert.doesNotMatch(redactProviderText("García López, María\nGARCIA LOPEZ, MARIA\nMaría García López", { knownNames: ["María García López"] }).text, /mar[ií]a|garc[ií]a/i);
});

// A field start that rescanned whitespace made every field pattern
// quadratic: 200,000 spaces in an attachment held the server for minutes.
// Each of these takes about 10-25 ms; the bound leaves room for a slow CI.
test("the identity patterns stay linear on a large attachment", () => {
  const N = 200_000;
  for (const text of [
    " ".repeat(N),
    " \t".repeat(N / 2),
    ("Name: " + "Ab Cd Ef Gh Ij ".repeat(4) + "\n").repeat(N / 70),
    "a b c d Counselor e f g h Director ".repeat(N / 34),
    "Date of Birth: 1 2 3 4 5 6 ".repeat(N / 27),
    "서울 수시 최저로 성명 보호자 학번 주소 ".repeat(N / 22),
  ]) {
    const started = process.hrtime.bigint();
    redactProviderText(text, { knownNames: ["Minji Grace Park"] });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 1500, `${ms} ms on ${JSON.stringify(text.slice(0, 30))}`);
  }
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
