// ═══════════════════════════════════════════════════════════════════════
// POLICY ROUTER — Deterministic topic classification and compliance gates
// ═══════════════════════════════════════════════════════════════════════
// This module is the first layer in the request pipeline. It classifies
// every incoming query into a topic type, determines source constraints,
// selects the appropriate model tier, and enforces compliance gates.
//
// IMPORTANT: This module is 100% deterministic — no LLM calls.
// ═══════════════════════════════════════════════════════════════════════

import { llmDebug } from "../llm-adapters/llm-log.js";

// ─── Topic Type Definitions ───
// regulated:     FAFSA, FERPA, eligibility, legal, compliance
// high_stakes:   Deadlines, school policies, financial aid amounts, scholarship eligibility
// coaching:      EC strategy, essay brainstorming, activity suggestions, college list building
// administrative: Profile updates, data export, account management
// crisis:        Self-harm, abuse, emergency
export const TOPIC_TYPES = {
  REGULATED: "regulated",
  HIGH_STAKES: "high_stakes",
  COACHING: "coaching",
  ADMINISTRATIVE: "administrative",
  CRISIS: "crisis",
};

// ─── Model Tiers ───
// The tier enum keeps the HAIKU / SONNET / OPUS names for backward
// compatibility (existing call sites across orchestration-engine,
// ec-strength-vectorizer, and ap-concept-vectorizer reference them
// directly). The SMALL / MEDIUM / LARGE aliases point at the same
// values — new code should prefer the provider-agnostic names.
//   small  = routing, extraction, classification, moderation, OCR validation
//   medium = source-grounded coaching, synthesis, trend analysis
//   large  = complex synthesis, conflict resolution, essay critique
export const MODEL_TIERS = {
  NONE: "none",
  HAIKU: "haiku",
  SONNET: "sonnet",
  OPUS: "opus",
  // Provider-agnostic aliases — mapped 1:1 to the names above.
  SMALL: "haiku",
  MEDIUM: "sonnet",
  LARGE: "opus",
  // Strategy Council (Pillar 9). Dispatched to council.convene() instead
  // of callLLM. Council execution is explicit and sequential.
  COUNCIL: "council",
};

// Subintents that should convene the 5-seat Strategy Council instead of
// hitting a single model. Per the Pillar 9 design these are the truly
// high-stakes strategic decisions — everything else stays on the single-
// model tier ladder.
export const STRATEGY_COUNCIL_SUBINTENTS = new Set([
  "ec_strategy",
  "essay",
  "college_list",
  "strategy",
  "course_planning", // "what courses/APs should I take next year" — high-stakes
]);

// ─── Escalation threshold: Sonnet must report confidence below this to escalate to Opus ───
const OPUS_ESCALATION_THRESHOLD = 0.45;

// ─── Crisis lexicon ───
// Deterministic crisis triggers are STATEMENTS ABOUT THE STUDENT'S OWN
// SAFETY, not topic words. The earlier lexicon fired on bare "abuse",
// "emergency", "danger", "threatened" and on "end my …" — so "how do I end
// my essay?" and "I volunteer in the emergency room" got the crisis
// hotlines instead of an answer. Ordinary stress ("I'm hopeless at
// chemistry", "overwhelmed") is not a crisis: the client adds a supportive
// footer for that without blocking the answer.
//
// The client keeps the same list in frontend/src/chat/crisis-lexicon.js,
// built from the same fragments. The two were once written separately and
// drifted until 24 of 30 probe phrases disagreed (no Hangul on the client,
// no "better off without me" here); backend/tests/crisis-lexicon-parity.test.js
// now compares the pattern sources, the shared case fixture, the resource
// list and the footers, so change both files together.

// iOS and macOS insert a typographic apostrophe by default, and "I’m not
// safe at home" missed both lexicons because every pattern spelled the
// apostrophe in ASCII. Zero-width characters and line breaks split phrases
// the same way. Every crisis check matches the text after this.
export function normalizeForLexicon(text) {
  let s = String(text ?? "");
  try { s = s.normalize("NFKC"); } catch { /* keep the raw text */ }
  return s
    .replace(/[‘’‚‛′‵ʻʼ´`＇]/g, "'")
    .replace(/[​-‏⁠﻿­]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// A topic noun right after suicide / self-harm / overdose makes it a topic
// mention, not a disclosure: "suicide prevention club", "self-harm awareness
// week", "overdose prevention program", "the 988 Suicide & Crisis Lifeline".
// Students who run those programs could not get help presenting them. A
// third party's attempt ("my brother's suicide attempt") is not a topic noun
// and stays a crisis statement.
const TOPIC_NOUNS = String.raw`(?:prevention|awareness|research|rates?|statistics?|stats|clubs?|walks?|training|programs?|weeks?|months?|hotlines?|lifelines?)`;
const TOPIC_PAIR = String.raw`(?:suicide|self[\s-]?harm|overdose|crisis|mental[\s-]health|substance[\s-](?:use|abuse)|drug|opioid)s?`;
const TOPIC_TAIL = String.raw`(?![\s/&-]+(?:(?:and|or)[\s/&-]+)?${TOPIC_PAIR}[\s-]+${TOPIC_NOUNS}\b|[\s-]+${TOPIC_NOUNS}\b)`;
// Asking for a crisis line is a safety statement. With hotline and lifeline
// among the topic nouns, "I need the suicide hotline number" became a topic
// mention: it went to the gatekeeper and a paid model call, and a spent
// budget, a withdrawn consent or an outage left the student who asked for the
// number with an error note and no number. A lifeline named as an activity
// ("a volunteer for the 988 Suicide & Crisis Lifeline") stays a topic.
//
// What follows the line's name tells a request from an activity. The first
// request patterns stopped at the name, and a bare "suicide hotline number"
// fired anywhere, so "How do I get a suicide hotline volunteer position?",
// "What is the suicide hotline's role in my essay?" and "We added the crisis
// hotline number to every locker" got the crisis reply instead of an answer.
// A role at the line, its possessive (other than its number) and its number
// put up somewhere are activities. "A suicide hotline volunteer to talk to"
// and "the suicide hotline's number" are still asked for.
const LINE_NAME = String.raw`(?:988\s+|national\s+)?(?:suicide|crisis|self[\s-]?harm)(?:\s+prevention)?(?:\s*(?:&|and)\s*crisis)?\s+(?:hot|life|text\s+)line`;
const LINE_PLACE = String.raw`(?:posters?|flyers?|fliers?|(?:student\s+)?ids?|id\s+cards?|lockers?|badges?|stickers?|banners?|bookmarks?|wristbands?|lanyards?|t-?shirts?|magnets?|bulletin\s+boards?|stalls?|mirrors?|hallways?|classrooms?)`;
const LINE_TAIL = String.raw`(?!\s+(?:volunteer(?:s|ing|ed)?\b(?!\s+(?:to\s+)?(?:talk|call|text|chat|speak)\b)|positions?\b|jobs?\b|roles?\b|trainings?\b|internships?\b|interns?\b|shifts?\b|clubs?\b|projects?\b|essays?\b|fundraisers?\b|campaigns?\b|research\b)|'s\s+(?!(?:phone\s+|text\s+|contact\s+)?(?:numbers?|phone|contact)\b)|(?:\s+(?:phone\s+)?numbers?)?\s+(?:on|onto|to|in|into|across|around|throughout|inside)\s+(?:[\w'-]+\s+){0,3}?${LINE_PLACE}\b)`;
// The student asks for the line: "I need", "give me", "do you know", "is
// there", "how do I call". First person or addressed to the counselor, so a
// specialist's draft ("if you're looking for a crisis line") does not ask.
const LINE_ASK = String.raw`(?:i\s+(?:(?:really|just|urgently|desperately|seriously)\s+)?(?:need|want)(?:\s+to\s+(?:call|text|contact|reach|talk\s+to))?|(?:how|where)\s+(?:can|do|could|should)\s+i\s+(?:find|get|call|text|contact|reach)|can\s+i\s+(?:have|get|call|text|reach)|(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:find|get|send|share|text|look\s+up)|(?:i'm|im|i\s+am)\s+looking\s+for|do\s+you\s+(?:have|know)|is\s+there|(?:give|get|send|tell|show|find|text)\s+me|what(?:'s|\s+is)|where(?:'s|\s+is)|(?:phone\s+)?number\s+(?:for|of))`;
// With no asking words, the line's number is a request at the start of a
// sentence ("Suicide hotline number please", "the suicide hotline number")
// or with a question mark or please after it, and the line's name alone is
// one when it is the whole sentence ("Suicide hotline?"). "Our club printed
// the suicide hotline number on posters" describes a project.
const LINE_ALONE = String.raw`(?=(?:\s*(?:please|pls|plz|now|asap))*\s*(?:[?!]|\.?\s*$)|\s*(?:please|pls|plz)\b)`;
const LINE_BARE = String.raw`(?:^|[.!?;:]+\s*)(?:(?:please|pls|plz)\s+)?(?:need\s+)?(?:(?:the|a|an|your)\s+)?${LINE_NAME}(?:\s+(?:phone\s+)?number\b${LINE_TAIL}|s?${LINE_ALONE})|${LINE_NAME}\s+(?:phone\s+)?number(?=\s*(?:\?|(?:please|pls|plz|asap)\b))`;
const LINE_REQUEST = String.raw`${LINE_ASK}\s+(?:a|an|the|your)?\s*${LINE_NAME}s?\b${LINE_TAIL}|${LINE_BARE}`;
// "I hurt myself playing soccer" and "I cut myself off from social media"
// are about a sports injury and a phone, and both got the hotlines. The
// sports carve-out holds only while nothing later in the sentence says the
// injury was meant: it used to skip "I hurt myself at practice on purpose"
// and "… during the game because I wanted to feel something" on both sides.
// "So I couldn't play junior season" is what an injury did, not a purpose,
// and stays answered. The look ahead stops at the end of the sentence and
// after 160 characters, so a long run of sports phrases stays linear.
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

// Korean lexemes for the regulated and high-stakes gates. Korean is a
// first-class locale, and until 2026-11-03 every topic pattern was English:
// "스탠퍼드 조기 지원 마감일이 언제예요?" and "하버드 등록금이 얼마예요?" were
// ordinary coaching, with no advisory prefix, no on-demand read of the
// school's pages and no no-source reply (gate-12). No \b, which does not
// work between Hangul syllables. A homework, project or club word right
// before 마감 keeps a class deadline out, as "deadlines for school projects"
// stays out in English; 기회비용 (opportunity cost) is not a price.
const KO_NOT_ADMISSIONS = String.raw`(?:숙제|과제|프로젝트|리포트|보고서|동아리|대회)`;
const KO_TOPIC = Object.freeze({
  fafsa: String.raw`연방\s*(?:학생\s*)?(?:재정\s*)?(?:지원|보조)|연방\s*학자금`,
  financial_aid_policy: String.raw`니드\s*(?:블라인드|어웨어)|css\s*프로(?:필|파일)|재정\s*(?:지원|보조)\s*정책`,
  deadlines: String.raw`(?<!${KO_NOT_ADMISSIONS}\s?)마감\s*(?:일|날짜|기한|일자)|(?<!${KO_NOT_ADMISSIONS}\s?)마감(?:이|은|는)?\s*언제|(?:지원|원서|전형|얼리|조기|정시|디시전|액션|fafsa|css)[^.?!]{0,12}마감|원서\s*접수|(?:지원|접수|제출|신청)\s*(?:기한|기간)|언제까지\s*(?:지원|원서|접수|제출|신청)`,
  financial_amounts: String.raw`학비|등록금|기숙사비|(?<!기회\s?)비용[^.?!]{0,10}(?:얼마|어느\s*정도)|(?:총|연간|1년|일년|대학)\s*비용|돈이?\s*얼마|장학금[^.?!]{0,20}(?:얼마|금액|액수|전액)|재정\s*(?:지원|보조)|학자금|순\s*비용|(?:펠|페일)\s*그랜트|메리트\s*(?:장학금|에이드)|근로\s*장학`,
  official_stats: String.raw`합격률|합격\s*비율|경쟁률|입학률|평균\s*(?:sat|act|gpa|내신)|(?:sat|act)\s*(?:점수\s*)?(?:범위|평균|중간\s*50)|중간\s*50\s*%`,
});

function withKorean(pattern, korean) {
  return new RegExp(`${pattern.source}|${korean}`, pattern.flags);
}

const PATTERNS = {
  crisis: [
    // Self-harm / suicidal ideation, first person.
    new RegExp(String.raw`\b(?:suicid\w*\b${TOPIC_TAIL}|kill(?:ing)?\s+myself|self[\s-]?harm(?:ing|ed)?\b${TOPIC_TAIL}|(?:want|wanted|wanting|going|ready)\s+to\s+die|wanna\s+die|end(?:ing)?\s+my\s+(?:own\s+)?life|end\s+it\s+all|take\s+my\s+(?:own\s+)?life|hurt(?:ing)?\s+myself\b${HURT_IDIOM}|cut(?:ting)?\s+myself\b${CUT_IDIOM}|don'?t\s+want\s+to\s+(?:live|be\s+alive|wake\s+up|exist|be\s+here)|no\s+reason\s+to\s+(?:live|(?:go\s+on|keep\s+going)\b${ACTIVITY_TAIL})|better\s+off\s+dead|not\s+worth\s+living|wish\s+i\s+(?:was|were)\s+dead|overdos(?:e|ed|es|ing)\b${TOPIC_TAIL}|took\s+(?:too\s+many|a\s+(?:bunch|handful)\s+of|all\s+(?:of\s+)?(?:my|the))\s+(?:pills|meds|medications?|tablets)|${LINE_REQUEST})\b`, "i"),
    // Abuse, assault, grooming — the student says it is happening to them.
    new RegExp(String.raw`\b(?:(?:my|our)\s+${RELATION}\s+(?:is\s+|keeps\s+|has\s+been\s+|always\s+|still\s+)?${HARM_VERB}\s+me|i(?:'?m|\s+am|\s+was|\s+have\s+been|'ve\s+been|\s+get|\s+got|\s+keep\s+getting)\s+(?:being\s+)?(?:(?:physically|sexually|emotionally|verbally)\s+)?(?:abused|molested|assaulted|raped|groomed|beaten)|(?:he|she|they|someone|somebody|an?\s+adult)\s+(?:is\s+|are\s+|keeps\s+|has\s+been\s+)?${THIRD_PARTY_VERB}\s+me|domestic\s+violence\s+(?:at|in)\s+(?:my\s+)?home)\b`, "i"),
    // A threat of harm. "They threatened me with detention" and "my teacher
    // threatened me with a zero" are school discipline, not danger.
    new RegExp(String.raw`\bthreaten(?:s|ed|ing)?\s+(?:to\s+(?:hurt|kill|beat|hit|harm|rape|touch|shoot|stab)\s+me|me\b(?!\s+with\s+(?!(?:a\s+)?(?:knife|gun|weapon|violence|a\s+beating|death|bodily\s+harm|physical\s+harm)\b)))`, "i"),
    // Immediate danger — the student says they are not safe right now.
    // "In danger of failing AP Chem" is grades; "in danger", "in danger at
    // home" and "in danger of being hurt" are not.
    new RegExp(String.raw`\b(?:i(?:'?m|\s+am)\s+(?:in\s+danger\b(?!\s+of\s+(?!(?:being\s+)?(?:hurt|harmed|killed|attacked|beaten|abused|dying|death)\b))|not\s+safe|unsafe|(?:scared|afraid|terrified)\s+(?:for\s+my\s+life|to\s+go\s+(?:back\s+)?home))|i\s+(?:don'?t|do\s+not)\s+feel\s+safe\s+(?:at\s+home|at\s+school|anywhere|here|with\s+(?:my\s+)?\w+))\b`, "i"),
    new RegExp(String.raw`^(?![\s\S]*\b${APPLICATION_WORDS}\b)[\s\S]*\b(?:it'?s|it\s+is|this\s+is)\s+an?\s+emergency\b`, "i"),
    // Hopelessness about life itself, which the client always treated as a
    // crisis and this list did not ("everyone would be better off without
    // me" went to a paid Strategy Council review). Never fires on academic
    // despair ("I give up on this essay").
    new RegExp(String.raw`\b(?:no\s+point\s+(?:in|to)\s+(?:living|anything|going\s+on)|better\s+(?:off\s+)?without\s+me|nobody\s+would\s+(?:care|notice|miss\s+me)|disappear\s+(?:forever|for\s+good)|(?:just\s+)?want\s+to\s+disappear\b(?!\s+(?:from|into|for\s+(?:a|the)\s+(?:bit|while|day|weekend)))|give\s+up\s+on\s+(?:life|everything)|can'?t\s+go\s+on(?:\s+like\s+this)?|hate\s+my\s+life|life\s+is(?:n'?t|\s+not)\s+worth|don'?t\s+see\s+the\s+point\s+(?:of|in)\s+(?:anything|living|life))\b`, "i"),
    // Korean (a first-class locale here, with Korean crisis hotlines). No \b —
    // word boundaries behave poorly for CJK; match the lexemes directly.
    // Colloquial hyperbole ("화학 때문에 죽겠어요", "죽을 것 같이 바빠요")
    // does not match. Asking for a crisis line's number ("자살 상담전화 번호
    // 알려주세요") is a safety statement, as in English; volunteering at one
    // ("자살예방상담전화에서 봉사했어요") stays a topic, and so does putting the
    // number up ("번호를 사물함마다 붙였어요", "학생증에 번호를 넣자고"), which
    // in Korean is said after the number.
    /(자살(?!\s*(?:예방|방지|률|율|통계|연구|인식|캠페인|동아리|프로그램|교육|상담전화))|자해(?!\s*(?:예방|방지|인식|연구|통계|캠페인|동아리|프로그램|교육))|죽고\s*싶|목숨을\s*끊|극단적\s*선택|살기\s*싫|죽어\s*버리고\s*싶|살고\s*싶지\s*않|살\s*이유가\s*없|살\s*가치가\s*없|사라지고\s*싶|없어지고\s*싶|삶을\s*끝내|인생을\s*끝내|손목을\s*(?:긋|그었|그어)|(?:^|[^가-힣])(?:나|내가|제가|저)\s*(?:없으면|없는\s*게|없어지면)\s*(?:다들\s*|모두\s*|가족도\s*)?(?:더\s*)?(?:나을|낫|행복할)|(?:자살|자해)\s*(?:예방\s*)?(?:상담\s*)?(?:전화\s*)?번호(?![^.?!]{0,30}?(?:붙였|붙이자|붙여\s*놓|넣었|넣자|인쇄했|인쇄하자|새겼|게시했|배포했|나눠\s*줬|홍보했))|(?:자살|자해)\s*(?:예방\s*)?상담\s*(?:전화|센터)\s*(?:좀\s*)?(?:알려|가르쳐))/,
    /((?:학대|성추행|성폭행|폭행|가정폭력)(?:을|를)?\s*(?:당하|당했|당하고|받고|받았|겪|겪고)|(?:아빠|엄마|아버지|어머니|부모님|새아빠|새엄마|계부|계모|오빠|형|누나|언니|삼촌|이모|고모|할아버지|할머니|선생님|코치|남자\s*친구|남친|여자\s*친구|여친)(?:가|이|께서|는|은)?\s*(?:저를|나를|절|날)?\s*(?:자꾸\s*|계속\s*|매일\s*|또\s*)?(?:때려|때렸|때린|때리|해칠|해치려|만져|만졌|만지)|(?:아빠|엄마|아버지|어머니|부모님|새아빠|새엄마|계부|계모|오빠|형|누나|언니|삼촌|선생님|코치|남자\s*친구|남친|여자\s*친구|여친)(?:한테|에게|께)\s*(?:자꾸\s*|계속\s*|매일\s*|또\s*)?(?:맞고\s*있|맞았|맞아요|맞는다|맞아))/,
    /(위험에\s*처|안전하지\s*않|저는\s*위험해|집에\s*가(?:기|는\s*(?:게|것이))\s*(?:무서|두려))/,
  ],
  regulated: {
    fafsa: withKorean(/\bfafsa\b|\bstudent\s*aid\s*index\b|\bsai\b|\befc\b|\bexpected\s*family\s*contribution\b|\bfederal\s*student\s*aid\b|\bstudentaid\.gov\b|\bfsa\s*id\b|\bcontributor\b.*\bfafsa\b/i, KO_TOPIC.fafsa),
    // "school records" alone is how students describe their transcript; the
    // regulated sense needs a rights / access / disclosure word nearby.
    // "Student privacy" likewise: "my app project is about student privacy
    // online" is an activity, "my student privacy rights" is FERPA.
    ferpa: /\bferpa\b|\bfamily\s*educational\s*rights\b|\bstudent\s*privacy\b(?=[^.?!]{0,40}\b(?:rights?|records?|ferpa|office)\b)|\b(?:education|school)\s+records?\b[^.?!]{0,60}\b(?:rights?|access|privacy|amend\w*|disclos\w*|release\w*|consent|request\w*|see|view)\b|\b(?:rights?|access|privacy|amend\w*|disclos\w*|release\w*|consent|request\w*)\b[^.?!]{0,60}\b(?:education|school)\s+records?\b/i,
    financial_aid_policy: withKorean(/\bneed[- ]blind\b|\bneed[- ]aware\b|\bcss\s*profile\b|\binstitutional\s*aid\b|\binstitutional\s*methodology\b|\bfinancial\s*aid\s*policy\b/i, KO_TOPIC.financial_aid_policy),
    // Federal-aid eligibility only. "Am I eligible for Princeton" and
    // scholarship qualification questions are coaching.
    eligibility: /\b(?:am\s+i|are\s+we|is\s+my\s+\w+|do\s+i|would\s+i|will\s+i|can\s+i)\s+(?:be\s+|still\s+)?(?:eligible|qualify|qualified)\b[^.?!]{0,60}\b(?:fafsa|federal|financial\s+aid|student\s+aid|pell|loans?|grants?|work[- ]study|aid)\b|\b(?:fafsa|federal\s+(?:student\s+)?aid|pell|financial\s+aid|student\s+aid)\b[^.?!]{0,40}\b(?:eligib\w*|qualif\w*)\b|\bcitizenship\s+requirement\b|\bselective\s+service\b/i,
    // Bare "legal" ("legal studies", "paralegal") is not a compliance
    // question, and neither are bare "compliance" and "regulations": an EPA
    // internship, a Model UN committee and an AP Gov unit all got the
    // regulated prefix and a Department of Education pointer. They count
    // here next to the student's own school.
    legal_compliance: /\blegal\s+(?:rights?|requirements?|obligations?|status|issues?|questions?)\b|\b(?:federal|state)\s+law\b|\btitle\s+ix\b|\bada\s+accommodations?\b|\b(?:my|our)\s+(?:high\s+)?(?:school|college|university|district)\b[^.?!]{0,60}\b(?:complian\w*|violat\w*|regulations?)\b|\b(?:complian\w*|violat\w*|regulations?)\b[^.?!]{0,40}\b(?:my|our)\s+(?:high\s+)?(?:school|college|university|district)\b/i,
  },
  high_stakes: {
    // "Early decision" on its own is a strategy topic ("should I apply
    // ED?"); it counts here only next to a date word. Rolling admissions at
    // a summer program or camp is an activity (and see ORDINARY_SENSE).
    deadlines: withKorean(/\bdeadlines?\b|\bdue\s+dates?\b|\bwhen\s+(?:is|are|do|does|did|will)\b[^.?!]{0,60}\b(?:due|deadline|close|open|apply\s+by)\b|\bpriority\s+deadline\b|\bapplications?\s+(?:closes?|opens?)\b|\brolling\s+admissions?\b(?![^.?!]{0,40}\b(?:summer|programs?|camps?|internships?|clubs?|experience)\b)/i, KO_TOPIC.deadlines),
    // Money questions, not every "how much" or "scholarship" mention. Bare
    // "afford" ("I can't afford to waste time on a fifth AP"), "pay
    // attention" and a dollar figure from a tutoring business were all
    // financial_amounts and ended an EC answer with "contact the college's
    // financial aid office". Afford counts with a family subject or a
    // college, tuition or cost object; a dollar figure next to a cost word.
    financial_amounts: withKorean(/\bhow\s+much\b[^.?!]{0,50}\b(?:costs?|tuition|pay(?!\s+attention)|aid|money|loans?|scholarships?|price|owe|borrow|expensive)\b|\b(?:tuition|net\s+price|sticker\s+price|cost\s+of\s+attendance|room\s+and\s+board)\b|\b(?:my\s+(?:family|parents?|mom|dad|mother|father)|we|our\s+family)\b[^.?!]{0,20}\bafford\b|\bafford(?:s|ed|ing)?\s+(?:to\s+(?:go|attend|pay|study|enroll|live)\b|(?:the\s+)?(?:college|colleges|universit\w*|tuition|costs?|price|fees?|out[- ]of[- ]state|private\s+(?:college|school|universit\w*))\b|it\b)|\baffordab(?:le|ility)\b(?![^.?!]{0,30}\b(?:summer|programs?|camps?|hobby|hobbies|equipment|supplies|laptops?|calculators?|books?)\b)|\b(?:pell|merit\s+aid|financial\s+aid|need[- ]based\s+aid|student\s+loans?|federal\s+loans?|work[- ]study|stipends?)\b|\b(?:scholarships?|grants?|loans?)\b[^.?!]{0,40}(?:\b(?:amount|worth|how\s+much|dollars?|cover|pays?|full[- ]ride|full\s+tuition|money)\b|\$)|\$\s?\d[\d,.]*\s*k?\b[^.?!]{0,40}\b(?:tuition|costs?|price|fees?|aid|loans?|per\s+year|a\s+year)\b|\b(?:tuition|costs?|price|fees?|aid|loans?)\b[^.?!]{0,40}\$\s?\d/i, KO_TOPIC.financial_amounts),
    school_policies: /\btest[- ]optional\b|\btest[- ]required\b|\bsuperscore\b|\bscore\s*choice\b|\bapplication\s*requirement\b|\brequired\s*document\b/i,
    official_stats: withKorean(/\bacceptance\s*rate\b|\badmission\s*rate\b|\bclass\s*profile\b|\bmiddle\s*50\b|\b(25th|75th)\s*percentile\b/i, KO_TOPIC.official_stats),
  },
  coaching: {
    ec_strategy: /\bextracurricular(s)?\b|\becs?\b|\bactivit(y|ies)\b|\bspike\b|\bhook\b|\bsummer\s*(program|activit|plan)\b|\bleadership\b|\bvolunteer\b|\binternship\b|\bresearch\b/i,
    essay: /\bessay\b|\bnarrative\b|\bpersonal\s*statement\b|\bsupplement\b|\bcommon\s*app\s*essay\b|\bwriting\b.*\b(help|review|feedback)\b/i,
    college_list: /\bcollege\s*list\b|\bschool\s*list\b|\breach\b|\bmatch\b|\bsafety\b|\btarget\b|\bchance\s*me\b|\bcan\s*i\s*get\s*in\b|\bfit\b|\bcompare\s*college/i,
    course_planning: /\bcourse\s*(selection|load|rigor|plan|planning|schedul)\b|\b(what|which)\s+(aps?|ib|honors|classes|courses|electives)\b|\b(classes|courses|schedule|curriculum)\b[^.?!]{0,40}\b(take|pick|choose|next\s+(year|semester|fall|spring))\b/i,
    strategy: /\bstrategy\b|\bplan\b|\broadmap\b|\b4[- ]year\b|\bjunior\s*year\b|\bsenior\s*year\b|\btimeline\b/i,
    gpa_benchmark: /\bgpa\b|\bsat\b|\bact\b|\bpercentile\b|\bbenchmark\b|\bhow\s*(do|does)\s*(my|i)\s*(compare|stack)\b/i,
  },
};

// A topic word used in its everyday sense. "How do I manage deadlines for
// school projects?" is about homework, not an admissions date, and got the
// official-source footer; a deadline counts only when nothing marks it as
// a class, club or program deadline, or when an admissions word is there
// too ("the summer program's application deadline" is still a lookup).
const NON_ADMISSIONS_DEADLINE_RE = /\b(?:projects?|homework|assignments?|lab\s+reports?|papers?|club|clubs|team|competitions?|science\s+fair|hackathons?|tournaments?|summer\s+programs?|camps?|internships?|newspaper|yearbook|job|shifts?|midterms?|finals)\b/i;
const ADMISSIONS_CONTEXT_RE = /\b(?:applications?|apply(?:ing)?|admissions?|early\s+(?:decision|action)|regular\s+decision|ed(?:\s?ii|2)?|r?ea|rd|fafsa|css|common\s+app|coalition|universit(?:y|ies)|colleges?|financial\s+aid|scholarships?|enroll\w*|deposits?|commit\w*|transcripts?)\b/i;
const ORDINARY_SENSE = Object.freeze({
  deadlines: (text) => NON_ADMISSIONS_DEADLINE_RE.test(text) && !ADMISSIONS_CONTEXT_RE.test(text),
});

const TOPIC_SOURCE_DOMAINS = Object.freeze({
  fafsa: ["studentaid.gov", "fsapartners.ed.gov"],
  eligibility: ["studentaid.gov", "fsapartners.ed.gov"],
  financial_aid_policy: ["studentaid.gov", "fsapartners.ed.gov"],
  ferpa: ["studentprivacy.ed.gov", "ed.gov"],
  official_stats: ["collegescorecard.ed.gov", "api.data.gov", "nces.ed.gov"],
});

const TOPIC_TERMS = Object.freeze({
  fafsa: ["fafsa", "student aid", "federal aid", "eligibility"],
  eligibility: ["eligibility", "eligible", "citizenship", "ssn", "enrollment"],
  financial_aid_policy: ["financial aid", "fafsa", "need blind", "need aware"],
  ferpa: ["ferpa", "student privacy", "education record"],
  deadlines: ["deadline", "due date", "early action", "early decision", "regular decision"],
  financial_amounts: ["tuition", "net price", "financial aid", "grant", "scholarship", "cost"],
  school_policies: ["policy", "test optional", "test required", "application requirement"],
  official_stats: ["acceptance", "admission rate", "sat", "act", "enrollment", "graduation"],
});

function normalizedTopicType(topicType) {
  return String(topicType || "").toLowerCase();
}

function sourceDomain(evidence) {
  if (evidence?.source_domain) return String(evidence.source_domain).toLowerCase();
  try {
    return new URL(evidence?.source_url || "").hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isEvidenceUnexpired(evidence, now = new Date()) {
  if (!evidence || evidence.superseded_by) return false;
  if (["expired", "stale", "superseded"].includes(String(evidence.trust_level || "").toLowerCase())) return false;
  const expiry = evidence.expires_at || evidence.expiresAt;
  if (!expiry) return true;
  const timestamp = Date.parse(expiry);
  return Number.isFinite(timestamp) && timestamp > now.getTime();
}

export function isEvidenceRelevant(evidence, subIntent) {
  if (!evidence) return false;
  const intent = String(subIntent || "").toLowerCase();
  const directTopics = [
    evidence.topic_type,
    evidence.sub_intent,
    evidence.claim_category,
    evidence.fact_key,
    ...(Array.isArray(evidence.relevant_topics) ? evidence.relevant_topics : []),
  ].filter(Boolean).map((value) => String(value).toLowerCase());
  if (directTopics.some((value) => value === intent || value.includes(intent))) return true;

  const domain = sourceDomain(evidence);
  if ((TOPIC_SOURCE_DOMAINS[intent] || []).some((allowed) => domain === allowed || domain.endsWith("." + allowed))) {
    return true;
  }

  const text = [
    evidence.fact_key,
    evidence.fact_value,
    evidence.claim_category,
    evidence.claim,
    evidence.source_title,
  ].filter(Boolean).join(" ").toLowerCase();
  return (TOPIC_TERMS[intent] || [intent.replaceAll("_", " ")])
    .filter((term) => term.length >= 3)
    .some((term) => text.includes(term));
}

export function isVerifiedEvidenceForTopic(evidence, subIntent, { now = new Date() } = {}) {
  const explicitFactVerification = String(evidence?.confidence || "").toLowerCase() === "verified";
  const reviewedOfficialEvidence = evidence?.evidence_type === 1 &&
    String(evidence?.trust_level || "").toLowerCase() === "official" &&
    Boolean(evidence?.verified_at);
  if (!explicitFactVerification && !reviewedOfficialEvidence) return false;
  if (!evidence?.source_url && !evidence?.source_domain) return false;
  if (!isEvidenceUnexpired(evidence, now)) return false;
  return isEvidenceRelevant(evidence, subIntent);
}

// Single source of truth for the crisis lexicon (PATTERNS.crisis). Used by the
// deterministic crisis path AND by any surface that must never echo a minor's
// crisis words back — e.g. a chat-thread title. Keeps one canonical check so
// the two never drift.
export function isCrisisText(text) {
  const s = normalizeForLexicon(text);
  if (!s) return false;
  return PATTERNS.crisis.some((pattern) => pattern.test(s));
}

// Read by the parity test against the client's copy; not for matching.
export const CRISIS_PATTERNS = Object.freeze([...PATTERNS.crisis]);

// Suicide, self-harm, overdose or a crisis line named anywhere. Checked only
// after the crisis patterns have said no, so a match marks a topic mention
// ("our suicide prevention club"): answered normally, with the resource
// footer. "We added the crisis hotline number to every locker" names no
// suicide, and without the line here it would be answered with no lines.
export const CRISIS_TOPIC_RE = /\b(?:suicid\w*|self[\s-]?harm\w*|overdos\w*|crisis\s+(?:hot|life|text\s+)lines?)\b|자살|자해/i;

export function isCrisisTopicMention(text) {
  const s = normalizeForLexicon(text);
  if (!s || PATTERNS.crisis.some((pattern) => pattern.test(s))) return false;
  return CRISIS_TOPIC_RE.test(s);
}

// ─── Main classification function ───
export function classifyTopic(query, conversationContext = {}) {
  const text = (query || "").trim().toLowerCase();
  if (!text) {
    return {
      topicType: TOPIC_TYPES.ADMINISTRATIVE,
      intent: "empty_query",
      subIntent: null,
      sourceConstraint: "none",
      modelTier: MODEL_TIERS.NONE,
      gates: [],
      confidence: 1.0,
      rationale: "Empty query — no classification needed.",
    };
  }

  // 1. Crisis detection — always first, highest priority. Matched on the
  // normalized question (typographic apostrophes, zero-width characters),
  // not on `text`, which the topic patterns below still read as before.
  if (isCrisisText(query)) {
    return {
      topicType: TOPIC_TYPES.CRISIS,
      intent: "crisis_detected",
      subIntent: null,
      sourceConstraint: "none",
      modelTier: MODEL_TIERS.NONE,
      gates: ["crisis_protocol"],
      confidence: 0.95,
      rationale: "Crisis keywords detected. Route to deterministic crisis response.",
    };
  }

  // 2. Regulated topics
  for (const [subIntent, pattern] of Object.entries(PATTERNS.regulated)) {
    if (pattern.test(text)) {
      return {
        topicType: TOPIC_TYPES.REGULATED,
        intent: "regulated",
        subIntent,
        sourceConstraint: "trusted_only",
        modelTier: MODEL_TIERS.NONE, // Start with rules engine, escalate if needed
        gates: ["source_verification", "no_source_no_answer", "advisory_only_disclosure"],
        confidence: 0.88,
        rationale: `Regulated topic (${subIntent}). Rules engine first, trusted sources only, no-source-no-answer enforced.`,
      };
    }
  }

  // 3. High-stakes topics
  for (const [subIntent, pattern] of Object.entries(PATTERNS.high_stakes)) {
    if (pattern.test(text) && !ORDINARY_SENSE[subIntent]?.(text)) {
      return {
        topicType: TOPIC_TYPES.HIGH_STAKES,
        intent: "high_stakes",
        subIntent,
        sourceConstraint: "official_required",
        modelTier: subIntent === "deadlines" || subIntent === "official_stats"
          ? MODEL_TIERS.NONE   // Pure lookup
          : MODEL_TIERS.SONNET, // May need synthesis for financial amounts
        gates: ["source_verification", "official_source_mode"],
        confidence: 0.82,
        rationale: `High-stakes topic (${subIntent}). Official source required. Speculative responses blocked.`,
      };
    }
  }

  // 4. Coaching topics
  // Start with the cheapest tier that can reasonably handle the request.
  // Strategic coaching starts at medium, never large; large models require
  // an explicit, separately budgeted action.
  const HEAVY_COACHING_SUBINTENTS = new Set([
    "ec_strategy", "essay", "college_list", "strategy", "course_planning",
  ]);
  for (const [subIntent, pattern] of Object.entries(PATTERNS.coaching)) {
    if (pattern.test(text)) {
      let modelTier = MODEL_TIERS.HAIKU;
      if (subIntent === "gpa_benchmark") modelTier = MODEL_TIERS.NONE;
      else if (HEAVY_COACHING_SUBINTENTS.has(subIntent)) modelTier = MODEL_TIERS.SONNET;
      return {
        topicType: TOPIC_TYPES.COACHING,
        intent: "coaching",
        subIntent,
        sourceConstraint: "evidence_grounded",
        modelTier,
        gates: ["coaching_label"],
        confidence: 0.78,
        rationale: `Coaching topic (${subIntent}). ${modelTier === MODEL_TIERS.OPUS ? "Cross-source strategy — large model required." : "Evidence-grounded synthesis with coaching label."}`,
      };
    }
  }

  // 5. Default: general coaching
  return {
    topicType: TOPIC_TYPES.COACHING,
    intent: "coaching",
    subIntent: "general",
    sourceConstraint: "evidence_grounded",
    modelTier: MODEL_TIERS.HAIKU,
    gates: ["coaching_label"],
    confidence: 0.5,
    rationale: "No specific topic matched. Default to evidence-grounded coaching.",
  };
}

// ─── Lookup vs. guidance ───
// The no-source gate refuses only a PURE LOOKUP — "when is X's deadline",
// "what is Y's acceptance rate" — because a wrong date or admit rate is
// worse than no answer. Strategy, comparison and explanation questions on
// the same topics ("should I apply early decision", "how much does the
// acceptance rate matter") are general guidance: the model answers with the
// verified data it holds and says plainly what it cannot confirm.
const LOOKUP_ASK_RE = /\b(?:when|what|what's|whats|which|how\s+many|give\s+me|tell\s+me|list|show\s+me|find|look\s+up|do\s+you\s+(?:know|have)|is\s+(?:it|the|there))\b/i;
const GUIDANCE_RE = /\b(?:should|shouldn't|would\s+it|worth|better|best|vs\.?|versus|differ\w*|compar\w*|means?|meaning|explain|understand|why|how\s+(?:do|does|did|can|could|should|important|much\s+do(?:es)?)|strateg\w*|chances?|odds|decide|deciding|decided|choos\w*|pros|cons|matters?|good\s+idea|bad\s+idea|advice|advise|recommend\w*|plan|planning|prepar\w*|manag\w*|organiz\w*|keep\s+track|tips?|help\s+me|thoughts?|opinion|ok(?:ay)?\s+to|worr\w*|stress\w*|realistic|competitive|likely|typical\w*|usually|generally|in\s+general|on\s+average|improve|increase|boost|affect|impact|prioriti\w*|handle|balance|too\s+late|missed|miss|extension|extend|late)\b/i;

// The Korean ask and guidance words (gate-12): 언제 / 몇 / 얼마 ask for a
// date or a figure; 할까 / 어떻게 / 중요 / 전략 ask what to do with one, so
// "얼리 디시전 지원해야 할까요?" (should I apply ED?) is never refused.
const KO_LOOKUP_ASK_RE = /언제|몇|얼마|무엇|뭐(?:예요|에요|야|죠|지|인가)|어디|알려\s*주|찾아\s*주/;
const KO_GUIDANCE_RE = /할까|좋을까|나을까|어떻게|전략|차이|왜|추천|중요|괜찮|의미|뜻이|비교|가능성|확률|도움|조언|준비|놓쳤|늦었|연장|보통|대략|일반적/;

export function isLookupQuestion(query, subIntent) {
  const text = String(query || "").trim();
  if (!text) return false;
  const intent = String(subIntent || "").toLowerCase();
  if (intent !== "deadlines" && intent !== "official_stats") return false;
  if (GUIDANCE_RE.test(text) || KO_GUIDANCE_RE.test(text)) return false;
  const words = text.split(/\s+/).filter(Boolean).length;
  return LOOKUP_ASK_RE.test(text) || KO_LOOKUP_ASK_RE.test(text) || words <= 8;
}

// ─── Compliance gate enforcement ───
// context.query is the student's question and context.schoolNamed says
// whether it names a specific school; with both, only a pure lookup about a
// named school is refused. Callers that pass no context keep the strict
// no-source-no-answer behaviour for deadline and statistics topics.
export function enforceGates(topicType, subIntent, availableEvidence = [], context = {}) {
  const results = [];
  const normalizedType = normalizedTopicType(topicType);

  if (normalizedType === TOPIC_TYPES.CRISIS) {
    results.push({
      gate: "crisis_protocol",
      passed: true,
      action: "deterministic_crisis_response",
      reason: "Crisis detected — bypass all model calls, return crisis resources.",
    });
    return { allowed: true, gates: results, fallback: null };
  }

  if (normalizedType === TOPIC_TYPES.REGULATED || normalizedType === TOPIC_TYPES.HIGH_STAKES) {
    const verifiedEvidence = availableEvidence.filter((e) =>
      isVerifiedEvidenceForTopic(e, subIntent)
    );

    if (verifiedEvidence.length === 0) {
      // Informational questions must not be stonewalled: REGULATED topics
      // (FAFSA / financial-aid / FERPA) and non-lookup HIGH_STAKES topics
      // (costs, aid amounts in general terms, school policies) get grounded
      // GENERAL guidance labeled unverified, with the advisory disclosure
      // and an official-source pointer. Only the pure-lookup topics — exact
      // deadlines and official statistics — keep the hard no-source-no-answer
      // gate, because a wrong date or admit rate is worse than no answer.
      const hardLookup = normalizedType === TOPIC_TYPES.HIGH_STAKES &&
        ["deadlines", "official_stats"].includes(String(subIntent || "").toLowerCase());
      const pureLookup = context.query === undefined ? true : isLookupQuestion(context.query, subIntent);
      const schoolNamed = context.schoolNamed === undefined ? true : Boolean(context.schoolNamed);
      if (!hardLookup || !pureLookup || !schoolNamed) {
        results.push({
          gate: "no_source_no_answer",
          passed: true,
          action: "allow_unverified_general_guidance",
          reason: "No verified source matched — answering with general guidance labeled as unverified, with an official-source pointer.",
        });
        results.push({
          gate: "advisory_only_disclosure",
          passed: true,
          action: "attach_advisory_disclosure",
          reason: "General regulated-topic guidance always carries the advisory disclosure.",
        });
        return {
          allowed: true,
          gates: results,
          fallback: null,
          generalGuidance: {
            unverified: true,
            suggestedSource: getSuggestedOfficialSource(subIntent),
          },
        };
      }

      // HIGH_STAKES lookups (deadlines, official stats) stay hard-gated:
      // a wrong deadline or admit rate is worse than no answer.
      results.push({
        gate: "no_source_no_answer",
        passed: false,
        action: "return_no_verified_answer",
        reason: "No verified source available for this high-stakes topic.",
      });
      return {
        allowed: false,
        gates: results,
        fallback: {
          message: "No verified answer available for this question.",
          suggestedSource: getSuggestedOfficialSource(subIntent),
          reason: "No official source matched this query in our verified database.",
        },
      };
    }

    results.push({
      gate: "source_verification",
      passed: true,
      action: "proceed_with_evidence",
      reason: `${verifiedEvidence.length} verified evidence item(s) available.`,
    });
  }

  if (normalizedType === TOPIC_TYPES.COACHING) {
    results.push({
      gate: "coaching_label",
      passed: true,
      action: "label_as_coaching",
      reason: "Output will be labeled as non-binding coaching suggestion.",
    });
  }

  return { allowed: true, gates: results, fallback: null };
}

// ─── Model tier selection with escalation logic ───
//
// Strategy Council rule (Pillar 9): when the subIntent is in the
// council-eligible set AND we're not already inside a council-spawned
// sub-call, return COUNCIL instead of OPUS. The orchestration engine
// detects the marker and dispatches to council.convene().
export function selectModelTier(...args) {
  const tier = selectModelTierInner(...args);
  const [topicType, subIntent, queryComplexity] = args;
  llmDebug("TIER", "selectModelTier", { topicType, subIntent, queryComplexity: queryComplexity || "normal", tier });
  return tier;
}

function selectModelTierInner(topicType, subIntent, queryComplexity = "normal", priorAttempt = null, opts = {}) {
  const explicitCouncil = opts.explicitCouncil === true;
  const allowPaidEscalation = opts.allowPaidEscalation === true && opts.budgetApproved === true;

  // Crisis: never use a model
  if (topicType === TOPIC_TYPES.CRISIS) return MODEL_TIERS.NONE;

  // Administrative: never use a model
  if (topicType === TOPIC_TYPES.ADMINISTRATIVE) return MODEL_TIERS.NONE;

  // Regulated: start with rules engine
  if (topicType === TOPIC_TYPES.REGULATED) {
    if (!priorAttempt) return MODEL_TIERS.NONE;
    // If rules engine couldn't fully answer, escalate to Sonnet for grounded synthesis
    if (priorAttempt.tier === MODEL_TIERS.NONE && priorAttempt.needsSynthesis) {
      return MODEL_TIERS.SONNET;
    }
    // If Sonnet couldn't resolve (low confidence), escalate to Opus
    if (priorAttempt.tier === MODEL_TIERS.SONNET &&
        priorAttempt.confidence < OPUS_ESCALATION_THRESHOLD &&
        allowPaidEscalation) {
      return MODEL_TIERS.OPUS;
    }
    return priorAttempt.tier;
  }

  // High-stakes: deadlines and stats are lookup-only
  if (topicType === TOPIC_TYPES.HIGH_STAKES) {
    if (subIntent === "deadlines" || subIntent === "official_stats") return MODEL_TIERS.NONE;
    if (!priorAttempt) return MODEL_TIERS.SONNET;
    if (priorAttempt.tier === MODEL_TIERS.SONNET &&
        priorAttempt.confidence < OPUS_ESCALATION_THRESHOLD &&
        allowPaidEscalation) {
      return MODEL_TIERS.OPUS;
    }
    return MODEL_TIERS.SONNET;
  }

  // Coaching
  if (topicType === TOPIC_TYPES.COACHING) {
    if (subIntent === "gpa_benchmark") return MODEL_TIERS.NONE;

    // Heavy strategic subintents — convene the 5-seat Strategy Council
    // when allowed. Falls back to OPUS when the caller is already inside
    // a council sub-call (avoids infinite recursion).
    if (STRATEGY_COUNCIL_SUBINTENTS.has(subIntent)) {
      if (explicitCouncil) return MODEL_TIERS.COUNCIL;
      return MODEL_TIERS.SONNET;
    }
    if (!priorAttempt) return MODEL_TIERS.HAIKU;
    // Escalate any other complex coaching turn to Opus on retry.
    if (priorAttempt.tier === MODEL_TIERS.HAIKU &&
        priorAttempt.confidence < OPUS_ESCALATION_THRESHOLD &&
        queryComplexity === "complex" &&
        allowPaidEscalation) {
      return MODEL_TIERS.SONNET;
    }
    return priorAttempt.tier || MODEL_TIERS.HAIKU;
  }

  return MODEL_TIERS.SONNET;
}

// ─── Check if query can be fully handled by rules engine (T0) ───
// `query` is optional: when provided, a FAFSA-tagged question is only routed
// to the deterministic eligibility checker when it actually asks about
// eligibility/qualification. General FAFSA questions ("how does the FAFSA
// work?") used to get squeezed into an eligibility-rules answer; they now
// fall through to grounded synthesis under the general-guidance gate.
export function canHandleDeterministically(topicType, subIntent, query = "") {
  const deterministicRoutes = new Set([
    `${TOPIC_TYPES.CRISIS}:crisis_detected`,
    `${TOPIC_TYPES.REGULATED}:fafsa`,        // Eligibility checks
    `${TOPIC_TYPES.REGULATED}:eligibility`,
    `${TOPIC_TYPES.HIGH_STAKES}:deadlines`,
    `${TOPIC_TYPES.HIGH_STAKES}:official_stats`,
    `${TOPIC_TYPES.COACHING}:gpa_benchmark`,
    `${TOPIC_TYPES.ADMINISTRATIVE}:empty_query`,
  ]);
  if (!deterministicRoutes.has(`${topicType}:${subIntent}`)) return false;
  // The deterministic checker answers FEDERAL-AID eligibility checks only.
  // "Eligible/qualify" phrasing alone spans admissions ("am I eligible for
  // Princeton?"), scholarships, and program questions — serving those the
  // federal FAFSA checklist buried real questions under boilerplate. Require
  // both an eligibility verb AND explicit federal-aid context.
  if (topicType === TOPIC_TYPES.REGULATED && (subIntent === "fafsa" || subIntent === "eligibility") && String(query || "").trim()) {
    return isFafsaChecklistQuestion(query);
  }
  return true;
}

// The checklist lists the federal requirements; it cannot weigh a student's
// own situation. "Am I eligible for FAFSA as a permanent resident?" and "do
// I qualify for federal aid if my parents are undocumented?" got "6
// eligibility item(s) have not been confirmed yet" and nothing about
// permanent residents or a contributor without an SSN (gate-9). A question
// that names a situation, or asks why or what if, goes to the model as
// labeled general guidance with the official rule text beside it.
const FAFSA_SITUATION_RE = /\b(?:as\s+an?|if|since|because|even\s+though|although|unless|while\s+(?:i|my)|with(?:out)?\s+(?:a|an|my|no|our)|when\s+(?:i|my)|why|what\s+(?:if|happens)|my\s+(?:parents?|mom|dad|mother|father|family|guardian|status|visa|income)|permanent\s+residents?|green\s+card|daca|dreamers?|undocumented|international|visas?|non-?citizens?|citizenship\s+status|ssn|social\s+security|drugs?|convict\w*|felon\w*|default\w*|incarcerat\w*|prison|jail|foster|homeless|ward|independent|divorc\w*|separated|married|ged|home-?school\w*|tps|refugees?|asylum|immigra\w*|parole|part[- ]time|community\s+college|grad(?:uate)?\s+school|abroad|another\s+country)\b/i;

export function isFafsaChecklistQuestion(query) {
  const text = String(query || "");
  return /\b(eligib\w*|qualif\w*)\b/i.test(text)
    && /\b(fafsa|federal|financial\s+aid|student\s+aid|pell|loan|grant)\b/i.test(text)
    && !FAFSA_SITUATION_RE.test(text);
}

// ─── Check Opus budget ───
export function checkOpusBudget(studentId, opusUsageToday, config = {}) {
  const dailyCap = config.OPUS_DAILY_CAP || 5;
  const monthlyCap = config.OPUS_MONTHLY_CAP || 50;

  return {
    allowed: opusUsageToday.daily < dailyCap && opusUsageToday.monthly < monthlyCap,
    dailyRemaining: Math.max(0, dailyCap - opusUsageToday.daily),
    monthlyRemaining: Math.max(0, monthlyCap - opusUsageToday.monthly),
    reason: opusUsageToday.daily >= dailyCap
      ? "Daily Opus budget exceeded. Complex queries will use Sonnet."
      : opusUsageToday.monthly >= monthlyCap
        ? "Monthly Opus budget exceeded."
        : null,
  };
}

// ─── Build full routing decision ───
export function routeRequest(query, conversationContext = {}, availableEvidence = [], config = {}) {
  const classification = classifyTopic(query, conversationContext);
  const gateResult = enforceGates(classification.topicType, classification.subIntent, availableEvidence, { query });

  if (!gateResult.allowed) {
    return {
      classification,
      gateResult,
      modelTier: MODEL_TIERS.NONE,
      action: "return_fallback",
      fallback: gateResult.fallback,
    };
  }

  let modelTier = selectModelTier(
    classification.topicType,
    classification.subIntent,
    conversationContext.queryComplexity || "normal",
    conversationContext.priorAttempt || null,
    {
      explicitCouncil: conversationContext.explicitCouncil === true,
      allowPaidEscalation: conversationContext.allowPaidEscalation === true,
      budgetApproved: conversationContext.budgetApproved === true,
    },
  );

  const isDeterministic = canHandleDeterministically(classification.topicType, classification.subIntent, query);

  // General-guidance mode (regulated topic, no verified evidence): the rules
  // engine has nothing to answer with and a fact-store lookup would come back
  // empty, so route to medium-tier synthesis. The composer labels everything
  // as unverified coaching with the official-source pointer.
  if (!isDeterministic && gateResult.generalGuidance && modelTier === MODEL_TIERS.NONE) {
    modelTier = MODEL_TIERS.SONNET;
  }

  let action;
  if (isDeterministic) action = "rules_engine";
  else if (modelTier === MODEL_TIERS.NONE) action = "fact_store_lookup";
  else if (modelTier === MODEL_TIERS.COUNCIL) action = "strategy_council";
  else action = "model_synthesis";

  return {
    classification,
    gateResult,
    modelTier,
    isDeterministic,
    action,
    generalGuidance: gateResult.generalGuidance || null,
  };
}

// ─── Helper: suggest official source for a regulated sub-intent ───
function getSuggestedOfficialSource(subIntent) {
  const sources = {
    fafsa: { url: "https://studentaid.gov", label: "StudentAid.gov" },
    ferpa: { url: "https://studentprivacy.ed.gov", label: "Student Privacy Policy Office" },
    financial_aid_policy: { url: "https://studentaid.gov", label: "StudentAid.gov" },
    eligibility: { url: "https://studentaid.gov/apply-for-aid/fafsa/eligibility", label: "FAFSA Eligibility (StudentAid.gov)" },
    legal_compliance: { url: "https://ed.gov", label: "U.S. Department of Education" },
    deadlines: { url: null, label: "Check the college's official admissions website" },
    financial_amounts: { url: null, label: "Contact the college's financial aid office directly" },
    school_policies: { url: null, label: "Check the college's official admissions website" },
    official_stats: { url: "https://collegescorecard.ed.gov", label: "College Scorecard (U.S. Dept. of Education)" },
  };
  return sources[subIntent] || { url: null, label: "Consult the relevant official source directly" };
}
