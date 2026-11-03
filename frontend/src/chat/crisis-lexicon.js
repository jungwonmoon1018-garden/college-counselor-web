// Client-side crisis handling. The deterministic lexicon below is the same
// list the server keeps as PATTERNS.crisis in backend/chat/policy-router.js:
// the two used to be written separately, and by 2026-11 24 of 30 probe
// phrases disagreed. The client had no Hangul at all, the server missed
// "everyone would be better off without me", and a statement only the
// server caught came back as one dangling sentence with no hotline. Both
// copies are now built from the same fragments, and
// backend/tests/crisis-lexicon-parity.test.js fails CI if a pattern source,
// the shared case fixture (backend/tests/fixtures/crisis-lexicon-cases.json),
// the resource list or a footer differs between them. Change both together.
//
// Three tiers, decided on the student's question only (never an attachment
// or the context appendix):
//   • isCrisisStatement — a statement about the student's own safety (self-
//     harm, ideation, abuse, danger), English or Korean. Always the crisis
//     response, no model involved.
//   • isCrisisTopicMention — suicide, self-harm or overdose named as a topic
//     ("our suicide prevention club", "self-harm awareness week"). Answered
//     normally, with the 988 / 741741 resource footer appended: a prevention
//     club or a research project is application material, but the safety
//     net is never silently dropped.
//   • isDistressed — ordinary stress ("hopeless at chemistry", "overwhelmed").
//     Never blocks: the answer just gains the supportive footer.

// Text is matched after this normalization on both sides. iOS and macOS
// insert a typographic apostrophe by default, and "I’m not safe at home"
// missed both lexicons because every pattern spelled the apostrophe in
// ASCII; zero-width characters and line breaks split phrases the same way.
export function normalizeForLexicon(text) {
  let s = String(text ?? "");
  try { s = s.normalize("NFKC"); } catch { /* keep the raw text */ }
  return s
    .replace(/[‘’‚‛′‵ʻʼ´`＇]/g, "'")
    .replace(/[​-‏⁠﻿­]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Pattern fragments (identical in policy-router.js) ───
// A topic noun right after suicide / self-harm / overdose makes it a topic
// mention, not a disclosure: "suicide prevention club", "self-harm awareness
// week", "overdose prevention program", "the 988 Suicide & Crisis Lifeline".
// A third party's attempt ("my brother's suicide attempt") is not a topic
// noun and stays a crisis statement.
const TOPIC_NOUNS = String.raw`(?:prevention|awareness|research|rates?|statistics?|stats|clubs?|walks?|training|programs?|weeks?|months?|hotlines?|lifelines?)`;
const TOPIC_PAIR = String.raw`(?:suicide|self[\s-]?harm|overdose|crisis|mental[\s-]health|substance[\s-](?:use|abuse)|drug|opioid)s?`;
const TOPIC_TAIL = String.raw`(?![\s/&-]+(?:(?:and|or)[\s/&-]+)?${TOPIC_PAIR}[\s-]+${TOPIC_NOUNS}\b|[\s-]+${TOPIC_NOUNS}\b)`;
// Asking for a crisis line is a safety statement. With hotline and lifeline
// among the topic nouns, "I need the suicide hotline number" became a topic
// mention, answered only if a paid model call succeeded. A lifeline named as
// an activity ("a volunteer for the 988 Suicide & Crisis Lifeline") stays a
// topic.
//
// What follows the line's name tells a request from an activity. Stopping at
// the name gave "How do I get a suicide hotline volunteer position?" and "We
// added the crisis hotline number to every locker" the crisis reply. A role
// at the line, its possessive (other than its number) and its number put up
// somewhere are activities; "a suicide hotline volunteer to talk to" and "the
// suicide hotline's number" are still asked for.
const LINE_NAME = String.raw`(?:988\s+|national\s+)?(?:suicide|crisis|self[\s-]?harm)(?:\s+prevention)?(?:\s*(?:&|and)\s*crisis)?\s+(?:hot|life|text\s+)line`;
const LINE_PLACE = String.raw`(?:posters?|flyers?|fliers?|(?:student\s+)?ids?|id\s+cards?|lockers?|badges?|stickers?|banners?|bookmarks?|wristbands?|lanyards?|t-?shirts?|magnets?|bulletin\s+boards?|stalls?|mirrors?|hallways?|classrooms?)`;
const LINE_TAIL = String.raw`(?!\s+(?:volunteer(?:s|ing|ed)?\b(?!\s+(?:to\s+)?(?:talk|call|text|chat|speak)\b)|positions?\b|jobs?\b|roles?\b|trainings?\b|internships?\b|interns?\b|shifts?\b|clubs?\b|projects?\b|essays?\b|fundraisers?\b|campaigns?\b|research\b)|'s\s+(?!(?:phone\s+|text\s+|contact\s+)?(?:numbers?|phone|contact)\b)|(?:\s+(?:phone\s+)?numbers?)?\s+(?:on|onto|to|in|into|across|around|throughout|inside)\s+(?:[\w'-]+\s+){0,3}?${LINE_PLACE}\b)`;
// The student asks for the line: first person or addressed to the counselor,
// so a specialist's draft ("if you're looking for a crisis line") does not.
const LINE_ASK = String.raw`(?:i\s+(?:(?:really|just|urgently|desperately|seriously)\s+)?(?:need|want)(?:\s+to\s+(?:call|text|contact|reach|talk\s+to))?|(?:how|where)\s+(?:can|do|could|should)\s+i\s+(?:find|get|call|text|contact|reach)|can\s+i\s+(?:have|get|call|text|reach)|(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:find|get|send|share|text|look\s+up)|(?:i'm|im|i\s+am)\s+looking\s+for|do\s+you\s+(?:have|know)|is\s+there|(?:give|get|send|tell|show|find|text)\s+me|what(?:'s|\s+is)|where(?:'s|\s+is)|(?:phone\s+)?number\s+(?:for|of))`;
// With no asking words, the line's number is a request at the start of a
// sentence or with a question mark or please after it, and the line's name
// alone is one when it is the whole sentence ("Suicide hotline?").
const LINE_ALONE = String.raw`(?=(?:\s*(?:please|pls|plz|now|asap))*\s*(?:[?!]|\.?\s*$)|\s*(?:please|pls|plz)\b)`;
const LINE_BARE = String.raw`(?:^|[.!?;:]+\s*)(?:(?:please|pls|plz)\s+)?(?:need\s+)?(?:(?:the|a|an|your)\s+)?${LINE_NAME}(?:\s+(?:phone\s+)?number\b${LINE_TAIL}|s?${LINE_ALONE})|${LINE_NAME}\s+(?:phone\s+)?number(?=\s*(?:\?|(?:please|pls|plz|asap)\b))`;
const LINE_REQUEST = String.raw`${LINE_ASK}\s+(?:a|an|the|your)?\s*${LINE_NAME}s?\b${LINE_TAIL}|${LINE_BARE}`;
// "I hurt myself playing soccer" and "I cut myself off from social media"
// are about a sports injury and a phone, and both got the hotlines. The
// sports carve-out holds only while nothing later in the sentence says the
// injury was meant ("I hurt myself at practice on purpose" was skipped on
// both sides); "so I couldn't play junior season" stays answered. The look
// ahead stops at the end of the sentence and after 160 characters.
const SPORT_CONTEXT = String.raw`(?:playing|at\s+(?:practice|tryouts?|the\s+gym|(?:a|the)\s+(?:game|match|meet|race|tournament))|during\s+(?:practice|tryouts?|(?:a|the|my|our)\s+(?:\w+\s+)?(?:game|match|meet|race|season|tournament|practice|scrimmage))|in\s+(?:a|the|my)\s+(?:game|match|race|meet|tournament)|skiing|snowboarding|skating|running|lifting|training|practicing|working\s+out|dancing)`;
const HARM_INTENT = String.raw`(?:on\s+purpose|purposely|purposefully|intentionally|deliberately|to\s+(?:feel\s+(?:something|anything|better|pain|real|numb|in\s+control)|punish\s+myself)|because\s+i\s+(?:want|wanted|needed)\s+to\s+(?:feel|hurt|punish|die|disappear|escape|get\s+out|skip|miss|stop)|so\s+(?:that\s+)?i\s+(?:(?:wouldn'?t|won'?t|don'?t|didn'?t)\s+have\s+to|could\s+(?:skip|miss|stay\s+home|get\s+out|avoid)))\b`;
const HURT_IDIOM = String.raw`(?!\s+${SPORT_CONTEXT}(?![^.!?]{0,160}?\b${HARM_INTENT}))`;
const CUT_IDIOM = String.raw`(?!\s+(?:off|some\s+slack|short))`;
// "No reason to keep going with robotics" is about an activity; "no reason
// to keep going", "… with my life" and "… with any of this" are not.
const ACTIVITY_TAIL = String.raw`(?!\s+with\s+(?!(?:my\s+life|life|this|it|everything|anything|any\s+of\s+this)\b))`;
const RELATION = String.raw`(?:dad|father|mom|mother|parents?|step-?\w+|foster\s+\w+|grand(?:pa|ma|father|mother|parents?)|coach|teacher|tutor|boyfriend|girlfriend|partner|uncle|aunt|brother|sister|cousin|guardian|relative|neighbou?r|boss|pastor|priest)`;
const HARM_VERB = String.raw`(?:hits?|hitting|beats?|beating|abuses?|abused|abusing|touch(?:es|ed|ing)|molest(?:s|ed|ing)?|assault(?:s|ed|ing)?|hurts?|hurting|chok(?:es|ed|ing)|slap(?:s|ped|ping)?|punch(?:es|ed|ing)?)`;
const THIRD_PARTY_VERB = String.raw`(?:hits?|hitting|beats?|beating|abuses?|abused|abusing|touch(?:es|ed|ing)|molest(?:s|ed|ing)?|grooming|groomed|raped?|assault(?:s|ed|ing)?|chok(?:es|ed|ing)|slap(?:s|ped|ping)?|punch(?:es|ed|ing)?)`;
// An application emergency ("my Common App won't submit, it's an
// emergency") is not a safety statement; any other "it's an emergency" is.
const APPLICATION_WORDS = String.raw`(?:apps?|applications?|common\s+app|essays?|deadlines?|portal|submit\w*|upload\w*|forms?|fafsa|css\s+profile|transcripts?|homework|assignments?|exams?|tests?|quiz|sat|act|recommendations?|letters?|payments?|fees?|login|log\s+in|password|website)`;

const SELF_HARM_RE = new RegExp(String.raw`\b(?:suicid\w*\b${TOPIC_TAIL}|kill(?:ing)?\s+myself|self[\s-]?harm(?:ing|ed)?\b${TOPIC_TAIL}|(?:want|wanted|wanting|going|ready)\s+to\s+die|wanna\s+die|end(?:ing)?\s+my\s+(?:own\s+)?life|end\s+it\s+all|take\s+my\s+(?:own\s+)?life|hurt(?:ing)?\s+myself\b${HURT_IDIOM}|cut(?:ting)?\s+myself\b${CUT_IDIOM}|don'?t\s+want\s+to\s+(?:live|be\s+alive|wake\s+up|exist|be\s+here)|no\s+reason\s+to\s+(?:live|(?:go\s+on|keep\s+going)\b${ACTIVITY_TAIL})|better\s+off\s+dead|not\s+worth\s+living|wish\s+i\s+(?:was|were)\s+dead|overdos(?:e|ed|es|ing)\b${TOPIC_TAIL}|took\s+(?:too\s+many|a\s+(?:bunch|handful)\s+of|all\s+(?:of\s+)?(?:my|the))\s+(?:pills|meds|medications?|tablets)|${LINE_REQUEST})\b`, "i");
const ABUSE_RE = new RegExp(String.raw`\b(?:(?:my|our)\s+${RELATION}\s+(?:is\s+|keeps\s+|has\s+been\s+|always\s+|still\s+)?${HARM_VERB}\s+me|i(?:'?m|\s+am|\s+was|\s+have\s+been|'ve\s+been|\s+get|\s+got|\s+keep\s+getting)\s+(?:being\s+)?(?:(?:physically|sexually|emotionally|verbally)\s+)?(?:abused|molested|assaulted|raped|groomed|beaten)|(?:he|she|they|someone|somebody|an?\s+adult)\s+(?:is\s+|are\s+|keeps\s+|has\s+been\s+)?${THIRD_PARTY_VERB}\s+me|domestic\s+violence\s+(?:at|in)\s+(?:my\s+)?home)\b`, "i");
// A threat counts when it is a threat of harm: "they threatened me with
// detention" and "my teacher threatened me with a zero" are school discipline.
const THREAT_RE = new RegExp(String.raw`\bthreaten(?:s|ed|ing)?\s+(?:to\s+(?:hurt|kill|beat|hit|harm|rape|touch|shoot|stab)\s+me|me\b(?!\s+with\s+(?!(?:a\s+)?(?:knife|gun|weapon|violence|a\s+beating|death|bodily\s+harm|physical\s+harm)\b)))`, "i");
// "In danger of failing AP Chem" is grades; "in danger", "in danger at home"
// and "in danger of being hurt" are not.
const DANGER_RE = new RegExp(String.raw`\b(?:i(?:'?m|\s+am)\s+(?:in\s+danger\b(?!\s+of\s+(?!(?:being\s+)?(?:hurt|harmed|killed|attacked|beaten|abused|dying|death)\b))|not\s+safe|unsafe|(?:scared|afraid|terrified)\s+(?:for\s+my\s+life|to\s+go\s+(?:back\s+)?home))|i\s+(?:don'?t|do\s+not)\s+feel\s+safe\s+(?:at\s+home|at\s+school|anywhere|here|with\s+(?:my\s+)?\w+))\b`, "i");
const EMERGENCY_RE = new RegExp(String.raw`^(?![\s\S]*\b${APPLICATION_WORDS}\b)[\s\S]*\b(?:it'?s|it\s+is|this\s+is)\s+an?\s+emergency\b`, "i");
// Hopelessness about life itself. Never fires on academic despair ("I give
// up on this essay", "hopeless at chemistry").
export const IDEATION_RE = new RegExp(String.raw`\b(?:no\s+point\s+(?:in|to)\s+(?:living|anything|going\s+on)|better\s+(?:off\s+)?without\s+me|nobody\s+would\s+(?:care|notice|miss\s+me)|disappear\s+(?:forever|for\s+good)|(?:just\s+)?want\s+to\s+disappear\b(?!\s+(?:from|into|for\s+(?:a|the)\s+(?:bit|while|day|weekend)))|give\s+up\s+on\s+(?:life|everything)|can'?t\s+go\s+on(?:\s+like\s+this)?|hate\s+my\s+life|life\s+is(?:n'?t|\s+not)\s+worth|don'?t\s+see\s+the\s+point\s+(?:of|in)\s+(?:anything|living|life))\b`, "i");
// Korean, a first-class locale here. No \b: word boundaries behave poorly
// for CJK, so the lexemes are matched directly. Colloquial hyperbole
// ("화학 때문에 죽겠어요", "죽을 것 같이 바빠요") does not match. Asking for a
// crisis line's number ("자살 상담전화 번호 알려주세요") is a safety statement,
// as in English; volunteering at one stays a topic, and so does putting the
// number up ("번호를 사물함마다 붙였어요"), said after the number in Korean.
const KO_SELF_HARM_RE = /(자살(?!\s*(?:예방|방지|률|율|통계|연구|인식|캠페인|동아리|프로그램|교육|상담전화))|자해(?!\s*(?:예방|방지|인식|연구|통계|캠페인|동아리|프로그램|교육))|죽고\s*싶|목숨을\s*끊|극단적\s*선택|살기\s*싫|죽어\s*버리고\s*싶|살고\s*싶지\s*않|살\s*이유가\s*없|살\s*가치가\s*없|사라지고\s*싶|없어지고\s*싶|삶을\s*끝내|인생을\s*끝내|손목을\s*(?:긋|그었|그어)|(?:^|[^가-힣])(?:나|내가|제가|저)\s*(?:없으면|없는\s*게|없어지면)\s*(?:다들\s*|모두\s*|가족도\s*)?(?:더\s*)?(?:나을|낫|행복할)|(?:자살|자해)\s*(?:예방\s*)?(?:상담\s*)?(?:전화\s*)?번호(?![^.?!]{0,30}?(?:붙였|붙이자|붙여\s*놓|넣었|넣자|인쇄했|인쇄하자|새겼|게시했|배포했|나눠\s*줬|홍보했))|(?:자살|자해)\s*(?:예방\s*)?상담\s*(?:전화|센터)\s*(?:좀\s*)?(?:알려|가르쳐))/;
const KO_ABUSE_RE = /((?:학대|성추행|성폭행|폭행|가정폭력)(?:을|를)?\s*(?:당하|당했|당하고|받고|받았|겪|겪고)|(?:아빠|엄마|아버지|어머니|부모님|새아빠|새엄마|계부|계모|오빠|형|누나|언니|삼촌|이모|고모|할아버지|할머니|선생님|코치|남자\s*친구|남친|여자\s*친구|여친)(?:가|이|께서|는|은)?\s*(?:저를|나를|절|날)?\s*(?:자꾸\s*|계속\s*|매일\s*|또\s*)?(?:때려|때렸|때린|때리|해칠|해치려|만져|만졌|만지)|(?:아빠|엄마|아버지|어머니|부모님|새아빠|새엄마|계부|계모|오빠|형|누나|언니|삼촌|선생님|코치|남자\s*친구|남친|여자\s*친구|여친)(?:한테|에게|께)\s*(?:자꾸\s*|계속\s*|매일\s*|또\s*)?(?:맞고\s*있|맞았|맞아요|맞는다|맞아))/;
const KO_DANGER_RE = /(위험에\s*처|안전하지\s*않|저는\s*위험해|집에\s*가(?:기|는\s*(?:게|것이))\s*(?:무서|두려))/;

export const CRISIS_PATTERNS = Object.freeze([
  SELF_HARM_RE, ABUSE_RE, THREAT_RE, DANGER_RE, EMERGENCY_RE, IDEATION_RE,
  KO_SELF_HARM_RE, KO_ABUSE_RE, KO_DANGER_RE,
]);

// Suicide, self-harm, overdose or a crisis line ("the crisis hotline number
// on every locker") named anywhere. Checked only after the crisis patterns
// have said no, so it marks the topic-mention tier.
export const CRISIS_TOPIC_RE = /\b(?:suicid\w*|self[\s-]?harm\w*|overdos\w*|crisis\s+(?:hot|life|text\s+)lines?)\b|자살|자해/i;

export const DISTRESS_RE = /\b(?:hopeless|worthless|overwhelmed|burn(?:ed|t)\s*out|breaking\s+down|panic(?:king|\s+attacks?)?|can'?t\s+(?:cope|handle|take)\s+(?:this|it|any\s*more)|falling\s+apart|depress(?:ed|ing|ion)|anxiety|so\s+stressed|crying)\b|힘들어|힘들다|힘들고|스트레스|우울|불안해|지쳤|지쳐|절망|번아웃/i;

// True when the message itself states a risk to the student's safety.
export function isCrisisStatement(text) {
  const s = normalizeForLexicon(text);
  if (!s) return false;
  return CRISIS_PATTERNS.some((pattern) => pattern.test(s));
}

export function isCrisisTopicMention(text) {
  const s = normalizeForLexicon(text);
  if (!s || CRISIS_PATTERNS.some((pattern) => pattern.test(s))) return false;
  return CRISIS_TOPIC_RE.test(s);
}

export function isDistressed(text) {
  return DISTRESS_RE.test(normalizeForLexicon(text));
}

// ─── Resources and replies (identical in backend/chat/rules-engine.js) ───
// Korea consolidated 1393 and its other counseling lines into 109 in
// January 2024. The Korean list comes first in Korean, then the US lines,
// because a Korean-speaking student may be in either country.
const US_RESOURCES = Object.freeze([
  Object.freeze({ name: "Emergency services", contact: "911", description: "If you are in immediate danger", type: "emergency" }),
  Object.freeze({ name: "988 Suicide & Crisis Lifeline", contact: "988", description: "Call or text, 24/7", type: "crisis" }),
  Object.freeze({ name: "Crisis Text Line", contact: "Text HOME to 741741", description: "Free, 24/7", type: "crisis" }),
  Object.freeze({ name: "Childhelp National Child Abuse Hotline", contact: "1-800-422-4453", description: "24/7", type: "abuse" }),
]);
const KO_RESOURCES = Object.freeze([
  Object.freeze({ name: "자살예방상담전화", contact: "109", description: "24시간 상담", type: "crisis" }),
  Object.freeze({ name: "청소년상담전화", contact: "1388", description: "24시간 청소년 상담", type: "youth" }),
  Object.freeze({ name: "응급 신고", contact: "119", description: "지금 위험하거나 다쳤을 때", type: "emergency" }),
  Object.freeze({ name: "경찰", contact: "112", description: "폭력이나 위협이 있을 때", type: "emergency" }),
  Object.freeze({ name: "Emergency services (미국)", contact: "911", description: "미국에서 즉시 위험할 때", type: "emergency" }),
  Object.freeze({ name: "988 Suicide & Crisis Lifeline (미국)", contact: "988", description: "전화 또는 문자, 24시간", type: "crisis" }),
  Object.freeze({ name: "Crisis Text Line (미국)", contact: "Text HOME to 741741", description: "무료 문자 상담, 24시간", type: "crisis" }),
  Object.freeze({ name: "Childhelp 아동학대 핫라인 (미국)", contact: "1-800-422-4453", description: "24시간", type: "abuse" }),
]);

const CRISIS_COPY = Object.freeze({
  "en-US": Object.freeze({
    message: "It sounds like you may be going through something really hard. You don't have to handle it alone, and people who can help are available right now.",
    adult: "Please also reach out to a trusted adult: a parent, school counselor, teacher, or coach. Asking for help is a sign of strength.",
    disclaimer: "I'm an AI assistant and can't provide crisis counseling. Please contact one of these trained services.",
    resources: US_RESOURCES,
  }),
  ko: Object.freeze({
    message: "지금 많이 힘든 시간을 보내고 있는 것 같아요. 혼자 감당하지 않아도 돼요. 지금 바로 도움을 받을 수 있는 곳이 있어요.",
    adult: "부모님, 학교 상담 선생님, 선생님이나 코치처럼 믿을 수 있는 어른에게도 꼭 이야기해 주세요. 도움을 청하는 것은 용기 있는 일이에요.",
    disclaimer: "저는 AI 도우미라서 위기 상담을 제공할 수 없어요. 위의 전문 기관에 연락해 주세요.",
    resources: KO_RESOURCES,
  }),
});

function copyFor(locale) {
  return locale === "ko" ? CRISIS_COPY.ko : CRISIS_COPY["en-US"];
}

export function crisisResources(locale = "en-US") {
  return copyFor(locale).resources.map((resource) => ({ ...resource }));
}

export function crisisDisclaimer(locale = "en-US") {
  return copyFor(locale).disclaimer;
}

function resourceLine(resource) {
  const details = [resource.contact, resource.description].map((v) => String(v || "").trim()).filter(Boolean).join(" — ");
  return `- **${String(resource.name || "").trim()}:** ${details}`;
}

// The full crisis reply, resources written into the text itself. The server
// reply used to carry its hotlines only in a structured `actions` field that
// the chat formatter dropped, so the student saw "Please reach out to one of
// these resources:" and nothing after it.
export function crisisResponseText(locale = "en-US") {
  const copy = copyFor(locale);
  return [
    copy.message,
    copy.resources.map(resourceLine).join("\n"),
    copy.adult,
    `_${copy.disclaimer}_`,
  ].join("\n\n");
}

const TOPIC_FOOTERS = Object.freeze({
  "en-US": "\n\n_If this topic is close to home for you, support is available any time: call or text 988, or text HOME to 741741. If you are in immediate danger, call 911._",
  ko: "\n\n_이 주제가 개인적으로 와닿는다면 언제든 도움을 받을 수 있어요: 109(24시간 상담)나 청소년상담전화 1388에 연락하고, 위급하면 119나 112에 전화하세요. 미국에 있다면 988에 전화나 문자를 하거나 741741로 HOME을 보내세요._",
});

export function crisisResourceFooter(locale = "en-US") {
  return locale === "ko" ? TOPIC_FOOTERS.ko : TOPIC_FOOTERS["en-US"];
}

export const SUPPORT_FOOTER = "\n\n_If the stress is getting heavy, talking with a school counselor or another trusted adult really helps — and if you ever feel unsafe, you can call or text 988 any time._";
const SUPPORT_FOOTER_KO = "\n\n_스트레스가 너무 크게 느껴진다면 학교 상담 선생님이나 믿을 수 있는 어른과 이야기해 보세요. 혹시 위험하다고 느껴지면 언제든 109나 1388에 연락할 수 있어요(미국에서는 988)._";

export function supportFooter(locale = "en-US") {
  return locale === "ko" ? SUPPORT_FOOTER_KO : SUPPORT_FOOTER;
}

// Append the supportive footer once, never on top of the hotline text.
export function withSupport(text, needed, locale = "en-US") {
  if (!needed || typeof text !== "string" || !text.trim() || text.includes("988")) return text;
  return text + supportFooter(locale);
}

// Append the topic-mention resource footer once. The server appends the
// same footer to each answer; the client re-appends it after the
// supervisor merge and the validator, which may drop it.
export function withResourceFooter(text, needed, locale = "en-US") {
  if (!needed || typeof text !== "string" || !text.trim() || text.includes("741741")) return text;
  return text + crisisResourceFooter(locale);
}

// The footers are taken out of a draft before it goes to the supervisor or
// the validator (which re-send it to /api/chat) and put back at the end.
export function stripResourceFooters(text) {
  let s = String(text ?? "");
  for (const footer of [TOPIC_FOOTERS["en-US"], TOPIC_FOOTERS.ko, SUPPORT_FOOTER, SUPPORT_FOOTER_KO]) {
    s = s.split(footer).join("");
    s = s.split(footer.trim()).join("");
  }
  return s.trim();
}

// A deterministic crisis body from /api/chat or /api/council/convene. The
// chat route sets crisisSafe and topic_type "crisis"; _meta.topicType is
// what an older server sent, so it is honored too.
export function isCrisisReplyBody(body) {
  if (!body || typeof body !== "object") return false;
  if (body.crisisSafe === true) return true;
  if (String(body.topic_type || "").toLowerCase() === "crisis") return true;
  return String(body?._meta?.topicType || "").toUpperCase() === "CRISIS";
}

// The text a crisis body is shown as. A current server writes the resources
// into `answer`; an older one sent a bare sentence with structured actions,
// which are rendered here; with neither, the client's own reply is used.
export function formatCrisisReply(body = {}, locale = "en-US") {
  const answer = String(body?.answer || body?.message || "").trim();
  if (answer && /\b988\b|\b109\b/.test(answer)) return answer;
  const resources = Array.isArray(body?.actions) ? body.actions.filter(Boolean) : [];
  if (!resources.length) return crisisResponseText(locale);
  const ko = locale === "ko";
  const parts = [answer || copyFor(locale).message, ko ? "**즉시 이용할 수 있는 지원**" : "**Immediate support**"];
  for (const resource of resources) {
    if (typeof resource === "object") {
      const name = String(resource.name || resource.label || (ko ? "지원 기관" : "Support resource")).trim();
      parts.push(resourceLine({ name, contact: resource.contact || resource.url || "", description: resource.description || "" }).trim());
    } else {
      parts.push(`- ${String(resource).trim()}`);
    }
  }
  const limitations = Array.isArray(body?.limitations)
    ? body.limitations.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  parts.push(...limitations.map((item) => `_${item}_`));
  return parts.join("\n\n");
}

// The result orchestrate() and the Council send path return for a crisis
// turn: blocked (no persistence of the student's words, no counseling
// memory) and crisisSafe (the thread is titled "Support resources").
export function crisisTurnResult(text, locale = "en-US") {
  return { text: text || crisisResponseText(locale), blocked: true, crisisSafe: true };
}
