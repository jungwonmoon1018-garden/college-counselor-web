import test from "node:test";
import assert from "node:assert/strict";
import {
  formatProfileForModel,
  checkProfileFidelity,
  buildFidelityCorrection,
  buildFidelityFootnote,
  detectSchoolMentions,
  formatVerifiedDataBlock,
  unresolvedSchoolNames,
} from "../chat/chat-grounding.js";

const profile = {
  gpaUnweighted: 3.82,
  gpaWeighted: 4.31,
  testScores: [{ test: "sat", totalScore: 1450, date: "2026-03" }, { test: "sat_subject", subject: "Math Level 2", totalScore: 780 }],
  courses: [
    { name: "English 9", type: "regular", grade: "A", year: "freshman" },
    { name: "Chemistry", type: "honors", grade: "A-", year: "10" },
    { name: "Computer Science A", type: "ap", grade: "A", year: "sophomore" },
    { name: "English Language and Composition", type: "ap", grade: "B+", year: "junior" },
    { name: "Statistics", type: "ap", grade: "A", year: "junior" },
    { name: "Physics C: Mechanics", type: "ap", grade: "B", year: "junior", semester: "fall" },
    { name: "Calculus BC", type: "ap", grade: "IP", year: "senior" },
    { name: "Health", type: "elective", year: "9" },
  ],
  apScores: [{ exam: "Computer Science A", score: 5, year: 2025 }, { exam: "Statistics", score: 4, year: 2026 }],
  activities: [
    { name: "Robotics Club", role: "Team Captain", category: "robotics", hoursPerWeek: 8, weeksPerYear: 30, description: "Led a 12-student FRC team.", grades: ["sophomore", "junior"], timing: "school_year" },
    { name: "National History Day", role: "Participant", category: "academic", hoursPerWeek: 4, timing: "both" },
  ],
  majorInterest: "Computer Science",
  goals: ["MIT", { name: "Carnegie Mellon University", unitId: "211440" }],
};

test("profile block renders one course per line with year, level, and grade legend", () => {
  const text = formatProfileForModel(profile);
  assert.match(text, /^STUDENT PROFILE \(the student's saved record/);
  assert.match(text, /GPA: 3\.82 unweighted, 4\.31 weighted/);
  assert.match(text, /Test scores: SAT 1450 \(taken 2026-03\); SAT Subject Test \(Math Level 2\) 780/);
  assert.match(text, /Courses \(8 recorded; grade legend:/);
  assert.match(text, /  - freshman: English 9 — regular — grade A/);
  assert.match(text, /  - sophomore: Chemistry — Honors — grade A-/);
  assert.match(text, /  - sophomore: AP Computer Science A — AP — grade A/);
  assert.match(text, /  - junior: AP Physics C: Mechanics — AP — grade B \(fall semester\)/);
  assert.match(text, /  - senior: AP Calculus BC — AP — in progress \(no final grade yet\)/);
  assert.match(text, /  - freshman: Health — elective — grade not recorded/);
  // AP exam scores read the survey's `exam` field (the old code read
  // `.subject` and produced "undefined: 5").
  assert.match(text, /AP exam scores: AP Computer Science A: 5 \(2025\); AP Statistics: 4 \(2026\)/);
  assert.match(text, /  - Robotics Club — Team Captain \(robotics\); 8 hrs\/wk × 30 wks\/yr; years: sophomore, junior; "Led a 12-student FRC team\."/);
  assert.match(text, /  - National History Day — Participant \(academic\); 4 hrs\/wk; timing: both/);
  assert.match(text, /Goals \/ target schools: MIT, Carnegie Mellon University/);
  assert.doesNotMatch(text, /undefined/);
});

test("profile block truncates long course lists explicitly instead of silently", () => {
  const many = { courses: Array.from({ length: 45 }, (_, i) => ({ name: `Course ${i + 1}`, type: "regular", grade: "A", year: "junior" })) };
  const text = formatProfileForModel(many);
  assert.match(text, /Courses \(45 recorded/);
  assert.match(text, /\(\+5 more courses not shown/);
  assert.equal(formatProfileForModel(null), "");
});

test("fidelity check catches misstated grades, GPA, test and AP scores", () => {
  const answer = [
    "That AP Computer Science A score of 5, combined with your A in AP English Language and Composition, shows range.",
    "Your 3.9 GPA and your SAT of 1500 put you in range.",
    "You got a 3 on AP Statistics. Honors Chemistry (A-) also helps.",
    "Your AP Calculus BC A shows momentum.",
  ].join(" ");
  const { contradictions } = checkProfileFidelity(answer, profile);
  const keys = contradictions.map((c) => `${c.kind}:${c.item}:${c.stated}`);
  assert.deepEqual(keys, [
    "course_grade:AP English Language and Composition:A",
    "course_grade:AP Calculus BC:A",
    "gpa:GPA:3.9",
    "sat:SAT:1500",
    "ap_score:AP Statistics exam:3",
  ]);
  assert.equal(contradictions.find((c) => c.kind === "course_grade" && c.item === "AP Calculus BC").actual, "in progress — no final grade recorded");
  assert.equal(contradictions.find((c) => c.kind === "gpa").actual, "3.82 unweighted / 4.31 weighted");

  const correction = buildFidelityCorrection(contradictions);
  assert.match(correction, /^FIDELITY CORRECTION/);
  assert.match(correction, /- AP English Language and Composition: recorded grade B\+ \(the reply said A\)/);
  assert.match(correction, /- AP Calculus BC: in progress, with no final grade yet \(the reply said A\)/);
  assert.match(correction, /- GPA: recorded 3\.82 unweighted \/ 4\.31 weighted \(the reply said 3\.9\)/);
  const footnote = buildFidelityFootnote(contradictions);
  assert.match(footnote, /^\n\n_Correction from your saved profile/);
  assert.match(footnote, /- SAT: recorded 1450 \(the reply said 1500\)/);
  assert.match(buildFidelityFootnote(contradictions, "ko"), /저장된 프로필 기준 정정/);
});

// An exam is checked under every name the AP catalog knows for it, and a
// retaken exam has every recorded score as a true one: a 4 stated for a
// Calculus AB recorded as 3 and then 4 used to be "corrected" (2026-10-09).
test("AP scores are checked under every name for the exam, and a retake's scores are all true", () => {
  const retaken = { apScores: [
    { exam: "Calculus AB", score: 3, year: 2025 },
    { exam: "Calculus AB", score: 4, year: 2026 },
    { exam: "US History", score: 5, year: 2026 },
  ] };
  assert.deepEqual(checkProfileFidelity("You scored a 4 on AP Calc AB after retaking it.", retaken).contradictions, []);
  assert.deepEqual(checkProfileFidelity("You earned a 3 on AP Calculus AB the first time.", retaken).contradictions, []);
  assert.deepEqual(checkProfileFidelity("You got a 5 on AP United States History.", retaken).contradictions, []);
  const wrong = checkProfileFidelity("You scored a 5 on AP Calculus AB, and you got a 3 on APUSH.", retaken).contradictions;
  assert.deepEqual(wrong.map((c) => `${c.item}:${c.stated}:${c.actual}`), [
    "AP Calculus AB exam:5:4 and 3 (the exam was taken 2 times)",
    "AP US History exam:3:5",
  ]);
  assert.match(buildFidelityCorrection(wrong), /- AP Calculus AB exam: recorded score 4 and 3 \(the exam was taken 2 times\) \(the reply said 5\)/);
});

test("SAT section scores reach the model and are checked as sections, not totals", () => {
  const withSections = {
    ...profile,
    testScores: [{ test: "sat", totalScore: 1500, date: "2026-03", sections: { math: 780, readingWriting: 720 } }],
  };
  const block = formatProfileForModel(withSections);
  assert.match(block, /Test scores: SAT 1500 \(Reading & Writing 720, Math 780\) \(taken 2026-03\)/);

  // A correct section figure is not a wrong total; a wrong section figure is
  // reported against the recorded sections.
  const faithful = checkProfileFidelity("Your SAT Math 780 is at the top of Brown's band, and your SAT of 1500 fits.", withSections);
  assert.deepEqual(faithful.contradictions, []);
  const wrong = checkProfileFidelity("Your SAT Math score of 800 is perfect.", withSections);
  assert.equal(wrong.contradictions.length, 1);
  assert.equal(wrong.contradictions[0].item, "SAT section");
  assert.equal(wrong.contradictions[0].stated, "800");
  assert.equal(wrong.contradictions[0].actual, "Reading & Writing 720, Math 780");
  // Without recorded sections a section claim is reported against the total.
  const noSections = checkProfileFidelity("Your SAT Math 780 is strong.", { ...profile, testScores: [{ test: "sat", totalScore: 1450 }] });
  assert.equal(noSections.contradictions.length, 1);
  assert.equal(noSections.contradictions[0].actual, "total 1450, no section scores recorded");
});

test("fidelity check accepts a faithful answer and ignores generic statistics", () => {
  const answer = [
    "Your B+ in AP English Language and Composition and your A in AP Statistics, plus a 5 on AP Computer Science A and a 4 on AP Statistics, are real evidence.",
    "Your 3.82 GPA (4.31 weighted) and 1450 SAT are competitive; on a 4.0 scale your 3.8 is strong.",
    "Most T20s admit GPAs 3.9+ and SATs in the 1500–1550 range, so you should aim for a 1550 on the SAT.",
    "AP Calculus BC is in progress. A strong foundation in Chemistry helps, and a solid B in AP Physics C: Mechanics is fine.",
    "AP Calculus BC (3 credits) counts toward your requirements. Take the ACT in 2 months if you want another data point.",
  ].join(" ");
  assert.deepEqual(checkProfileFidelity(answer, profile).contradictions, []);
  assert.deepEqual(checkProfileFidelity("", profile).contradictions, []);
  assert.deepEqual(checkProfileFidelity("Your A in AP Statistics", null).contradictions, []);
});

test("fidelity check flags a grade for a course that is not on the record", () => {
  const { contradictions } = checkProfileFidelity(
    "Your A in AP Chemistry and your B+ in AP English Language and Composition both matter; AP Biology (A-) shows range, and your A in AP Statistics is solid.",
    profile,
  );
  assert.deepEqual(contradictions.map((c) => [c.kind, c.item, c.stated]), [
    ["course_not_on_record", "AP Chemistry", "A"],
    ["course_not_on_record", "AP Biology", "A-"],
  ]);
  assert.match(buildFidelityCorrection(contradictions), /AP Chemistry: not on the student's record at all \(the reply gave it a grade of A\)/);
  // Courses on the record (with or without the AP prefix) never trip it.
  assert.deepEqual(checkProfileFidelity("Your A in AP Statistics and your A- in Honors Chemistry are strong.", profile).contradictions, []);
});

test("fidelity check flags scores the profile does not have", () => {
  const bare = { courses: [{ name: "Biology", type: "honors" }], testScores: [], apScores: [] };
  const { contradictions } = checkProfileFidelity("Your SAT of 1400 and your 34 ACT are solid, and your A in Honors Biology stands out.", bare);
  assert.deepEqual(contradictions.map((c) => [c.kind, c.stated, c.actual]), [
    ["course_grade", "A", "no grade recorded"],
    ["sat", "1400", "no SAT score recorded"],
    ["act", "34", "no ACT score recorded"],
  ]);
});

test("school mentions resolve aliases and official names, case-sensitively for short ones", () => {
  const known = ["Carnegie Mellon University", "Boston College", "Rice University", "Union College"];
  assert.deepEqual(
    detectSchoolMentions("How do I fit MIT and stanford? Also UIUC vs bc, my BU essay for Boston College, and Carnegie Mellon University. I like rice and union.", { knownNames: known }),
    [
      "Massachusetts Institute of Technology",
      "Stanford University",
      "University of Illinois Urbana-Champaign",
      "Boston University",
      "Boston College",
      "Carnegie Mellon University",
    ],
  );
  assert.deepEqual(detectSchoolMentions("What ECs should I add?", { knownNames: known }), []);
  assert.deepEqual(detectSchoolMentions("MIT", { knownNames: known, max: 1 }), ["Massachusetts Institute of Technology"]);
  // A short code after a course name is an AP exam, not a school.
  assert.deepEqual(detectSchoolMentions("Does my AP Calculus BC grade and AP Physics C score matter?", { knownNames: known }), []);
  assert.deepEqual(detectSchoolMentions("I took Calc BC; is BC a match for me?", { knownNames: known }), ["Boston College"]);
});

test("verified data block formats baseline, CDS, and research facts and is empty without data", () => {
  const block = formatVerifiedDataBlock({
    schools: [
      {
        name: "Stanford University",
        state: "CA",
        baseline: { acceptance_rate: 0.039, sat_25: 1510, sat_75: 1580, act_25: 34, act_75: 35, enrollment: 7761, tuition_in: 62484, tuition_out: 62484, data_year: 2023, source: "NCES IPEDS" },
        cds: { school: "Stanford University", yearLabel: "2024-25", overallAdmitRate: 0.0361, enrolledSAT: { p25: 1510, p75: 1580 }, testPolicy: "test_required", c7: { rigor: "very_important", ec: "very_important", interview: "important", test_scores: "considered" }, sourceUrl: "https://example.edu/cds" },
        cdsValidated: true,
      },
      { name: "Nowhere U", baseline: null, cds: null },
    ],
    facts: [{ entity_name: "Stanford University", fact_key: "rea_deadline", fact_value: "Restrictive Early Action deadline: November 1", source_domain: "admission.stanford.edu", academic_year: "2026-27" }],
  });
  assert.match(block, /^VERIFIED DATA \(the ONLY statistics you may cite/);
  // Tuition carries no "$": the provider redaction would mask it as an
  // income token before the model ever saw the number.
  assert.match(block, /- Stanford University \(CA\): acceptance rate 3\.9%; SAT middle 50% 1510–1580; ACT middle 50% 34–35; enrollment 7,761; tuition in-state 62,484 USD \/ out-of-state 62,484 USD \[Source: NCES IPEDS, data year 2023\]/);
  assert.doesNotMatch(block, /\$/);
  assert.match(block, /  admit rate 3\.6%; enrolled SAT middle 50% 1510–1580; test policy: test required; admissions factors rated very important: course rigor, extracurriculars; rated important: interview \[Source: Stanford University Common Data Set 2024-25 \(validated against ground truth\), https:\/\/example\.edu\/cds\]/);
  assert.match(block, /- Stanford University: rea deadline — Restrictive Early Action deadline: November 1 \[Source: admission\.stanford\.edu, 2026-27\]/);
  assert.doesNotMatch(block, /Nowhere U/);
  assert.equal(formatVerifiedDataBlock({ schools: [{ name: "X", baseline: null, cds: null }], facts: [] }), "");
  assert.equal(formatVerifiedDataBlock(), "");

  // A repository / Drive download URL is not shown as the source link — the
  // label names the document and the link stays off the student's screen.
  const drive = formatVerifiedDataBlock({
    schools: [{
      name: "Stanford University",
      baseline: null,
      cds: { school: "Stanford University", yearLabel: "2025-26", overallAdmitRate: 0.036, sourceUrl: "https://drive.google.com/uc?export=download&id=abc123" },
      cdsValidated: true,
      policyLine: "Admissions policy (official site, checked 2026-09-03): test policy — test scores required; Regular Decision deadline 2027-01-05 [Source: https://admission.stanford.edu/apply/deadlines]",
    }],
  });
  assert.match(drive, /- Stanford University: admit rate 3\.6%; test policy: not read from the document \[Source: Stanford University Common Data Set 2025-26 \(validated against ground truth\), official PDF on file\]/);
  assert.doesNotMatch(drive, /drive\.google\.com/);
  assert.match(drive, /\n  Admissions policy \(official site, checked 2026-09-03\): test policy — test scores required/);
  // A school with only a scouted policy line still gets an entry.
  assert.match(formatVerifiedDataBlock({ schools: [{ name: "Elm College", baseline: null, cds: null, policyLine: "Admissions policy (official site, checked 2026-09-03): application fee none [Source: https://elm.edu/apply]" }] }), /- Elm College: Admissions policy/);

  // The wider CDS read (sections C9/C10/C13/C14/C21/C22/H2/I2) renders as
  // part of the same CDS line; the reported closing dates say which cycle
  // they describe and carry no year.
  const wide = formatVerifiedDataBlock({
    schools: [{
      name: "Boston University",
      baseline: null,
      cds: {
        school: "Boston University", yearLabel: "2025-26", overallAdmitRate: 0.108, b1: { applied: 78749, admitted: 8505, enrolled: 3137 }, sourceUrl: "https://www.bu.edu/cds.pdf",
        extras: {
          satSections: { ebrw: { p25: 700, p75: 750 }, math: { p25: 720, p75: 780 } },
          submitting: { satPct: 36, actPct: 10 },
          classRank: { topTenthPct: 86, topQuarterPct: 98 },
          applicationFeeUsd: 80,
          earlyDecision: { applications: 6907, admitted: 2165, admitRate: 0.3135 },
          dates: { regularClosing: { mmdd: "01-05", raw: "January 5" }, edClosing: { mmdd: "11-01", raw: "November 1" }, edIIClosing: { mmdd: "01-05", raw: "January 5" }, aidDeadline: { mmdd: "01-05", raw: "January 5 (November 1 for ED)" } },
          aid: { averagePackageFirstYearUsd: 68926 },
          studentFacultyRatio: "10 to 1",
        },
      },
      cdsValidated: false,
    }],
  });
  assert.match(wide, /enrolled SAT sections middle 50%: Reading & Writing 700–750, Math 720–780/);
  assert.match(wide, /share of enrolled students who submitted scores: SAT 36%, ACT 10%/);
  assert.match(wide, /86% of enrolled students ranked in the top tenth of their class \(98% top quarter\)/);
  assert.match(wide, /Early Decision: 6,907 applied, 2,165 admitted \(31\.4%\)/);
  // The applicant counts behind the admit rate ride along, so "how many
  // applied" is answerable from the block.
  assert.match(wide, /admit rate 10\.8% \(78,749 applied, 8,505 admitted, 3,137 enrolled\)/);
  assert.match(wide, /application fee 80 USD; average first-year need-based aid package 68,926 USD; student-to-faculty ratio 10 to 1/);
  assert.match(wide, /closing dates the school reported for its CDS cycle \(month\/day; confirm this year's dates on its admissions page\): Regular Decision 01\/05, Early Decision 11\/01, Early Decision II 01\/05, aid filing deadline 01\/05/);
  assert.doesNotMatch(wide, /\$/);
});

test("subscores of every test and the class rank reach the model", () => {
  const rich = {
    ...profile,
    classRank: { rank: 12, size: 400 },
    testScores: [
      { test: "act", totalScore: 33, sections: { english: 35, math: 31, reading: 34, science: 32, writing: 9 } },
      { test: "toefl", totalScore: 108, sections: { reading: 28, listening: 27, speaking: 25, writing: 28 } },
      { test: "ielts", totalScore: 7.5, sections: { listening: 8, reading: 7.5, writing: 7, speaking: 7.5 } },
      { test: "psat", totalScore: 1380, date: "2025-10", sections: { readingWriting: 690, math: 690 } },
    ],
  };
  const block = formatProfileForModel(rich);
  assert.match(block, /Test scores: ACT 33 \(English 35, Math 31, Reading 34, Science 32, Writing 9\); TOEFL 108 \(Reading 28, Listening 27, Speaking 25, Writing 28\); IELTS 7\.5 \(Listening 8, Reading 7\.5, Writing 7, Speaking 7\.5\); PSAT 1380 \(Reading & Writing 690, Math 690\) \(taken 2025-10\)/);
  assert.match(block, /\nClass rank: top 3% \(12 of 400\)/);

  // A correct ACT subscore is not a wrong composite; a wrong subscore is
  // reported against the recorded sections.
  assert.deepEqual(checkProfileFidelity("Your ACT Math 31 is the section to lift; your ACT of 33 is inside the band.", rich).contradictions, []);
  const wrongSection = checkProfileFidelity("Your ACT English score of 36 is perfect.", rich);
  assert.equal(wrongSection.contradictions.length, 1);
  assert.equal(wrongSection.contradictions[0].item, "ACT section");
  assert.equal(wrongSection.contradictions[0].actual, "English 35, Math 31, Reading 34, Science 32, Writing 9");
  const wrongComposite = checkProfileFidelity("Your ACT of 35 is strong.", rich);
  assert.equal(wrongComposite.contradictions[0].item, "ACT");
  assert.equal(wrongComposite.contradictions[0].actual, "33");

  // Class rank: a claim of better standing is a contradiction, a looser one
  // ("top 10%" for a top-3% student) is still true, and a figure for a
  // student with no rank on record is invented.
  assert.deepEqual(checkProfileFidelity("Your class rank in the top 10% helps, and your class rank of top 3% is excellent.", rich).contradictions, []);
  const better = checkProfileFidelity("You are ranked in the top 1% of your class.", rich);
  assert.equal(better.contradictions.length, 1);
  assert.equal(better.contradictions[0].kind, "class_rank");
  assert.equal(better.contradictions[0].stated, "top 1%");
  assert.equal(better.contradictions[0].actual, "top 3% (12 of 400)");
  assert.match(buildFidelityFootnote(better.contradictions), /Class rank: recorded top 3% \(12 of 400\) \(the reply said top 1%\)/);
  assert.equal(checkProfileFidelity("Your class rank in the top 5% is a real strength.", profile).contradictions.length, 1);
  assert.deepEqual(checkProfileFidelity("Schools like this admit mostly students ranked in the top 10%.", profile).contradictions, []);
});

test("the wider CDS read renders ACT sections, score distributions and the GPA distribution", () => {
  const block = formatVerifiedDataBlock({
    schools: [{
      name: "Stanford University",
      baseline: null,
      cds: {
        school: "Stanford University", yearLabel: "2024-25", overallAdmitRate: 0.0361,
        enrolledGPA: { p25: 3.75, p75: 4, avg: 3.94 },
        extras: {
          satSections: { ebrw: { p25: 740, p50: 760, p75: 780 }, math: { p25: 770, p50: 790, p75: 800 } },
          actSections: { english: { p25: 35, p75: 36 }, math: { p25: 33, p75: 36 }, reading: { p25: 34, p75: 36 }, science: { p25: 33, p75: 36 } },
          scoreDistribution: {
            satComposite: [{ low: 1400, high: 1600, pct: 97.3 }, { low: 1200, high: 1399, pct: 2.5 }, { low: 1000, high: 1199, pct: 0.2 }, { low: 800, high: 999, pct: 0 }],
            actComposite: [{ low: 30, high: 36, pct: 99.1 }, { low: 24, high: 29, pct: 0.6 }, { low: 18, high: 23, pct: 0.3 }],
          },
          classRank: { topTenthPct: 97.8, topQuarterPct: 100, submittedPct: 18.8 },
          gpaDistribution: [{ low: 4, high: 4, pct: 73.3 }, { low: 3.75, high: 3.99, pct: 16.5 }, { low: 3.5, high: 3.74, pct: 6.7 }, { low: 3.25, high: 3.49, pct: 3 }, { low: 3, high: 3.24, pct: 0.3 }, { low: 2.5, high: 2.99, pct: 0.3 }],
          gpa: { average: 3.94, submittedPct: 68.1 },
        },
      },
      cdsValidated: true,
    }],
  });
  assert.match(block, /average enrolled GPA 3\.94; enrolled GPA middle 50% 3\.75–4/);
  assert.match(block, /enrolled ACT sections middle 50%: English 35–36, Math 33–36, Reading 34–36, Science 33–36/);
  assert.match(block, /share of enrolled SAT submitters by total: 1400–1600 97\.3%, 1200–1399 2\.5%, 1000–1199 0\.2%/);
  assert.match(block, /share of enrolled ACT submitters by composite: 30–36 99\.1%, 24–29 0\.6%, 18–23 0\.3%/);
  assert.match(block, /97\.8% of enrolled students ranked in the top tenth of their class \(100% top quarter\); 18\.8% of enrolled students submitted a class rank/);
  assert.match(block, /enrolled high-school GPA distribution: 73\.3% had a 4\.0, 89\.8% had 3\.75 or higher, 96\.5% had 3\.50 or higher \(68\.1% of enrolled students submitted a GPA\)/);
});

test("the remaining CDS sections reach the model as verified data, with money in USD", () => {
  const block = formatVerifiedDataBlock({
    schools: [{
      name: "Indiana University Bloomington", baseline: null,
      cds: {
        school: "Indiana University Bloomington", yearLabel: "2024-25", overallAdmitRate: 0.7821, sourceUrl: "https://iu.edu/cds.pdf",
        extras: {
          enrollment: { undergraduates: 36833 },
          retention: { firstYearPct: 91.3 },
          graduation: { sixYearPct: 80.2, cohort: 2018 },
          waitlist: { offered: 7524, accepted: 3059, admitted: 3041 },
          earlyAction: { applications: 41200, admitted: 30100, admitRate: 0.7306 },
          transfer: { applied: 4130, admitted: 2921, enrolled: 1462 },
          studentLife: { outOfStatePct: 43.2, onCampusPct: 98 },
          costs: { tuitionInStateUsd: 10622, tuitionOutOfStateUsd: 40369, requiredFeesUsd: 1522, foodAndHousingUsd: 13984, academicYear: "2025-2026" },
          aid: { averagePackageFirstYearUsd: 14100, needMetPct: 63.2 },
          classSize: { under20Pct: 34.7 },
        },
      },
      cdsValidated: false,
    }],
  });
  assert.match(block, /36,833 undergraduates; first-year retention 91\.3% per the CDS; six-year graduation rate 80\.2% \(2018 cohort\)/);
  assert.match(block, /wait list: 7,524 offered a place, 3,059 accepted it, 3,041 admitted from it/);
  assert.match(block, /Early Action: 41,200 applied, 30,100 admitted \(73\.1%\)/);
  assert.match(block, /transfer students: 4,130 applied, 2,921 admitted, 1,462 enrolled/);
  assert.match(block, /43\.2% of first-year students come from out of state; 98% of first-year students live on campus/);
  assert.match(block, /tuition in-state 10,622 USD \/ out-of-state 40,369 USD, required fees 1,522 USD, food and housing 13,984 USD \(2025-2026 academic year, per the CDS\)/);
  assert.match(block, /average first-year need-based aid package 14,100 USD/);
  assert.match(block, /average share of financial need met 63\.2%; 34\.7% of class sections have fewer than 20 students/);
  assert.doesNotMatch(block, /\$/);
});

// ─── Attribution (2026-11-03) ─────────────────────────────────────────
// A number counts as the student's only when the clause ties it to them.
// The check used to take every number in a sentence that said "your" and
// "SAT", so a true comparison with a school's verified figure was
// "corrected", and the retry told the model to rewrite the school's number.
const kinds = (text, record) => checkProfileFidelity(text, record).contradictions.map((c) => `${c.kind}:${c.stated}`);
const compared = {
  gpaUnweighted: 3.82,
  gpaWeighted: 4.31,
  testScores: [{ test: "sat", totalScore: 1450 }, { test: "act", totalScore: 33 }],
  courses: [
    { name: "Calculus BC", type: "ap", grade: "IP", year: "senior" },
    { name: "Statistics", type: "ap", grade: "B+", year: "junior" },
  ],
  apScores: [{ exam: "Statistics", score: 4, year: 2026 }],
};

test("a comparison with a school's figure, a target or a hypothetical is not a misstated record", () => {
  const empty = { courses: [], testScores: [], apScores: [] };
  for (const [text, record] of [
    ["Your SAT of 1450 is 60 points below Stanford's 1510.", compared],
    ["Your 1450 SAT is below WashU's 1500.", compared],
    ["Compared with Michigan's 1350, your 1450 SAT is strong.", compared],
    ["Your SAT of 1450 sits in the middle range of 1350 to 1530.", compared],
    ["Your 3.82 GPA is close to Stanford's 3.94.", compared],
    ["Your 3.82 GPA is just under Michigan's 3.9.", compared],
    ["With your 3.82 GPA, you're within Stanford's enrolled GPA range of 3.75–4.0.", compared],
    ["Your 3.82 GPA isn't a perfect 4.0, and that is fine.", compared],
    ["With your 33 ACT and 6 AP courses, you have range.", compared],
    ["You're in grade 11 with an ACT of 33.", compared],
    ["Your ACT of 33 is two points below MIT's 35.", compared],
    ["Your GPA is 0.1 below Stanford's average, and your ACT is 2 short of MIT's 35.", compared],
    ["If your GPA is around 3.8, consider adding rigor.", empty],
    ["Since your school doesn't rank, you won't be ranked in the top 10%.", empty],
    ["An A in AP Calculus BC would help.", compared],
    ["An A in AP Calculus BC this year would help.", compared],
    ["Getting an A in AP Calculus BC this year matters.", compared],
    ["Aim for an A in AP Statistics next semester.", compared],
    ["Aim for a 5 on AP Statistics.", compared],
    ["Many schools need a 5 on AP Statistics.", compared],
    ["A 5 on AP Statistics would earn credit at Michigan.", compared],
    ["Michigan gives credit for a 4 or 5 on AP Statistics.", compared],
  ]) assert.deepEqual(kinds(text, record), [], text);
});

test("a value the reply ties to the student is still checked, even with a modal after it", () => {
  for (const [text, want] of [
    ["Your SAT of 1500 is strong.", ["sat:1500"]],
    ["Your 1500 SAT should help a lot.", ["sat:1500"]],
    ["Your SAT of 1500 is above average.", ["sat:1500"]],
    ["You scored 1500 on the SAT.", ["sat:1500"]],
    ["Your 3.95 GPA would make you competitive.", ["gpa:3.95"]],
    ["You scored a 3 on AP Statistics.", ["ap_score:3"]],
    ["Your A in AP Calculus BC is impressive.", ["course_grade:A"]],
    ["Your A in AP Statistics will help.", ["course_grade:A"]],
    // "with a 3.9 GPA" in a clause whose subject is the student.
    ["Your B+ in AP Statistics is solid, and you scored a 5 on AP Statistics with a 3.9 GPA.", ["gpa:3.9", "ap_score:5"]],
    ["You're in grade 11 with an ACT of 30.", ["act:30"]],
  ]) assert.deepEqual(kinds(text, compared), want, text);
  // Other students' GPA is not the student's.
  assert.deepEqual(kinds("Students with a 3.9 GPA often apply early.", compared), []);
});

// The binders tie only the value right after "your" or "you scored" to the
// student, so the second item of a list ("your 3.95 GPA and 1520 SAT") got
// no retry and no footnote, nor did any item after "your stats (". The
// commonest way a reply states a student's numbers is a list.
test("every value in a list tied to the student is checked, not only the first", () => {
  const record = { gpaUnweighted: 3.72, testScores: [{ test: "sat", totalScore: 1380 }], apScores: [{ exam: "Statistics", score: 4 }] };
  for (const [text, want] of [
    ["With your 3.95 GPA and 1520 SAT, you're a strong candidate.", ["gpa:3.95", "sat:1520"]],
    ["Your GPA of 3.95 and SAT of 1520 are strong.", ["gpa:3.95", "sat:1520"]],
    ["You have a 3.95 GPA, a 1520 SAT, and strong essays.", ["gpa:3.95", "sat:1520"]],
    ["You have a 3.95 GPA, a 1520 SAT and a 5 on AP Biology.", ["gpa:3.95", "sat:1520", "ap_not_on_record:5"]],
    ["Your 1520 SAT and 3.95 GPA are strong.", ["gpa:3.95", "sat:1520"]],
    ["Your stats (3.95 GPA, 1520 SAT) are strong.", ["gpa:3.95", "sat:1520"]],
    ["Your numbers — a 3.95 GPA and a 1520 SAT — are strong.", ["gpa:3.95", "sat:1520"]],
    ["Your 3.72 GPA (4.1 weighted) and 1520 SAT are strong.", ["sat:1520"]],
    ["You scored a 5 on AP Statistics and a 1520 on the SAT.", ["sat:1520", "ap_score:5"]],
    ["You're in range with a 3.95 GPA and a 1520 SAT.", ["gpa:3.95", "sat:1520"]],
    // A modal after a "your" list still states the record, as it does after
    // a single "your 1500 SAT".
    ["Your 3.95 GPA and 1520 SAT should help.", ["gpa:3.95", "sat:1520"]],
    ["학생의 GPA 3.95와 SAT 1520점은 훌륭합니다.", ["gpa:3.95", "sat:1520"]],
    // The recorded values.
    ["With your 3.72 GPA and 1380 SAT, you're a strong candidate.", []],
    ["You have a 3.72 GPA, a 1380 SAT and a 4 on AP Statistics.", []],
    ["Your stats (3.72 GPA, 1380 SAT) are solid.", []],
  ]) assert.deepEqual(kinds(text, record), want, text);
  // A list of other people's numbers, a school's figure beside the
  // student's, a target with its own article, a plan, a condition, a count
  // or a range is not the student's record.
  for (const text of [
    "Most admits have a 3.95 GPA and 1520 SAT.",
    "Michigan's middle 50% is 1340–1520 on the SAT, with a 3.9 GPA typical.",
    "Your 1380 SAT and Stanford's 1520 SAT are far apart.",
    "With your 3.72 GPA and a 1520 SAT, you'd be competitive at Northwestern.",
    "Your 3.72 GPA and a 1520 SAT would open doors.",
    "You have a 3.72 GPA, and a 1520 SAT would make you competitive.",
    "Your 1380 SAT and 2 ACT sittings show persistence.",
    "Your 3.72 GPA and 1500–1550 SAT range put you near the middle.",
    "If your GPA is 3.95 and your SAT is 1520, apply early.",
    "Your 1380 SAT (about a 29 ACT) is solid.",
    "학생의 SAT 1380점과 스탠퍼드의 SAT 1520점은 차이가 큽니다.",
  ]) assert.deepEqual(kinds(text, record), [], text);
});

// Every recorded sitting is a true score: the check read only the first
// entry, so a retaker's newer 1450 was "corrected" to 1390 and the retry
// told the model to downgrade the student's best score.
test("every SAT and ACT sitting and the superscore are true; PSAT, TOEFL and IELTS are checked under their own labels", () => {
  const sittings = { testScores: [
    { test: "sat", totalScore: 1390, date: "2026-03", sections: { readingWriting: 700, math: 690 } },
    { test: "sat", totalScore: 1450, date: "2026-10", sections: { readingWriting: 690, math: 760 } },
  ] };
  assert.deepEqual(kinds("Your SAT of 1450 from October is your best score.", sittings), []);
  assert.deepEqual(kinds("Your 1390 SAT from March was a good start.", sittings), []);
  assert.deepEqual(kinds("Your SAT superscore of 1460 helps at schools that superscore.", sittings), []);
  assert.deepEqual(kinds("Your SAT Math 760 is your strongest section.", sittings), []);
  const third = checkProfileFidelity("Your SAT of 1500 is strong.", sittings).contradictions;
  assert.equal(third.length, 1);
  assert.equal(third[0].actual, "1390 (2026-03) and 1450 (2026-10) (superscore 1460)");
  assert.match(buildFidelityFootnote(third), /- SAT: recorded 1390 \(2026-03\) and 1450 \(2026-10\) \(superscore 1460\) \(the reply said 1500\)/);

  assert.deepEqual(kinds("Your ACT of 33 is strong.", { testScores: [{ test: "act", totalScore: 30 }, { test: "act", totalScore: 33 }] }), []);

  // A PSAT figure is never an SAT figure, and the SAT on a PSAT-only record
  // is not on the record at all.
  const psat = { testScores: [{ test: "psat", totalScore: 1380 }] };
  assert.deepEqual(kinds("Your PSAT 1380 is a strong start toward the SAT.", psat), []);
  assert.deepEqual(kinds("Your PSAT of 1380 predicts an SAT around 1420.", psat), []);
  const invented = checkProfileFidelity("Your SAT of 1420 is strong.", psat).contradictions;
  assert.deepEqual(invented.map((c) => [c.kind, c.stated, c.actual]), [["sat", "1420", "no SAT score recorded"]]);
  assert.match(buildFidelityFootnote(invented), /- SAT: no score is recorded \(the reply said 1420\)/);
  assert.deepEqual(kinds("Your PSAT of 1400 is solid.", psat), ["psat:1400"]);

  assert.deepEqual(kinds("Your TOEFL 112 is excellent.", { testScores: [{ test: "toefl", totalScore: 105 }] }), ["toefl:112"]);
  assert.deepEqual(kinds("Your TOEFL 105 is excellent.", { testScores: [{ test: "toefl", totalScore: 105 }] }), []);
  assert.deepEqual(kinds("Your IELTS 8.0 is excellent.", { testScores: [{ test: "ielts", totalScore: 7 }] }), ["ielts:8"]);
  assert.deepEqual(kinds("Your IELTS 7.0 is excellent.", { testScores: [{ test: "ielts", totalScore: 7 }] }), []);
  // A Subject Test score is not an SAT total.
  assert.deepEqual(kinds("Your SAT Subject Test score of 780 still shows strength.", profile), []);
  // A count beside a label is not a score.
  assert.deepEqual(kinds("Your 2 ACT sittings both went well.", compared), []);
});

// The check was English-only, so a Korean reply with an invented score
// passed and was replayed as history on later turns.
test("a Korean reply is checked for grades, GPA, SAT and AP scores, and hedged Korean is not", () => {
  const korean = {
    gpaUnweighted: 3.82,
    testScores: [{ test: "sat", totalScore: 1450 }],
    courses: [{ name: "Statistics", type: "ap", grade: "B+", year: "junior" }],
    apScores: [{ exam: "Statistics", score: 4 }],
  };
  for (const [text, want] of [
    ["학생의 SAT 점수 1500점은 아주 경쟁력 있습니다.", ["sat:1500"]],
    ["당신의 SAT 1500점은 훌륭합니다.", ["sat:1500"]],
    ["학생의 GPA 3.95는 상위권입니다.", ["gpa:3.95"]],
    ["AP Statistics에서 받은 A 학점이 강점입니다.", ["course_grade:A"]],
    ["AP Statistics 시험에서 5점을 받은 것이 인상적입니다.", ["ap_score:5"]],
    ["AP Statistics에서 A를 받았고 SAT 1500점이라 경쟁력이 있습니다.", ["course_grade:A", "sat:1500"]],
    // The recorded values.
    ["학생의 SAT 점수 1450점은 아주 경쟁력 있습니다.", []],
    ["학생의 GPA 3.82는 상위권입니다.", []],
    ["AP Statistics에서 받은 B+ 학점이 강점입니다.", []],
    ["AP Statistics 시험에서 4점을 받은 것이 인상적입니다.", []],
    // An admitted class, a school's band, a goal, a condition, a comparison.
    ["합격자 평균 SAT 1500점입니다.", []],
    ["스탠퍼드의 SAT 중간 50%는 1510–1580점입니다.", []],
    ["SAT 1500점을 목표로 하세요.", []],
    ["AP Statistics에서 5점을 받으면 학점 인정을 받을 수 있습니다.", []],
    ["학생의 SAT 1450점은 스탠퍼드 SAT 1510점보다 낮습니다.", []],
    ["학생의 SAT 1450점은 스탠퍼드의 SAT 1510점보다 낮습니다.", []],
    ["합격한 학생의 SAT 1500점은 참고만 하세요.", []],
  ]) assert.deepEqual(kinds(text, korean), want, text);
});

// Same-named courses are one course on the record, and a short name inside
// a longer one names the longer course.
test("semester halves and multi-year courses accept every recorded grade; a short name inside a longer one is the longer course", () => {
  const chemistry = { courses: [
    { name: "Chemistry", type: "honors", grade: "A-", year: "sophomore", semester: "fall" },
    { name: "Chemistry", type: "honors", grade: "B+", year: "sophomore", semester: "spring" },
  ] };
  assert.deepEqual(kinds("Your A- in Honors Chemistry in the fall shows strength.", chemistry), []);
  assert.deepEqual(kinds("Your B+ in Honors Chemistry in the spring held up.", chemistry), []);
  const wrong = checkProfileFidelity("Your A in Honors Chemistry stands out.", chemistry).contradictions;
  assert.equal(wrong.length, 1);
  assert.equal(wrong[0].actual, "A- (sophomore year, fall semester) and B+ (sophomore year, spring semester)");
  assert.match(buildFidelityFootnote(wrong), /- Chemistry: recorded grades A- \(sophomore year, fall semester\) and B\+ \(sophomore year, spring semester\) \(the reply said A\)/);

  const orchestra = { courses: [{ name: "Orchestra", grade: "A", year: "freshman" }, { name: "Orchestra", grade: "B", year: "sophomore" }] };
  assert.deepEqual(kinds("Your A in Orchestra freshman year and B in Orchestra sophomore year show commitment.", orchestra), []);

  const shortNames = { courses: [
    { name: "Biology", grade: "B", year: "freshman" },
    { name: "History", grade: "C+", year: "freshman" },
    { name: "Art", grade: "B", year: "freshman" },
    { name: "World History", grade: "A", year: "sophomore" },
    { name: "US History", type: "ap", grade: "A", year: "junior" },
  ] };
  for (const text of ["Marine Biology (A) shows your interest.", "World History: A is a strong grade.", "AP US History (A) adds rigor.", "Studio Art (A) is a strength.", "Your A in World History is great."]) {
    assert.deepEqual(kinds(text, shortNames), [], text);
  }
  assert.deepEqual(kinds("History (A) was your best class.", shortNames), ["course_grade:A"]);
  // Without the longer course on the record the grade is invented, not a
  // misread of History.
  const { courses } = shortNames;
  assert.deepEqual(kinds("AP US History (A) adds rigor.", { courses: courses.filter((c) => c.name !== "US History") }), ["course_not_on_record:A"]);
  // The level check still tells Honors from AP Chemistry.
  assert.deepEqual(checkProfileFidelity("Your A in AP Chemistry matters.", profile).contradictions.map((c) => c.kind), ["course_not_on_record"]);
});

// An exam with no recorded score was never checked, so the natural
// invention — a 5 on an AP course still in progress — passed.
test("a score for an AP exam with no recorded score is flagged, and the profile says when none are recorded", () => {
  const bio = checkProfileFidelity("You scored a 5 on AP Biology, which shows range.", compared).contradictions;
  assert.deepEqual(bio.map((c) => [c.kind, c.item, c.stated, c.actual]), [["ap_not_on_record", "AP Biology exam", "5", "no score recorded for this exam"]]);
  const calc = checkProfileFidelity("Your 5 on the AP Calculus BC exam is a highlight.", compared).contradictions;
  assert.deepEqual(calc.map((c) => [c.kind, c.actual]), [["ap_not_on_record", "course in progress; no exam score yet"]]);
  assert.match(buildFidelityFootnote(calc), /- AP Calculus BC exam: the course is in progress and no exam score is recorded yet \(the reply said 5\)/);
  assert.deepEqual(kinds("You got a 5 on AP Statistics.", { courses: [{ name: "Statistics", type: "ap", grade: "A" }], apScores: [] }), ["ap_not_on_record:5"]);
  for (const text of [
    "You're taking AP Calculus BC this year.",
    "A 5 on AP Calculus BC would earn credit.",
    "Aim for a 5 on AP Biology.",
    "Michigan gives credit for a 4 or 5 on AP Statistics.",
    "You scored a 5 on the AP Biology practice test.",
  ]) assert.deepEqual(kinds(text, compared), [], text);

  const block = formatProfileForModel({ courses: [{ name: "Calculus BC", type: "ap", grade: "IP" }], apScores: [] });
  assert.match(block, /\nAP exam scores: none recorded\n/);
});

// The footnote said "Health: recorded no grade recorded" and called a
// recorded P or 95 no grade; its lines were English under the Korean heading.
test("the correction footnote says what the record holds, in English and in Korean", () => {
  const record = { courses: [
    { name: "Health", grade: "P" },
    { name: "Chemistry", grade: "95" },
    { name: "Art", grade: "" },
    { name: "Calculus BC", type: "ap", grade: "IP" },
  ] };
  const found = checkProfileFidelity("Your A in Health, your A in Chemistry, your A in Art and your A in AP Calculus BC all help.", record).contradictions;
  const english = buildFidelityFootnote(found);
  assert.match(english, /- Health: recorded P \(pass\/fail\) \(the reply said A\)/);
  assert.match(english, /- Chemistry: recorded 95 \(the reply said A\)/);
  assert.match(english, /- Art: no grade is recorded \(the reply said A\)/);
  assert.match(english, /- AP Calculus BC: in progress, with no final grade yet \(the reply said A\)/);
  assert.doesNotMatch(english, /recorded no\b/);
  assert.match(buildFidelityFootnote(checkProfileFidelity("Your 3.8 GPA is fine.", {}).contradictions), /- GPA: no GPA is recorded \(the reply said 3\.8\)/);
  assert.match(buildFidelityFootnote(checkProfileFidelity("Your 3.8 GPA is fine.", { gpaStatus: "pending" }).contradictions), /- GPA: the student has no GPA yet \(the reply said 3\.8\)/);
  assert.match(buildFidelityFootnote(checkProfileFidelity("Your class rank in the top 5% is a strength.", {}).contradictions), /- Class rank: no class rank is recorded \(the reply said top 5%\)/);

  const korean = buildFidelityFootnote(found, "ko-KR");
  assert.match(korean, /^\n\n_저장된 프로필 기준 정정/);
  assert.match(korean, /- Health: 기록된 성적 P \(P\/F 과목\) \(답변에서는 A\)/);
  assert.match(korean, /- Art: 기록된 성적이 없습니다 \(답변에서는 A\)/);
  assert.match(korean, /- AP Calculus BC: 수강 중이며 아직 최종 성적이 없습니다 \(답변에서는 A\)/);
  const koreanScores = buildFidelityFootnote(checkProfileFidelity("Your 3.9 GPA and your SAT of 1500 help. You got a 3 on AP Statistics. You are ranked in the top 1% of your class.", { ...profile, classRank: { rank: 12, size: 400 } }).contradictions, "ko");
  assert.match(koreanScores, /- GPA: 기록된 값 비가중 3\.82 \/ 가중 4\.31 \(답변에서는 3\.9\)/);
  assert.match(koreanScores, /- SAT: 기록된 점수 1450 \(답변에서는 1500\)/);
  assert.match(koreanScores, /- AP Statistics 시험: 기록된 점수 4 \(답변에서는 3\)/);
  assert.match(koreanScores, /- 학급 석차: 기록된 값 상위 3% \(400명 중 12등\) \(답변에서는 top 1%\)/);
  // Every body line under the Korean heading is Korean.
  for (const line of koreanScores.split("\n").filter((l) => l.startsWith("- "))) assert.match(line, /[가-힣]/, line);
  // The retry message to the model stays English.
  assert.match(buildFidelityCorrection(found), /- Health: recorded P \(pass\/fail\) \(the reply said A\)/);
});

// "GPA: null" and "SAT ?" reached the model when a value was missing.
test("the profile block never hands the model a bare null", () => {
  const block = formatProfileForModel({
    gpa: { unweighted: null, weighted: null },
    gpaStatus: "pending",
    testScores: [{ test: "sat", totalScore: null }],
    apScores: [{ exam: "Biology", score: null, year: null }],
    courses: [{ name: "Health", type: null, grade: null, year: null }],
    activities: [{ name: "Robotics", role: null, category: "null", description: undefined }],
    majorInterest: null,
    goals: [null, "null"],
  });
  assert.match(block, /GPA: none yet \(the student says they don't have a GPA yet/);
  assert.match(block, /Test scores: SAT \(total not recorded\)/);
  assert.match(block, /AP exam scores: AP Biology: score not recorded\n/);
  assert.match(block, /  - Health — regular — grade not recorded/);
  assert.match(block, /^  - Robotics$/m);
  assert.doesNotMatch(block, /null|undefined|\?/);
  assert.match(formatProfileForModel({ gpaUnweighted: "", gpaWeighted: "4.1" }), /GPA: 4\.1 weighted/);
  assert.match(formatProfileForModel({ testScores: [], testingStatus: "planned" }), /Test scores: none yet \(the student hasn't taken a test yet\)/);
  assert.match(formatProfileForModel({}), /GPA: not recorded\nTest scores: none recorded/);
});

// Students type "nyu" and "ucla", and Korean students "스탠퍼드": every
// short code matched only in capitals and no Hangul name matched at all, so
// those questions got no VERIFIED DATA block and no College Fit read.
test("school codes match in any case, Hangul names resolve, and the collision-prone codes stay capitals-only", () => {
  for (const [text, want] of [
    ["is nyu a good fit for me?", ["New York University"]],
    ["what's ucla's acceptance rate", ["University of California-Los Angeles"]],
    ["usc vs ucla for cs", ["University of Southern California", "University of California-Los Angeles"]],
    ["Is mit test required?", ["Massachusetts Institute of Technology"]],
    ["Nyu or Cmu?", ["New York University", "Carnegie Mellon University"]],
    ["스탠퍼드 합격률이 어떻게 돼?", ["Stanford University"]],
    ["스탠포드랑 하버드 얼리 마감일 알려줘", ["Stanford University", "Harvard University"]],
    ["뉴욕대와 미시간대, 미시간 주립대를 비교해줘", ["New York University", "University of Michigan-Ann Arbor", "Michigan State University"]],
    ["카네기멜런 CS는 어때?", ["Carnegie Mellon University"]],
    ["Is Penn State a safety?", ["Pennsylvania State University-Main Campus"]],
    ["because bc i said so", []],
    ["uf", []],
    ["bu", []],
    ["uw is far", []],
    ["AP Calculus BC grade", []],
    ["버클리 음대 실기", []],
    ["브리티시 컬럼비아 대학", []],
    ["브라운 색 가방", []],
  ]) assert.deepEqual(detectSchoolMentions(text), want, text);
});

// A named school with nothing held used to leave the block silent, and the
// model answered from memory.
test("a named school with nothing held gets a line that says so", () => {
  const only = formatVerifiedDataBlock({ unheld: ["Rice University"] });
  assert.match(only, /^VERIFIED DATA \(the ONLY statistics you may cite/);
  assert.match(only, /\n- Rice University: no verified data held — say you don't have verified figures for this school, point the student to its Common Data Set or the College Scorecard \(collegescorecard\.ed\.gov\), and never quote a statistic for it from memory$/);
  const mixed = formatVerifiedDataBlock({
    schools: [{ name: "Elm College", baseline: null, cds: null, policyLine: "Admissions policy (official site, checked 2026-09-03): application fee none [Source: https://elm.edu/apply]" }],
    unheld: ["Elm College", "Oak University", "oak university", ""],
  });
  assert.match(mixed, /- Elm College: Admissions policy/);
  assert.doesNotMatch(mixed, /Elm College: no verified data held/);
  assert.equal(mixed.match(/no verified data held/g).length, 1);
  // The old contract holds: no data and no unheld names is no block.
  assert.equal(formatVerifiedDataBlock({ schools: [{ name: "X", baseline: null, cds: null }] }), "");

  assert.deepEqual(unresolvedSchoolNames("What is Elm Valley College's acceptance rate? And Stanford?"), ["Elm Valley College"]);
  assert.deepEqual(unresolvedSchoolNames("Which College should I pick, Boston College or the University of Nowhere?", { knownNames: ["Boston College"] }), ["University of Nowhere"]);
  assert.deepEqual(unresolvedSchoolNames("Is a Liberal Arts College right for me, or Carnegie Mellon University?", { knownNames: ["Carnegie Mellon University"] }), []);
});

// fid-5: the grade the student is in (computed on the server from their
// class) never reached the model, so a senior with no courses entered in
// November got a junior-year plan.
test("the profile block states the grade level, and a reply that misstates it is caught", () => {
  assert.match(formatProfileForModel({ gradeLevel: 12 }), /^STUDENT PROFILE[^\n]*\nGrade level: 12th grade \(senior\)\n/);
  assert.match(formatProfileForModel({ gradeLevel: 9 }), /\nGrade level: 9th grade \(freshman\)\n/);
  assert.doesNotMatch(formatProfileForModel({}), /Grade level/);
  assert.doesNotMatch(formatProfileForModel({ gradeLevel: 7 }), /Grade level/);

  const senior = { ...profile, gradeLevel: 12 };
  for (const reply of [
    "Since you're a junior, the SAT next spring is your best window.",
    "As an 11th grader, you should start your list now.",
    "You are in 11th grade, so focus on your junior-year courses.",
    "학생은 11학년이므로 내년 봄에 SAT를 보세요.",
  ]) {
    const found = checkProfileFidelity(reply, senior).contradictions.filter((c) => c.kind === "grade_level");
    assert.equal(found.length, 1, reply);
    assert.equal(found[0].actual, "12th grade (senior)");
  }
  // Hedged, general or about a past year: never a contradiction.
  for (const reply of [
    "Juniors usually take the SAT in the spring.",
    "If you're a junior, the PSAT counts for National Merit.",
    "The grades you earned as a junior matter most.",
    "You're a senior, so the November 1 deadlines are close.",
    "You're a junior varsity captain, which shows commitment.",
    "11학년이라면 SAT를 봄에 보세요.",
  ]) {
    assert.equal(checkProfileFidelity(reply, senior).contradictions.filter((c) => c.kind === "grade_level").length, 0, reply);
  }
  // No recorded grade: nothing to check against.
  assert.equal(checkProfileFidelity("Since you're a junior, start now.", profile).contradictions.filter((c) => c.kind === "grade_level").length, 0);

  const [contradiction] = checkProfileFidelity("As a junior, you have time.", senior).contradictions.filter((c) => c.kind === "grade_level");
  assert.match(buildFidelityCorrection([contradiction]), /- Grade level: the student is in 12th grade \(senior\) \(the reply said 11th grade \(junior\)\)/);
  assert.match(buildFidelityFootnote([contradiction], "ko"), /학년: 기록상 12학년 \(답변에서는 11학년\)/);
});

// Wave 1 follow-up: "$15/hr" and "Budget: $2,000" in an activity reached the
// provider as [ANNUAL_INCOME_nn]. Only the activity's own text is rewritten;
// goals and the major keep their "$" for the redactor's income rules.
test("dollar amounts in an activity reach the model as USD, past the provider redactor", async () => {
  const { redactProviderText } = await import("../chat/content-moderation.js");
  const block = formatProfileForModel({
    activities: [{ name: "Tutoring ($15/hr)", role: "Founder", description: "Raised $4,500 for the food bank and earned $15/hr tutoring." }],
    goals: ["family income $85,000"],
  });
  assert.match(block, /Tutoring \(15 USD\/hr\)/);
  assert.match(block, /Raised 4,500 USD for the food bank and earned 15 USD\/hr tutoring/);
  assert.match(block, /family income \$85,000/);
  const masked = redactProviderText(block).text;
  assert.match(masked, /4,500 USD/);
  assert.match(masked, /15 USD\/hr/);
});

// The activity rewrite took every "$", so a Family Responsibilities entry
// sent the parents' income to the provider as "35,000 USD" on every turn.
test("a family income in an activity description is still masked at the provider", async () => {
  const { redactProviderText } = await import("../chat/content-moderation.js");
  const block = formatProfileForModel({
    activities: [
      { name: "Family Responsibilities", category: "family", description: "Work 20 hrs/wk at my parents' shop, which brings in about $180,000 a year; our household income is only $35,000." },
      { name: "Grocery clerk", role: "Cashier", description: "Paid $15/hr; I give $600/month to my mom for rent." },
    ],
  });
  const masked = redactProviderText(block).text;
  assert.doesNotMatch(masked, /180,000|35,000|\b600\b/);
  assert.equal(masked.match(/\[ANNUAL_INCOME_\d{2}\]/g)?.length, 3);
  assert.match(masked, /Paid 15 USD\/hr; I give \[ANNUAL_INCOME_\d{2}\]\/month to my mom for rent\./);
});

// Wave 1 follow-ups to the VERIFIED DATA block: a withheld or stale College
// Fit read said nothing at all, and a CDS "test required" the store knows to
// be a parser default reached the model as the school's policy.
test("the fit line says when there is no label yet or the read is old, and the CDS policy line reads the store's verdict", () => {
  const withheld = formatVerifiedDataBlock({ schools: [{ name: "Columbia University", baseline: null, cds: null, fitRead: {
    school: "Columbia University", label: null, labelKey: null, computedAt: "2026-10-01T00:00:00Z",
    provenance: { kind: "baseline_only", labelKey: "insufficient_student_data", studentDataNeeded: ["gpa", "sat_or_act"] },
  } }] });
  assert.match(withheld, /College Fit for THIS student at Columbia University: no label yet; add a GPA \(unweighted or weighted\) and an SAT or ACT score to get one\./);
  assert.doesNotMatch(withheld, /Use this exact label|Not enough data yet|College Fit read for THIS student/);

  const stale = formatVerifiedDataBlock({ schools: [{ name: "Stanford University", baseline: null, cds: null, fitRead: {
    school: "Stanford University", label: null, stale: true, staleLabel: "Reach", computedAt: "2026-09-12T08:00:00Z",
    provenance: { kind: "cds_store" }, verification: null,
  } }] });
  assert.match(stale, /College Fit for THIS student at Stanford University: an older read \(computed 2026-09-12\); the profile or the engine changed since, so reopen College Fit for a current label/);
  assert.doesNotMatch(stale, /Reach|Use this exact label|College Fit read for THIS student/);

  const none = formatVerifiedDataBlock({ schools: [{ name: "Elm College", baseline: null, cds: null, fitRead: {
    school: "Elm College", label: "High reach", computedAt: "2026-10-01T00:00:00Z",
    provenance: { kind: "none", admitRate: { used: null, basis: "unknown", assumedForLikelihood: 0.5 } },
  } }] });
  assert.match(none, /computed 2026-10-01 from no stored school data\): High reach/);
  assert.match(none, /; no admit rate is on file, so this likelihood assumes 50%\. Use this exact label/);

  const cds = (record) => formatVerifiedDataBlock({ schools: [{ name: "University of California-Los Angeles", baseline: null, cds: { school: "University of California-Los Angeles", yearLabel: "2024-25", overallAdmitRate: 0.09, ...record } }] });
  // An old parser's "required" default with no section C evidence is not a policy.
  assert.match(cds({ testPolicy: "test_required", parserVersion: 1, c7: { gpa: "very_important", rigor: "very_important", test_scores: "not_considered" } }), /test policy: test blind/);
  assert.match(cds({ testPolicy: "test_required", parserVersion: 1 }), /test policy: not read from the document/);
  assert.match(cds({}), /test policy: not read from the document/);
  assert.match(cds({ testPolicy: "test_optional" }), /test policy: test optional/);
});

// With unheld lines the block is never empty, so "held data was sent"
// (the chat's _meta.verifiedData) reads the lines, not the block's presence.
test("a block of only unheld schools holds no verified data", async () => {
  const { blockHoldsVerifiedData } = await import("../chat/chat-grounding.js");
  assert.equal(blockHoldsVerifiedData(formatVerifiedDataBlock({ unheld: ["Rice University", "Elm Valley College"] })), false);
  assert.equal(blockHoldsVerifiedData(""), false);
  assert.equal(blockHoldsVerifiedData(formatVerifiedDataBlock({
    schools: [{ name: "Elm College", baseline: null, cds: null, policyLine: "Admissions policy (official site, checked 2026-09-03): application fee none [Source: https://elm.edu/apply]" }],
    unheld: ["Oak University"],
  })), true);
});

// A TOEFL band entry and a PSAT 8/9 entry are stored with their scale
// (test-catalog.js), and the profile block names it: "TOEFL 5.5" was read
// as 5.5 of 120 and "PSAT 900" as a weak PSAT/NMSQT. A Korean 성취도 grade
// says which scale its letter is on.
test("a score's scale and a Korean achievement grade reach the model by name", () => {
  const block = formatProfileForModel({
    testScores: [
      { test: "toefl", scale: "band", totalScore: 5.5, sections: { reading: 5.5, listening: 6, speaking: 5, writing: 5.5 } },
      { test: "psat", scale: "8/9", totalScore: 900, date: "2026-10" },
      { test: "toefl", totalScore: 105 },
    ],
    courses: [
      { name: "Korean Literature", type: "regular", grade: "E", gradeScale: "kr_achievement", year: "sophomore", semester: "fall" },
      { name: "Mathematics I", type: "regular", grade: "A", gradeScale: "kr_achievement", year: "sophomore", semester: "spring" },
      { name: "Integrated Science", type: "regular", grade: "IP", gradeScale: "kr_achievement", year: "junior" },
      { name: "Chemistry", type: "honors", grade: "A-", year: "junior" },
    ],
  });
  assert.match(block, /Test scores: TOEFL \(1-6 band\) 5\.5 \(Reading 5\.5, Listening 6, Speaking 5, Writing 5\.5\); PSAT 8\/9 900 \(taken 2026-10\); TOEFL 105\n/);
  assert.match(block, /  - sophomore: Korean Literature — regular — grade E \(Korean achievement level, A-E scale\) \(fall semester\)\n/);
  assert.match(block, /  - sophomore: Mathematics I — regular — grade A \(Korean achievement level, A-E scale\) \(spring semester\)\n/);
  // No final grade yet: there is no achievement level to describe.
  assert.match(block, /  - junior: Integrated Science — regular — in progress \(no final grade yet\)\n/);
  // A US course carries no scale note.
  assert.match(block, /  - junior: Chemistry — Honors — grade A-$/m);
});

// CLAUDE.md rule 1: the check reads an entry on the scale it was stored on.
// A stated band 5.5 is the record, never "corrected" toward a 0-120 value;
// a wrong band or a wrong PSAT 8/9 figure, which used to fall outside the
// base range and pass unread, is caught and reported under the scale's name.
test("TOEFL band and PSAT 8/9 entries are checked on their own scales", () => {
  const band = { testScores: [{ test: "toefl", scale: "band", totalScore: 5.5 }] };
  assert.deepEqual(kinds("Your TOEFL of 5.5 is strong for most programs.", band), []);
  assert.deepEqual(kinds("Your TOEFL score of 5.5 clears the bar.", band), []);
  const wrongBand = checkProfileFidelity("Your TOEFL score of 6 clears every bar.", band).contradictions;
  assert.deepEqual(wrongBand.map((c) => [c.kind, c.item, c.stated, c.actual]), [["toefl", "TOEFL (1-6 band)", "6", "5.5"]]);
  assert.match(buildFidelityFootnote(wrongBand), /- TOEFL \(1-6 band\): recorded 5\.5 \(the reply said 6\)/);
  assert.match(buildFidelityCorrection(wrongBand), /- TOEFL \(1-6 band\): recorded 5\.5 \(the reply said 6\)/);
  const invented = checkProfileFidelity("Your TOEFL of 110 is excellent.", band).contradictions;
  assert.deepEqual(invented.map((c) => [c.item, c.stated, c.actual]), [["TOEFL (1-6 band)", "110", "5.5"]]);

  // A 0-120 record is not "corrected" by a band figure it does not hold,
  // and its own total stays true.
  const ibt = { testScores: [{ test: "toefl", totalScore: 105 }] };
  assert.deepEqual(kinds("Your TOEFL of 105 is excellent.", ibt), []);
  assert.deepEqual(kinds("Your TOEFL score of 5.5 is excellent.", ibt), ["toefl:5.5"]);

  // Band sittings combine with each other, not with a 0-120 sitting: the
  // old superscore summed the band sections into a TOEFL "21".
  const mixed = { testScores: [
    { test: "toefl", scale: "band", totalScore: 5, date: "2026-02", sections: { reading: 5, listening: 5.5, speaking: 4.5, writing: 5 } },
    { test: "toefl", scale: "band", totalScore: 5, date: "2026-06", sections: { reading: 5.5, listening: 5, speaking: 5, writing: 5 } },
    { test: "toefl", totalScore: 105, date: "2025-11" },
  ] };
  assert.deepEqual(kinds("Your TOEFL superscore of 5.5 helps.", mixed), []);
  assert.deepEqual(kinds("Your TOEFL of 105 helps.", mixed), []);
  assert.deepEqual(kinds("Your TOEFL of 21 helps.", mixed), ["toefl:21"]);
  const mixedFound = checkProfileFidelity("Your TOEFL of 21 helps.", mixed).contradictions;
  assert.equal(mixedFound[0].item, "TOEFL");
  assert.equal(mixedFound[0].actual, "5 (2026-02) and 5 (2026-06) and 105 (2025-11) (superscore 5.5)");

  const psat89 = { testScores: [{ test: "psat", scale: "8/9", totalScore: 900 }] };
  assert.deepEqual(kinds("Your PSAT 8/9 score of 900 is a fine start.", psat89), []);
  const low = checkProfileFidelity("Your PSAT 8/9 score of 280 leaves room to grow.", psat89).contradictions;
  assert.deepEqual(low.map((c) => [c.kind, c.item, c.stated, c.actual]), [["psat", "PSAT 8/9", "280", "900"]]);
  assert.match(buildFidelityFootnote(low, "ko"), /- PSAT 8\/9: 기록된 점수 900 \(답변에서는 280\)/);
});
