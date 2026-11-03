import { describe, it, expect } from "vitest";
import {
  CRISIS_PATTERNS,
  IDEATION_RE,
  SUPPORT_FOOTER,
  crisisResourceFooter,
  crisisResponseText,
  formatCrisisReply,
  isCrisisReplyBody,
  isCrisisStatement,
  isCrisisTopicMention,
  isDistressed,
  normalizeForLexicon,
  stripResourceFooters,
  withResourceFooter,
  withSupport,
} from "./crisis-lexicon.js";

describe("crisis statements", () => {
  it("catches explicit self-harm, abuse, and danger", () => {
    for (const text of [
      "I want to kill myself",
      "i dont want to be alive anymore",
      "my dad hits me when I fail a test",
      "I am being abused at home",
      "someone is threatening to hurt me",
      "I'm not safe at home",
      "there's no point in going on",
      "everyone would be better off without me",
    ]) expect(isCrisisStatement(text), text).toBe(true);
  });
  it("does not fire on topic words or academic stress", () => {
    for (const text of [
      "How should I end my personal statement?",
      "I volunteer in the hospital emergency department",
      "I'm hopeless at chemistry and my application feels hopeless",
      "I want to kill this essay draft and start over",
      "I'm so overwhelmed with APs, what should I drop?",
      "my research is on child abuse prevention policy",
      "the danger of procrastination",
      "I'm dying to get into MIT",
    ]) expect(isCrisisStatement(text), text).toBe(false);
    expect(isCrisisStatement("hopeless")).toBe(false);
    expect(IDEATION_RE.test("I give up on this essay")).toBe(false);
  });

  // The server's lexicon caught these and the client's did not: no Hangul,
  // no home-safety phrases, no third-party abuse.
  it("catches what only the server used to catch", () => {
    for (const text of [
      "죽고 싶어요",
      "자해를 했어요",
      "아빠가 저를 때려요",
      "I don't feel safe at home",
      "He touched me and told me not to tell anyone",
      "there is no reason to live",
      "I'm scared to go home",
      "ending my life",
    ]) expect(isCrisisStatement(text), text).toBe(true);
  });

  it("matches typographic apostrophes the way it matches ASCII ones", () => {
    expect(normalizeForLexicon("I’m​ not\nsafe")).toBe("I'm not safe");
    for (const text of ["I’m not safe at home", "I don’t want to live anymore", "I’m being abused by my stepdad"]) {
      expect(isCrisisStatement(text), text).toBe(true);
    }
    expect(isCrisisStatement("I’m hopeless at chemistry")).toBe(false);
  });

  it("answers the idioms that used to get the hotlines, and keeps the statements beside them", () => {
    for (const text of [
      "I'm in danger of failing AP Chem, what should I do?",
      "I hurt myself playing soccer and missed junior season",
      "I cut myself off from social media",
      "They threatened me with detention",
      "My teacher threatened me with a zero",
      "It's an emergency, my Common App won't submit",
    ]) expect(isCrisisStatement(text), text).toBe(false);
    for (const text of ["I'm in danger at home", "I want to hurt myself", "I cut myself", "he threatened to kill me", "this is an emergency, please help"]) {
      expect(isCrisisStatement(text), text).toBe(true);
    }
  });

  it("does not let a pattern carry state between calls", () => {
    for (const pattern of CRISIS_PATTERNS) expect(pattern.global || pattern.sticky).toBe(false);
    expect(isCrisisStatement("I want to kill myself")).toBe(true);
    expect(isCrisisStatement("I want to kill myself")).toBe(true);
  });
});

// Two fix passes on the crisis-line request overshot in turn. A sentence
// that asks for the line is a request unless an activity construction about
// the line is in the same sentence; the shared fixture holds every phrasing a
// verifier listed, and these pairs keep each direction in view here.
describe("crisis lines", () => {
  it("answers a line named as an activity and keeps the request beside it", () => {
    const pairs = [
      ["Is there a suicide hotline at my school I could volunteer for?", "is there a suicide hotline I can call?"],
      ["Is there a suicide hotline near me that takes teen volunteers?", "anyone have the suicide hotline number"],
      ["I’m looking for a crisis hotline to volunteer at this summer", "I’m looking for a crisis hotline"],
      ["How do I get a suicide hotline volunteer position?", "I need a crisis hotline volunteer please"],
      ["What is the suicide hotline’s role in my essay about my volunteer work?", "I need the suicide hotline’s help"],
      ["We added the crisis hotline number to every locker", "I need to call the suicide hotline in the bathroom stall"],
      ["자살예방상담전화 번호를 사물함마다 넣었어요", "자살예방상담전화 번호 넣었는데 전화가 안 돼요"],
    ];
    for (const [activity, request] of pairs) {
      expect(isCrisisStatement(activity), activity).toBe(false);
      expect(isCrisisTopicMention(activity), activity).toBe(true);
      expect(isCrisisStatement(request), request).toBe(true);
    }
  });

  it("reads the line's number as a request with or without a frame", () => {
    for (const text of ["whats the suicide hotline number", "whats the suicide hotline number.", "hi suicide hotline number", "u got the suicide hotline number", "help! suicide hotline"]) {
      expect(isCrisisStatement(text), text).toBe(true);
    }
  });
});

describe("topic mentions", () => {
  it("are not crisis statements but get the resource footer", () => {
    for (const text of ["our school's suicide prevention club needs a fundraiser idea", "We run a self-harm awareness week", "자살 예방 동아리를 만들었어요"]) {
      expect(isCrisisStatement(text), text).toBe(false);
      expect(isCrisisTopicMention(text), text).toBe(true);
    }
    expect(isCrisisTopicMention("I'm suicidal")).toBe(false); // a statement, not a topic
    expect(isCrisisTopicMention("Which APs should I take?")).toBe(false);
  });

  it("appends the footer once and strips it for re-sending", () => {
    const once = withResourceFooter("Hold a bake sale.", true);
    expect(once).toMatch(/988[\s\S]*741741/);
    expect(withResourceFooter(once, true)).toBe(once);
    expect(withResourceFooter("Hold a bake sale.", false)).toBe("Hold a bake sale.");
    expect(stripResourceFooters(once)).toBe("Hold a bake sale.");
    expect(stripResourceFooters(`A.${crisisResourceFooter("ko")}\n\nB.`)).toBe("A.\n\nB.");
    // The topic footer already names 988, so the stress footer is not added on top.
    expect(withSupport(once, true)).toBe(once);
  });
});

describe("crisis replies", () => {
  it("lists the owner's resource set in each language", () => {
    const en = crisisResponseText("en-US");
    for (const line of ["911", "988", "741741", "1-800-422-4453"]) expect(en).toContain(line);
    expect(en).not.toMatch(/1388|1393/);
    const ko = crisisResponseText("ko");
    for (const line of ["109", "1388", "119", "112", "911", "988", "741741", "1-800-422-4453"]) expect(ko).toContain(line);
    expect(ko).not.toMatch(/1393|1577-0199/);
    expect(ko.indexOf("109")).toBeLessThan(ko.indexOf("988"));
  });

  it("recognizes a crisis body by crisisSafe, topic_type or an older server's _meta", () => {
    expect(isCrisisReplyBody({ crisisSafe: true })).toBe(true);
    expect(isCrisisReplyBody({ topic_type: "crisis" })).toBe(true);
    expect(isCrisisReplyBody({ answer: "x", _meta: { topicType: "CRISIS" } })).toBe(true);
    expect(isCrisisReplyBody({ answer: "x", topic_type: "coaching", _meta: { topicType: "coaching" } })).toBe(false);
    expect(isCrisisReplyBody(null)).toBe(false);
  });

  // The pre-2026-11 server body: one sentence, resources only in actions.
  it("renders an older server's bare sentence with its resources, never [object Object]", () => {
    const text = formatCrisisReply({
      answer: "It sounds like you may be going through a difficult time. Please reach out to one of these resources:",
      actions: [{ name: "Suicide & Crisis Lifeline", contact: "988", description: "24/7" }],
      limitations: ["I'm an AI assistant."],
      _meta: { topicType: "CRISIS" },
    });
    expect(text).toMatch(/988/);
    expect(text).not.toMatch(/\[object Object\]/);
    expect(formatCrisisReply({ _meta: { topicType: "CRISIS" } }, "ko")).toBe(crisisResponseText("ko"));
    expect(formatCrisisReply({ answer: crisisResponseText("en-US"), actions: [{ name: "x", contact: "988" }] })).toBe(crisisResponseText("en-US"));
  });
});

describe("distress footer", () => {
  it("marks ordinary stress and appends the footer once", () => {
    expect(isDistressed("I'm hopeless at chemistry")).toBe(true);
    expect(isDistressed("시험 때문에 힘들어")).toBe(true);
    expect(isDistressed("Which APs should I take?")).toBe(false);
    const once = withSupport("Focus on the labs first.", true);
    expect(once.endsWith(SUPPORT_FOOTER)).toBe(true);
    expect(withSupport(once, true)).toBe(once);
    expect(withSupport("Focus on the labs first.", false)).toBe("Focus on the labs first.");
    expect(withSupport("", true)).toBe("");
    expect(withSupport("실험부터 하세요.", true, "ko")).toMatch(/109[\s\S]*1388/);
  });
});
