import test from "node:test";
import assert from "node:assert/strict";
import {
  formatProfileForModel,
  checkProfileFidelity,
  buildFidelityCorrection,
  buildFidelityFootnote,
  detectSchoolMentions,
  formatVerifiedDataBlock,
} from "../chat-grounding.js";

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
  assert.match(correction, /- AP Calculus BC: recorded in progress — no final grade recorded \(the reply said A\)/);
  assert.match(correction, /- GPA: recorded 3\.82 unweighted \/ 4\.31 weighted \(the reply said 3\.9\)/);
  const footnote = buildFidelityFootnote(contradictions);
  assert.match(footnote, /^\n\n_Correction from your saved profile/);
  assert.match(footnote, /- SAT: recorded 1450 \(the reply said 1500\)/);
  assert.match(buildFidelityFootnote(contradictions, "ko"), /저장된 프로필 기준 정정/);
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
  assert.match(drive, /- Stanford University: admit rate 3\.6% \[Source: Stanford University Common Data Set 2025-26 \(validated against ground truth\), official PDF on file\]/);
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
        school: "Boston University", yearLabel: "2025-26", overallAdmitRate: 0.108, sourceUrl: "https://www.bu.edu/cds.pdf",
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
  assert.match(wide, /application fee 80 USD; average first-year need-based aid package 68,926 USD; student-to-faculty ratio 10 to 1/);
  assert.match(wide, /closing dates the school reported for its CDS cycle \(month\/day; confirm this year's dates on its admissions page\): Regular Decision 01\/05, Early Decision 11\/01, Early Decision II 01\/05, aid filing deadline 01\/05/);
  assert.doesNotMatch(wide, /\$/);
});
