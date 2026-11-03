// ═══════════════════════════════════════════════════════════
// TESTS: Policy Router
// ═══════════════════════════════════════════════════════════

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTopic,
  enforceGates,
  isLookupQuestion,
  selectModelTier,
  canHandleDeterministically,
  routeRequest,
  isCrisisTopicMention,
  TOPIC_TYPES,
  MODEL_TIERS,
} from "../chat/policy-router.js";

describe("classifyTopic", () => {
  it("classifies FAFSA queries as REGULATED", () => {
    const result = classifyTopic("How do I fill out my FAFSA?");
    assert.equal(result.topicType, TOPIC_TYPES.REGULATED);
    assert.equal(result.subIntent, "fafsa");
  });

  it("classifies FERPA queries as REGULATED", () => {
    const result = classifyTopic("What are my FERPA rights?");
    assert.equal(result.topicType, TOPIC_TYPES.REGULATED);
    assert.equal(result.subIntent, "ferpa");
  });

  it("classifies deadline queries as HIGH_STAKES", () => {
    const result = classifyTopic("When is the MIT early action deadline?");
    assert.equal(result.topicType, TOPIC_TYPES.HIGH_STAKES);
  });

  it("classifies essay questions as COACHING", () => {
    const result = classifyTopic("Can you help me brainstorm essay topics?");
    assert.equal(result.topicType, TOPIC_TYPES.COACHING);
  });

  it("classifies crisis language as CRISIS", () => {
    const result = classifyTopic("I want to end my life");
    assert.equal(result.topicType, TOPIC_TYPES.CRISIS);
  });

  // iOS and macOS type ’ by default; every pattern spelled the apostrophe in
  // ASCII, so these were ordinary coaching turns.
  it("classifies crisis statements typed with a typographic apostrophe as CRISIS", () => {
    for (const text of ["I’m not safe at home", "I don’t want to live anymore", "I’m being abused by my stepdad", "I’m scared to go home"]) {
      assert.equal(classifyTopic(text).topicType, TOPIC_TYPES.CRISIS, text);
    }
    assert.notEqual(classifyTopic("I’m hopeless at chemistry").topicType, TOPIC_TYPES.CRISIS);
  });

  // Over-firing idioms, loosened on both lexicons with the first-person
  // statement next to each one still pinned as a crisis.
  it("answers idioms that look like danger, and keeps the first-person statements beside them", () => {
    const pairs = [
      ["I'm in danger of failing AP Chem, what should I do?", "I'm in danger at home"],
      ["I am in danger of losing my scholarship if my GPA drops", "I'm in danger of being hurt"],
      ["I cut myself off from social media to focus on SAT prep", "I cut myself last night"],
      ["I need to cut myself some slack this semester", "I'm cutting myself again"],
      ["I hurt myself playing soccer and missed junior season", "I want to hurt myself"],
      ["I hurt myself at practice", "I keep hurting myself"],
      // The sports carve-out used to hide intent stated later in the sentence.
      ["I hurt myself at practice", "I hurt myself at practice on purpose"],
      ["I hurt myself during the season so I couldn't play junior year", "I hurt myself during the game yesterday because I wanted to feel something"],
      ["They threatened me with detention for being late", "he threatened me with a knife"],
      ["My teacher threatened me with a zero", "he threatened to kill me"],
      ["It's an emergency, my Common App won't submit and the deadline is tonight!", "This is an emergency, I need help right now"],
    ];
    for (const [idiom, statement] of pairs) {
      assert.notEqual(classifyTopic(idiom).topicType, TOPIC_TYPES.CRISIS, idiom);
      assert.equal(classifyTopic(statement).topicType, TOPIC_TYPES.CRISIS, statement);
    }
  });

  it("answers suicide named as a topic, and keeps a third party's attempt and first-person statements as crisis", () => {
    for (const text of ["I started a suicide prevention club at school", "My research project is on suicide rates among teens", "We run a self-harm awareness week", "I volunteer with an overdose prevention program"]) {
      assert.notEqual(classifyTopic(text).topicType, TOPIC_TYPES.CRISIS, text);
      assert.equal(isCrisisTopicMention(text), true, text);
    }
    for (const text of ["My essay is about my brother's suicide attempt", "I'm suicidal", "I'm thinking about suicide", "I overdosed"]) {
      assert.equal(classifyTopic(text).topicType, TOPIC_TYPES.CRISIS, text);
      assert.equal(isCrisisTopicMention(text), false, text);
    }
    assert.equal(isCrisisTopicMention("Which APs should I take?"), false);
  });

  // Hotline and lifeline are topic nouns, which made a request for the number
  // a topic mention that waited on consent, the budget and a model call.
  it("treats a request for a crisis line as CRISIS, and the line named as an activity as a topic", () => {
    for (const text of ["I need the suicide hotline number", "what's the suicide hotline? I need it now", "can you give me the suicide lifeline number", "How do I call the suicide hotline?", "자살 상담전화 번호 알려주세요"]) {
      assert.equal(classifyTopic(text).topicType, TOPIC_TYPES.CRISIS, text);
    }
    for (const text of ["I trained as a volunteer for the 988 Suicide & Crisis Lifeline", "I answered calls at a suicide hotline for two summers", "자살예방상담전화에서 1년 동안 봉사했어요"]) {
      assert.notEqual(classifyTopic(text).topicType, TOPIC_TYPES.CRISIS, text);
      assert.equal(isCrisisTopicMention(text), true, text);
    }
  });

  it("classifies Korean first-person statements as CRISIS and Korean hyperbole as coaching", () => {
    for (const text of ["살고 싶지 않아요", "아빠가 저를 때려요", "엄마한테 맞고 있어요", "손목을 그었어요", "더 이상 살 이유가 없어요"]) {
      assert.equal(classifyTopic(text).topicType, TOPIC_TYPES.CRISIS, text);
    }
    for (const text of ["화학 때문에 죽겠어요", "죽을 것 같이 바빠요", "자살 예방 동아리를 만들었어요"]) {
      assert.notEqual(classifyTopic(text).topicType, TOPIC_TYPES.CRISIS, text);
    }
  });

  it("classifies ideation the client always caught as CRISIS", () => {
    for (const text of ["everyone would be better off without me", "nobody would miss me", "I hate my life"]) {
      assert.equal(classifyTopic(text).topicType, TOPIC_TYPES.CRISIS, text);
    }
  });

  it("defaults unmatched questions to COACHING (general)", () => {
    // No crisis/regulated/high-stakes/coaching keyword → falls through to the
    // evidence-grounded coaching default (subIntent "general").
    const result = classifyTopic("What time does the office open?");
    assert.equal(result.topicType, TOPIC_TYPES.COACHING);
    assert.equal(result.subIntent, "general");
  });

  it("returns confidence score", () => {
    const result = classifyTopic("FAFSA eligibility requirements");
    assert.ok(typeof result.confidence === "number");
    assert.ok(result.confidence >= 0 && result.confidence <= 1);
  });
});

describe("enforceGates", () => {
  it("allows a REGULATED topic with no verified evidence as labeled general guidance", () => {
    const result = enforceGates(TOPIC_TYPES.REGULATED, "fafsa", []);
    assert.equal(result.allowed, true);
    assert.equal(result.fallback, null);
    assert.ok(result.generalGuidance);
    assert.equal(result.generalGuidance.unverified, true);
    assert.ok(result.generalGuidance.suggestedSource?.url?.includes("studentaid.gov"));
    assert.ok(result.gates.some((g) => g.gate === "no_source_no_answer" && g.action === "allow_unverified_general_guidance"));
    assert.ok(result.gates.some((g) => g.gate === "advisory_only_disclosure" && g.passed === true));
  });

  it("still blocks a HIGH_STAKES topic with no verified evidence (no-source-no-answer)", () => {
    const result = enforceGates(TOPIC_TYPES.HIGH_STAKES, "deadlines", []);
    assert.equal(result.allowed, false);
    assert.ok(result.fallback);
    assert.ok(result.gates.some((g) => g.gate === "no_source_no_answer" && g.passed === false));
  });

  it("allows COACHING topics with no fallback", () => {
    const result = enforceGates(TOPIC_TYPES.COACHING, "essay", []);
    assert.equal(result.allowed, true);
    assert.equal(result.fallback, null);
    assert.ok(result.gates.some((g) => g.gate === "coaching_label" && g.passed === true));
  });

  it("allows a REGULATED topic once verified evidence exists", () => {
    const result = enforceGates(TOPIC_TYPES.REGULATED, "fafsa", [{
      fact_key: "fafsa_eligibility",
      confidence: "verified",
      trust_level: "official",
      source_url: "https://studentaid.gov/apply-for-aid/fafsa",
      source_domain: "studentaid.gov",
      expires_at: "2099-01-01T00:00:00.000Z",
    }]);
    assert.equal(result.allowed, true);
    assert.ok(result.gates.some((g) => g.gate === "source_verification" && g.passed === true));
  });

  it("rejects extracted, expired, and irrelevant evidence as verification", () => {
    const common = {
      fact_key: "fafsa_eligibility",
      source_url: "https://studentaid.gov",
      source_domain: "studentaid.gov",
      trust_level: "official",
    };
    // Non-verified evidence must never pass source verification. For REGULATED
    // topics that now means general-guidance mode (allowed, labeled
    // unverified) rather than a hard block.
    const extracted = enforceGates(TOPIC_TYPES.REGULATED, "fafsa", [
      { ...common, confidence: "extracted" },
    ]);
    assert.ok(extracted.generalGuidance);
    assert.ok(!extracted.gates.some((g) => g.gate === "source_verification" && g.passed === true));
    const expired = enforceGates(TOPIC_TYPES.REGULATED, "fafsa", [
      { ...common, confidence: "verified", expires_at: "2000-01-01T00:00:00.000Z" },
    ]);
    assert.ok(expired.generalGuidance);
    assert.ok(!expired.gates.some((g) => g.gate === "source_verification" && g.passed === true));
    assert.equal(enforceGates(TOPIC_TYPES.HIGH_STAKES, "deadlines", [
      { ...common, confidence: "verified", expires_at: "2099-01-01T00:00:00.000Z" },
    ]).allowed, false);
  });
});

describe("selectModelTier", () => {
  it("returns NONE for deterministic regulated topics", () => {
    const tier = selectModelTier(TOPIC_TYPES.REGULATED, "fafsa_eligibility", "simple");
    assert.equal(tier, MODEL_TIERS.NONE);
  });

  it("returns the cheapest tier for general coaching", () => {
    const tier = selectModelTier(TOPIC_TYPES.COACHING, "general", "simple");
    assert.equal(tier, MODEL_TIERS.HAIKU);
  });

  it("convenes Council only after an explicit action", () => {
    assert.equal(selectModelTier(TOPIC_TYPES.COACHING, "essay", "complex"), MODEL_TIERS.SONNET);
    assert.equal(
      selectModelTier(TOPIC_TYPES.COACHING, "essay", "complex", null, { explicitCouncil: true }),
      MODEL_TIERS.COUNCIL,
    );
  });

  it("does not escalate cost without a separate budget approval", () => {
    const tier = selectModelTier(TOPIC_TYPES.REGULATED, "fafsa", "complex", { tier: MODEL_TIERS.SONNET, confidence: 0.2 });
    assert.equal(tier, MODEL_TIERS.SONNET);
    assert.equal(selectModelTier(
      TOPIC_TYPES.REGULATED,
      "fafsa",
      "complex",
      { tier: MODEL_TIERS.SONNET, confidence: 0.2 },
      { allowPaidEscalation: true, budgetApproved: true },
    ), MODEL_TIERS.OPUS);
  });
});

describe("canHandleDeterministically", () => {
  it("returns true for FAFSA eligibility", () => {
    assert.ok(canHandleDeterministically(TOPIC_TYPES.REGULATED, "fafsa"));
    assert.ok(canHandleDeterministically(TOPIC_TYPES.REGULATED, "eligibility"));
  });

  it("returns true for deadline status", () => {
    assert.ok(canHandleDeterministically(TOPIC_TYPES.HIGH_STAKES, "deadlines"));
  });

  it("returns false for essay coaching", () => {
    assert.equal(canHandleDeterministically(TOPIC_TYPES.COACHING, "essay"), false);
  });

  // gate-9: the checklist cannot answer a student's own situation. "Am I
  // eligible for FAFSA as a permanent resident?" got "6 eligibility item(s)
  // have not been confirmed yet" and nothing about permanent residents.
  it("answers only a plain eligibility-checklist question from the rules engine", () => {
    for (const question of [
      "Am I eligible for FAFSA?",
      "Am I eligible for FAFSA federal student aid?",
      "Am I eligible for federal financial aid through the FAFSA?",
      "What are the FAFSA eligibility requirements?",
      "Do I qualify for a Pell Grant?",
    ]) {
      const { topicType, subIntent } = classifyTopic(question);
      assert.equal(canHandleDeterministically(topicType, subIntent, question), true, question);
    }
    for (const question of [
      "Am I eligible for FAFSA as a permanent resident?",
      "Do I qualify for federal aid if my parents are undocumented?",
      "Am I eligible for a Pell Grant with DACA status?",
      "Why am I not eligible for federal student aid?",
      "Can I qualify for FAFSA since my parents are divorced?",
      "How does the FAFSA work?",
    ]) {
      const { topicType, subIntent } = classifyTopic(question);
      assert.equal(topicType, TOPIC_TYPES.REGULATED, question);
      assert.equal(canHandleDeterministically(topicType, subIntent, question), false, question);
    }
  });
});

describe("routeRequest", () => {
  it("returns a complete routing decision", () => {
    // Pass verified evidence so the regulated gate allows the full decision
    // shape (classification + gateResult + modelTier + isDeterministic).
    const result = routeRequest("Am I eligible for FAFSA?", {}, [{
      fact_key: "fafsa_eligibility",
      fact_value: "Eligibility depends on federal requirements.",
      confidence: "verified",
      trust_level: "official",
      source_url: "https://studentaid.gov",
      source_domain: "studentaid.gov",
      expires_at: "2099-01-01T00:00:00.000Z",
    }]);
    assert.ok(result.classification.topicType);
    assert.ok(typeof result.isDeterministic === "boolean");
    assert.ok(result.gateResult);
    assert.ok(result.modelTier);
  });

  it("routes crisis to deterministic with no model", () => {
    const result = routeRequest("I want to hurt myself");
    assert.equal(result.classification.topicType, TOPIC_TYPES.CRISIS);
    assert.equal(result.modelTier, MODEL_TIERS.NONE);
  });

  it("routes a general FAFSA question to labeled synthesis instead of refusing", () => {
    const result = routeRequest("How does the FAFSA work?");
    assert.equal(result.classification.topicType, TOPIC_TYPES.REGULATED);
    assert.equal(result.isDeterministic, false);
    assert.equal(result.action, "model_synthesis");
    assert.equal(result.modelTier, MODEL_TIERS.SONNET);
    assert.ok(result.generalGuidance);
    assert.equal(result.generalGuidance.unverified, true);
  });

  it("keeps FAFSA eligibility questions on the deterministic rules engine", () => {
    const result = routeRequest("Am I eligible for FAFSA?");
    assert.equal(result.classification.topicType, TOPIC_TYPES.REGULATED);
    assert.equal(result.isDeterministic, true);
    assert.equal(result.action, "rules_engine");
  });

  it("does NOT treat a non-aid eligibility question as regulated at all", () => {
    // "eligible" without federal-aid context is an admissions or
    // scholarship question — coaching, never the FAFSA checker or the
    // regulated lane.
    const result = routeRequest("Am I eligible for Princeton with a 3.8 GPA?");
    assert.equal(result.classification.topicType, TOPIC_TYPES.COACHING);
    assert.notEqual(result.classification.subIntent, "eligibility");
    assert.ok(routeRequest("Am I eligible for a Pell Grant as a permanent resident?").classification.subIntent === "eligibility");
  });

  it("does not treat ordinary counseling words as regulated or high-stakes", () => {
    for (const [question, notType] of [
      ["I'm interested in legal studies — which APs help?", TOPIC_TYPES.REGULATED],
      ["My school records show a B in chemistry; how bad is that?", TOPIC_TYPES.REGULATED],
      ["Should I apply early decision or early action?", TOPIC_TYPES.HIGH_STAKES],
      ["How much time should I spend on essays each week?", TOPIC_TYPES.HIGH_STAKES],
      ["Should I mention my scholarship in the activities list?", TOPIC_TYPES.HIGH_STAKES],
    ]) {
      assert.notEqual(classifyTopic(question).topicType, notType, question);
    }
  });

  it("still recognizes the genuinely regulated and high-stakes forms", () => {
    assert.equal(classifyTopic("What are my rights to see my education records?").subIntent, "ferpa");
    assert.equal(classifyTopic("Is my school in compliance with Title IX?").topicType, TOPIC_TYPES.REGULATED);
    assert.equal(classifyTopic("When does the application close for Michigan?").subIntent, "deadlines");
    assert.equal(classifyTopic("When is the MIT early action deadline?").subIntent, "deadlines");
    assert.equal(classifyTopic("How much does tuition cost at UVA?").subIntent, "financial_amounts");
    assert.equal(classifyTopic("Is the Coca-Cola scholarship worth $20,000?").subIntent, "financial_amounts");
    assert.equal(classifyTopic("What is Stanford's acceptance rate?").subIntent, "official_stats");
  });

  it("refuses only a pure lookup about a named school; strategy questions get general guidance", () => {
    const lookup = enforceGates(TOPIC_TYPES.HIGH_STAKES, "deadlines", [], { query: "When is Brown's early decision deadline?", schoolNamed: true });
    assert.equal(lookup.allowed, false);
    const strategy = enforceGates(TOPIC_TYPES.HIGH_STAKES, "deadlines", [], { query: "Should I apply early decision to Brown given the deadline?", schoolNamed: true });
    assert.equal(strategy.allowed, true);
    assert.ok(strategy.generalGuidance);
    const noSchool = enforceGates(TOPIC_TYPES.HIGH_STAKES, "deadlines", [], { query: "What are the deadlines this month?", schoolNamed: false });
    assert.equal(noSchool.allowed, true);
    const stats = enforceGates(TOPIC_TYPES.HIGH_STAKES, "official_stats", [], { query: "How much does the acceptance rate matter when I build my list?", schoolNamed: true });
    assert.equal(stats.allowed, true);
    const statLookup = enforceGates(TOPIC_TYPES.HIGH_STAKES, "official_stats", [], { query: "What is Yale's acceptance rate?", schoolNamed: true });
    assert.equal(statLookup.allowed, false);
  });

  it("tells a lookup from a guidance question", () => {
    for (const q of ["When is MIT's early action deadline?", "What is Stanford's acceptance rate?", "Brown ED deadline?", "Yale acceptance rate 2026"]) {
      assert.equal(isLookupQuestion(q, "deadlines"), true, q);
    }
    for (const q of ["Should I apply early decision to Brown?", "How do acceptance rates work?", "What does early action mean for my chances?", "Is a 4% acceptance rate realistic for me?", "I missed the deadline, what do I do?", "What's the typical ED deadline?"]) {
      assert.equal(isLookupQuestion(q, "deadlines"), false, q);
    }
    assert.equal(isLookupQuestion("When is MIT's deadline?", "financial_amounts"), false);
  });

  // gate-11: activity and course wording that happens to contain a topic
  // word ("afford", "pay attention", "$500", "regulations", "student
  // privacy", "deadlines for school projects") got the regulated advisory
  // prefix and a financial-aid-office footer on an EC answer.
  it("keeps ordinary EC and academic wording out of the regulated and high-stakes gates", () => {
    for (const question of [
      "I can't afford to waste time on a fifth AP",
      "How much should I pay attention to rankings",
      "I earned $500 from my tutoring business",
      "I interned on EPA regulations at a law firm",
      "In Model UN I chaired a committee on compliance with climate treaties",
      "AP Gov has a unit on regulations, is it a good class?",
      "My app project is about student privacy online",
      "How do I manage deadlines for school projects and robotics?",
      "I want to write about my rolling admissions experience at the summer program",
      "I won a $500 scholarship from Rotary, should I put it in the activities list?",
    ]) {
      const { topicType } = classifyTopic(question);
      assert.notEqual(topicType, TOPIC_TYPES.REGULATED, question);
      assert.notEqual(topicType, TOPIC_TYPES.HIGH_STAKES, question);
    }
  });

  it("still gates the money, law, privacy and deadline questions beside that wording", () => {
    const cases = [
      ["Can my family afford Northwestern?", "financial_amounts"],
      ["How much will I have to pay at USC?", "financial_amounts"],
      ["Is $80,000 a year too much for tuition?", "financial_amounts"],
      ["Is NYU affordable for a middle-income family?", "financial_amounts"],
      ["Is my school in compliance with Title IX?", "legal_compliance"],
      ["My school keeps violating its own regulations on grade appeals", "legal_compliance"],
      ["What are my student privacy rights?", "ferpa"],
      ["When is the Common App deadline for Michigan?", "deadlines"],
      ["What are the college application deadlines this month?", "deadlines"],
      ["Does Penn State have rolling admissions?", "deadlines"],
    ];
    for (const [question, subIntent] of cases) {
      assert.equal(classifyTopic(question).subIntent, subIntent, question);
    }
  });

  // gate-12: every topic pattern was English, so a Korean deadline, statistics,
  // cost or aid question was ordinary coaching: no advisory prefix, no
  // on-demand read of the school's pages, no no-source reply.
  it("sends Korean deadline, statistics, cost and aid questions through the same gates", () => {
    const cases = [
      ["스탠퍼드 조기 지원 마감일이 언제예요?", TOPIC_TYPES.HIGH_STAKES, "deadlines", true],
      ["코넬 얼리 디시전 마감 언제야?", TOPIC_TYPES.HIGH_STAKES, "deadlines", true],
      ["MIT 원서 접수는 언제까지예요?", TOPIC_TYPES.HIGH_STAKES, "deadlines", true],
      ["MIT 합격률이 몇 퍼센트예요?", TOPIC_TYPES.HIGH_STAKES, "official_stats", true],
      ["UCLA 평균 SAT 점수가 몇 점이에요?", TOPIC_TYPES.HIGH_STAKES, "official_stats", true],
      ["하버드 등록금이 얼마예요?", TOPIC_TYPES.HIGH_STAKES, "financial_amounts", false],
      ["재정 지원 신청은 어떻게 해요?", TOPIC_TYPES.HIGH_STAKES, "financial_amounts", false],
      ["국제학생도 니드 블라인드인가요?", TOPIC_TYPES.REGULATED, "financial_aid_policy", false],
      ["영주권자도 연방 재정 지원을 받을 수 있나요?", TOPIC_TYPES.REGULATED, "fafsa", false],
    ];
    for (const [question, topicType, subIntent, lookup] of cases) {
      const result = classifyTopic(question);
      assert.equal(result.topicType, topicType, question);
      assert.equal(result.subIntent, subIntent, question);
      assert.equal(isLookupQuestion(question, result.subIntent), lookup, question);
    }
  });

  it("keeps Korean strategy questions and ordinary Korean counseling words out of the lookup gate", () => {
    // Guidance, not a lookup: answered with what is held, never refused.
    assert.equal(isLookupQuestion("얼리 디시전 지원해야 할까요?", "deadlines"), false);
    assert.equal(isLookupQuestion("합격률이 중요한가요?", "official_stats"), false);
    assert.equal(isLookupQuestion("마감 전에 에세이를 어떻게 준비할까요?", "deadlines"), false);
    for (const question of [
      "얼리 디시전 지원해야 할까요?",
      "에세이 주제 추천해 주세요",
      "숙제 마감일이 내일이라 너무 바빠요",
      "동아리 프로젝트 마감이 언제인지 몰라요",
      "AP 하나 더 듣는 기회비용이 클까요?",
      "SAT 공부를 얼마나 해야 할까요?",
    ]) {
      const { topicType } = classifyTopic(question);
      assert.notEqual(topicType, TOPIC_TYPES.HIGH_STAKES, question);
      assert.notEqual(topicType, TOPIC_TYPES.REGULATED, question);
    }
  });

  it("allows general cost/aid-amount questions as labeled guidance while deadlines stay gated", () => {
    const cost = enforceGates(TOPIC_TYPES.HIGH_STAKES, "financial_amounts", []);
    assert.equal(cost.allowed, true);
    assert.ok(cost.generalGuidance);
    const deadlines = enforceGates(TOPIC_TYPES.HIGH_STAKES, "deadlines", []);
    assert.equal(deadlines.allowed, false);
    const stats = enforceGates(TOPIC_TYPES.HIGH_STAKES, "official_stats", []);
    assert.equal(stats.allowed, false);
  });
});
