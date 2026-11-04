// ═══════════════════════════════════════════════════════════════════════
// CONTENT MODERATION — Input/output moderation middleware
// ═══════════════════════════════════════════════════════════════════════
// Required by Anthropic Usage Policy. Provides:
//   - Input screening (before model calls)
//   - Output screening (before returning to user)
//   - Age-appropriate content filtering for minors
//   - PII detection and redaction before model context
//   - Credential detection (blocks FSA IDs, SSNs, etc.)
// ═══════════════════════════════════════════════════════════════════════

// ─── Content categories ───
const CATEGORIES = {
  SAFE: "safe",
  CRISIS: "crisis",
  INAPPROPRIATE: "inappropriate",
  CREDENTIAL: "credential_detected",
  PII_DETECTED: "pii_detected",
  OFF_TOPIC: "off_topic",
};

// ─── Patterns ───
// A credential is refused only when the message discloses one: the keyword,
// then "is", ":" or "=", then a value-shaped token. The first patterns
// matched the keyword and ANY later colon, and any nine- or eleven-digit run,
// so "What is an FSA ID: do I need one before October?", "I reset my password
// at 10:00", a ZIP+4, a nine-digit student ID, a family income written
// "120000000원" and an 11-digit Korean mobile number were all refused as
// credentials, while the plainest disclosure, "my fsa id is jdoe2008", went
// through because it has no colon. Every pattern captures the value alone
// (the first capture group) so the output screen blanks just the value:
// replacing the whole match turned "1. **Create your FSA ID:** go to
// studentaid.gov" into "1. **Create your [REDACTED] go to studentaid.gov".
//
// Words that follow "FSA ID is" or "password:" in questions and how-to
// answers and are never the value itself.
const NOT_A_CREDENTIAL_VALUE = String.raw`(?:what|how|why|when|where|who|which|do|does|did|is|are|was|were|be|a|an|the|and|or|but|so|for|to|in|on|at|of|my|your|our|their|his|her|its|it|this|that|one|not|still|just|also|only|now|already|required|needed|necessary|important|different|same|separate|ready|done|set|created|made|locked|lost|forgotten|expired|wrong|incorrect|invalid|correct|right|reset|changed|working|weak|strong|safe|secure|case|sensitive|optional|unique|private|personal|yours|mine|asked|used|shared)`;
const VALUE_CHAR = String.raw`[^\s,;?"'()<>\[\]*\`]`;
const VALUE_LAST = String.raw`[^\s,;?"'()<>\[\]*\`.:!]`;
// A value carries a digit or a symbol (jdoe2008, Tr0ub4dor&3, jane@x.com).
// A year or award year ("FSA ID: 2026-27 FAFSA") and a length rule
// ("password: 8-30 characters") are how-to text, not values.
const SHAPED_VALUE = String.raw`(?!(?:19|20)\d{2}(?:[-–](?:\d{2}|\d{4}))?\b)(?!\d+(?:[-–]\d+)?\+?\s*(?:characters?|chars?|letters?|digits?|numbers?|symbols?)\b)(?=${VALUE_CHAR}*[\d@#$%^&_+=~])(${VALUE_CHAR}{3,63}${VALUE_LAST})`;
// After ":" or "=", a lone plain word that ends the sentence is a value too
// ("my password: sunshine").
const BARE_VALUE = String.raw`(?!${NOT_A_CREDENTIAL_VALUE}\b)([A-Za-z]{4,64})(?=\s*(?:$|\n|[.!](?:\s|$)))`;
const IS_OR_COLON = String.raw`(?:\s+(?:is|was)\s+|\s*[:=]\s*)`;
const FSA_ID_KEY = String.raw`\bfsa[\s-]*id(?:\s+(?:username|user\s*name|login|password))?`;
const PASSWORD_KEY = String.raw`\b(?:password|passcode|passwd)`;
const SSN_MESSAGE = "Do not share your Social Security Number or resident registration number (주민등록번호) with this system.";
const BANK_MESSAGE = "Possible bank account or routing number detected.";
const API_KEY_MESSAGE = "API key detected in message. Use the secure API Key settings instead.";
const CREDENTIAL_PATTERNS = [
  // 3-2-4 with one separator used throughout. A ZIP+4 is 5-4 and a phone
  // number is 3-3-4, so neither has this shape.
  { pattern: /(?<![\d-])(\d{3}([- ])\d{2}\2\d{4})(?!\d|[-.]\d|\s*원)/, type: "ssn", message: SSN_MESSAGE },
  // A bare nine-digit run is an SSN only when it is named as one.
  { pattern: /\b(?:ssn|social\s+security(?:\s+(?:number|no\.?|num|#))?)\b[^\d\n]{0,20}(\d{3}[- ]?\d{2}[- ]?\d{4})(?!\d|\s*원)/i, type: "ssn", message: SSN_MESSAGE },
  { pattern: /주민(?:등록)?(?:\s*번호)?[^\d\n]{0,10}(\d{6}\s*-?\s*\d{7}|\d{3}[- ]?\d{2}[- ]?\d{4})(?!\d|\s*원)/, type: "ssn", message: SSN_MESSAGE },
  // A resident registration number has a shape of its own: YYMMDD-, then a
  // sex/century digit and six more.
  { pattern: /(?<!\d)(\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])-[1-8]\d{6})(?!\d)/, type: "ssn", message: SSN_MESSAGE },
  { pattern: new RegExp(`${FSA_ID_KEY}${IS_OR_COLON}(?:${SHAPED_VALUE})|${FSA_ID_KEY}\\s*[:=]\\s*${BARE_VALUE}`, "i"), type: "fsa_id", message: "Do not share your FSA ID with this system. Manage your FSA ID at StudentAid.gov." },
  { pattern: new RegExp(`${PASSWORD_KEY}${IS_OR_COLON}(?:${SHAPED_VALUE})|${PASSWORD_KEY}\\s*[:=]\\s*${BARE_VALUE}`, "i"), type: "password", message: "Do not share passwords with this system." },
  { pattern: /(\bsk-ant-api\d{2}-[a-zA-Z0-9_-]{20,})/i, type: "api_key", message: API_KEY_MESSAGE },
  { pattern: /(\bsk-(?:proj-)?[a-zA-Z0-9_-]{20,})/i, type: "api_key", message: API_KEY_MESSAGE },
  // A bank number needs an account or routing word in front of it; on its
  // own an eleven-digit run is far more often a Korean mobile number.
  { pattern: /\b(?:(?:bank|checking|savings)\s+account|account|acct\.?|routing|aba|iban)(?:\s*(?:number|no\.?|num|#))?(?:\s+(?:is|was)\s+|\s*[:=#]\s*|\s+)((?:[A-Z]{2}\d{2}[ -]?)?\d(?:[ -]?\d){7,33})(?!\d|[.,]\d|\s*(?:원|won|krw|usd|dollars?|달러))/i, type: "bank_account", message: BANK_MESSAGE },
  { pattern: /계좌(?:\s*번호)?\s*(?:는|은|:|=)?\s*(\d(?:[ -]?\d){7,33})(?!\d|[.,]\d|\s*(?:원|won))/, type: "bank_account", message: BANK_MESSAGE },
];
const CREDENTIAL_PATTERNS_GLOBAL = CREDENTIAL_PATTERNS.map((rule) => ({ ...rule, pattern: new RegExp(rule.pattern.source, `${rule.pattern.flags}g`) }));

// The SSN shape here is the credential screen's (one consistent separator),
// so the output screen no longer blanks a ZIP+4 or "120000000원" in an answer.
const PII_PATTERNS = [
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, type: "email", replacement: "[EMAIL_REDACTED]", restorable: true },
  { pattern: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, type: "phone", replacement: "[PHONE_REDACTED]", restorable: false },
  { pattern: /(?<![\d-])\d{3}([- ])\d{2}\1\d{4}(?!\d|[-.]\d|\s*원)/g, type: "ssn", replacement: "[SSN_REDACTED]", restorable: false },
  { pattern: /\$\s*[\d,]+\.?\d{0,2}/g, type: "financial", replacement: "[FINANCIAL_REDACTED]", restorable: true },
];

// ─── Money at the provider boundary ───
// Every dollar amount used to reach the provider as "[ANNUAL_INCOME_01]", so
// the most useful line of an activity description, "Raised $4,500 for the
// Seoul food bank", arrived as "Raised [ANNUAL_INCOME_01] ..." and the model
// could neither cite the number nor tell it from a family income. A
// fundraising, prize or scholarship amount is now written the way prompts
// write money (CLAUDE.md: "62,484 USD", not "$"); an amount near an income,
// savings, tax or household word, or said by a family subject, is masked
// as before, and so is any amount with no context either way.
const MONEY_AMOUNT = /(?:\bUS)?\$\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(\s?(?:k|K|m|M|MM|bn|million|billion|thousand)\b)?/g;
const MONEY_INCOME_CONTEXT = /\b(?:incomes?|salar(?:y|ies)|wages?|paychecks?|agi|adjusted\s+gross|gross|taxable|tax(?:es)?|w-?2s?|1040|assets?|savings|saved|net\s+worth|investments?|401\s*\(?k\)?|ira|home\s+equity|mortgage|rent|debts?|loans?|inheritance|child\s+support|alimony|ssi|unemployment|efc|sai|expected\s+family\s+contribution|student\s+aid\s+index|(?:per|a|an|each|every)\s+(?:year|month|week|hour)|annual(?:ly)?|yearly|monthly|weekly|hourly)\b|\/\s*(?:hr|hour|h|yr|year|mo|month|wk|week)\b|소득|연봉|월급|재산|자산|연수입/i;
const MONEY_ACHIEVEMENT_BEFORE = /\b(?:raised|raise|raising|fundraised|fundraising|collected|collect|collecting|donated|donate|donating|generated|generating|secured|securing|won|win|winning|awarded|granted|brought\s+in|sold|grossed|netted|totaling|totalling|matched)\s+(?:(?:over|about|around|nearly|almost|roughly|approximately|more\s+than|up\s+to|at\s+least|another|an\s+additional|a\s+total\s+of|a|an|the)\s+)*$/i;
const FAMILY_NOUN_SOURCE = String.raw`famil(?:y|ies)|household|parents?|mom|mother|dad|father|guardians?|step-?(?:mom|dad|mother|father|parents?)|grand(?:ma|pa|mother|father|parents?)|aunt|uncle`;
// A family member named before the amount: "My parents brought in $60k" is
// an income however the verb reads.
const MONEY_FAMILY_NOUN = new RegExp(String.raw`\b(?:${FAMILY_NOUN_SOURCE})\b`, "i");
const MONEY_FAMILY_SUBJECT = new RegExp(String.raw`\b(?:${FAMILY_NOUN_SOURCE}|we|our|us|earn(?:s|ed|ing)?|makes?|made|making|paid|pay|pays|paying|spend|spends|spent|afford|cost\s+us|left\s+me|gave\s+me|give\s+me|gives\s+me|owe[sd]?|borrow(?:ed)?|lend|lent|contribut\w*|support\w*)\b`, "i");
const MONEY_ACHIEVEMENT_AFTER = /^\s*(?:(?:in|of)\s+(?:donations?|funding|funds|grants?|sponsorships?|prizes?|prize\s+money|scholarships?|sales|revenue|profits?|merchandise|supplies)\b|worth\s+of\b|(?:research\s+)?(?:grant|prize|award|scholarship|sponsorship|fundraiser|donation|stipend)s?\b|for\s+(?:the\s+|a\s+|an\s+|local\s+|our\s+)?(?:[\w'’-]+\s+){0,3}?(?:charit(?:y|ies)|relief|research|foundation|fund|bank|shelter|hospital|cause|victims|children|kids|refugees|survivors|patients|nonprofit|non-profit|ngo|unicef|habitat|orphanage|library|clinic|drive)\b)/i;
// After a family member, only a cause makes the amount a fundraising
// total. Sales, revenue, profits and funding are a family business's money,
// and "for my college fund" is the family's savings.
const MONEY_CAUSE_AFTER = /^\s*(?:(?:in|of)\s+(?:donations?|sponsorships?|prizes?|prize\s+money|scholarships?)\b|(?:prize|award|scholarship|fundraiser|donation)s?\b|for\s+(?!(?:my|our|his|her|their)\b)(?:the\s+|a\s+|an\s+|local\s+)?(?:(?!(?:my|our|his|her|their)\b)[\w'’-]+\s+){0,3}?(?:charit(?:y|ies)|relief|research|foundation|fund|bank|shelter|hospital|cause|victims|children|kids|refugees|survivors|patients|nonprofit|non-profit|ngo|unicef|habitat|orphanage|library|clinic|drive)\b)/i;

function moneyAsUsd(_match, amount, suffix = "") {
  return `${amount}${suffix || ""} USD`;
}

// What makes a dollar figure in an activity the family's rather than the
// student's: a parent, a relative or the household, or a word for income,
// tax, savings or debt. A Family Responsibilities entry ("my parents' shop
// brings in $180,000 a year", "$600/month to my mom for rent") is where a
// family income turns up in an activity. Plural "families" and "households"
// are the people an activity served ("for 30 families in need"), and
// "low-income" before them says who was helped, so neither counts.
const FAMILY_FINANCE = /\b(?:family|household|parents?|moms?|mother|dads?|father|step-?(?:mom|dad|mother|father|parents?)|grand(?:ma|pa|mother|father|parents?)|guardians?|aunts?|uncles?|incomes?|salar(?:y|ies)|agi|adjusted\s+gross|taxable|tax(?:es)?|assets?|savings|net\s+worth|mortgage|rent|debts?|loans?|inheritance|child\s+support|alimony|efc|sai|expected\s+family\s+contribution|student\s+aid\s+index)\b|소득|연봉|월급|재산|자산|연수입|부모|가족|엄마|아빠|어머니|아버지/i;
const SERVED_GROUP = /\b(?:low|lower|middle|moderate)[-\s]income\s+(?=(?:families|households|students|kids|children|youth|communities|neighborhoods|residents|schools|seniors|people|individuals|areas)\b)/gi;

function namesFamilyMoney(text) {
  return FAMILY_FINANCE.test(text.replace(SERVED_GROUP, ""));
}

/**
 * The student's own dollar amounts, written as prompts write money
 * ("$4,500" → "4,500 USD", "$15/hr" → "15 USD/hr"), so the provider
 * redactor has no dollar sign to mask. For text the student wrote about an
 * activity (name, role, description). An amount whose clause names the
 * family's money keeps its "$", and the redactor's context rules mask it
 * (or write a fundraising total as USD themselves): this function rewrote
 * every "$" until 2026-11-03, so a household income in a description
 * reached the provider as "35,000 USD".
 */
export function writeMoneyAsUsd(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  if (!value.includes("$")) return value;
  return value.replace(MONEY_AMOUNT, (match, amount, suffix, offset, whole) => {
    const { before, after } = clauseAround(whole, offset, offset + match.length);
    return namesFamilyMoney(before) || namesFamilyMoney(after) ? match : moneyAsUsd(match, amount, suffix);
  });
}

function clauseAround(whole, start, end) {
  const before = whole.slice(Math.max(0, start - 80), start).split(/[.!?;\n]\s/).pop().split(/[;\n]/).pop();
  const after = whole.slice(end, end + 50).split(/[.!?;\n](?:\s|$)/)[0];
  return { before, after };
}

function achievementAmountAsUsd(match, offset, whole, captures) {
  const { before, after } = clauseAround(whole, offset, offset + match.length);
  if (MONEY_INCOME_CONTEXT.test(before) || MONEY_INCOME_CONTEXT.test(after)) return null;
  // The achievement verbs ("brought in", "grossed", "netted", "secured") used
  // to be read first, so "My parents brought in $60k last year" reached the
  // provider as "60k USD". A family member before the amount masks it unless
  // a cause follows ("My mom and I raised $2,000 for the shelter"); "we" and
  // "our" alone do not, so "Our club raised $2,500" still reads as USD.
  if (MONEY_FAMILY_NOUN.test(before) && !MONEY_CAUSE_AFTER.test(after)) return null;
  if (MONEY_ACHIEVEMENT_BEFORE.test(before)) return moneyAsUsd(match, captures[0], captures[1]);
  if (MONEY_FAMILY_SUBJECT.test(before)) return null;
  if (MONEY_ACHIEVEMENT_AFTER.test(after)) return moneyAsUsd(match, captures[0], captures[1]);
  return null;
}

// "3 Blood Drive events" and "2 Moot Court tournaments" have the shape of a
// house number and a street, and were masked as addresses; the quantified
// impact of the activity went with them.
const EVENT_BEFORE_DRIVE = /\b(?:blood|food|book|books|toy|toys|coat|coats|clothing|clothes|canned|can|cans|charity|supply|supplies|fund|donation|donations|donor|coin|coins|shoe|shoes|sock|socks|diaper|diapers|hygiene|holiday|winter|backpack|backpacks|voter|registration|recycling|plasma|marrow|textbook|textbooks|uniform|uniforms|blanket|blankets|meal|meals|grocery|groceries|toiletry|toiletries|eyeglass|eyeglasses|e-?waste|electronics|pet|penny|membership|fundraising|relief)\s+$/i;
const EVENT_BEFORE_COURT = /\b(?:moot|food|tennis|basketball|volleyball|badminton|squash|pickleball|handball|racquetball|supreme|federal|district|appeals?|appellate|juvenile|teen|youth|traffic|family|mock|county|state|superior|circuit|peer|student|honor)\s+$/i;
const EVENT_AFTER_PLACE = /^\s+(?:events?|trips?|races?|runs?|tournaments?|teams?|competitions?|cases?|sessions?|campaigns?|programs?|drives?|clinics?|rall(?:y|ies)|shows?|challenges?|clean-?ups?|projects?|games?|matches|meets?|seasons?|members?|volunteers?|collections?|fundraisers?)\b/i;

function isEventNotAddress(match, offset, whole) {
  const parts = match.match(/^([\s\S]*\s)(\S+)$/);
  if (!parts) return false;
  const [, body, suffix] = parts;
  if (/^(?:drive|dr\.?)$/i.test(suffix) && EVENT_BEFORE_DRIVE.test(body)) return true;
  if (/^(?:court|ct\.?)$/i.test(suffix) && EVENT_BEFORE_COURT.test(body)) return true;
  return EVENT_AFTER_PLACE.test(whole.slice(offset + match.length, offset + match.length + 30));
}

// "School Students from" and "Team Members from" are capitalized pairs, not
// a first and last name; "Taught 30 Middle School Students from …" reached
// the model as "Taught 30 Middle [STUDENT_NAME_01] from …".
const COMMON_CAPITALIZED_WORDS = new Set(("school schools student students member members kid kids children volunteer volunteers donor donors patient patients senior seniors resident residents family families teacher teachers player players athlete athletes refugee refugees immigrant immigrants veteran veterans scout scouts peer peers tutee tutees mentee mentees camper campers participant participants delegate delegates judge judges speaker speakers leader leaders officer officers representative representatives team teams club clubs society council center program project summer science math research art arts music honor national international global world state regional county city community local model debate robotics middle high elementary university college academy award awards prize medal medals grant scholarship food bank habitat humanity red cross cancer hospital church temple library museum park camp league association foundation institute department olympiad competition tournament championship varsity junior freshman sophomore english korean spanish chinese french history biology chemistry physics computer coding engineering business united nations youth teen girls boys women men people friends classmates mentors coaches parents guests visitors attendees alumni interns workers staff faculty nurses doctors engineers scientists artists musicians writers readers learners supplies books toys clothes meals donations funds")
  .split(/\s+/));

// A pair that ends in a group of people ("Syrian Refugees from", "Seoul
// Students from") is never a name, whatever the first word is.
const GROUP_NOUNS = new Set(("students members kids children volunteers donors patients seniors residents families teachers players athletes refugees immigrants veterans scouts peers tutees mentees campers participants delegates judges speakers leaders officers representatives girls boys women men people friends classmates mentors coaches parents guests visitors attendees alumni interns workers staff faculty nurses doctors engineers scientists artists musicians writers readers learners")
  .split(/\s+/));
// Common words that are also common surnames: "Summer Park" is a person.
const SURNAME_WORDS = new Set(["park", "english"]);

// Until 2026-11-03 one common word kept the pair, so "Jimin Park from",
// "Summer Lee from" and "Mark English from" reached the provider unmasked.
// A pair is kept only when it ends in a group of people or both words are
// common nouns, and a pair that may be a name is masked.
function isCommonNounPair(match) {
  const words = match.replace(/\s+from$/i, "").trim().split(/\s+/).map((word) => word.toLowerCase());
  const last = words.at(-1);
  if (GROUP_NOUNS.has(last)) return true;
  return !SURNAME_WORDS.has(last) && words.every((word) => COMMON_CAPITALIZED_WORDS.has(word));
}

const PROVIDER_REDACTION_PATTERNS = [
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, type: "email", label: "STUDENT_EMAIL", restorable: true },
  { pattern: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, type: "phone", label: "PHONE", restorable: false },
  // Deliberately broader than the input screen's SSN shape: a bare
  // nine-digit run no longer blocks a question, so it is masked here instead.
  { pattern: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g, type: "ssn", label: "SSN", restorable: false },
  { pattern: MONEY_AMOUNT, type: "financial", label: "ANNUAL_INCOME", restorable: false, rewrite: achievementAmountAsUsd },
  { pattern: /\b\d{1,6}\s+[A-Z][A-Za-z0-9.'-]*(?:\s+[A-Z][A-Za-z0-9.'-]*){0,4}\s+(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Lane|Ln\.?|Drive|Dr\.?|Court|Ct\.?)\b/g, type: "street_address", label: "STREET_ADDRESS", restorable: false, keep: isEventNotAddress },
  { pattern: /\b(?:student\s*id|id)\s*(?:is|:|=)?\s*[A-Z]-?\d{3,}\b/gi, type: "student_id", label: "STUDENT_ID", restorable: false },
  { pattern: /\b[A-Z][a-z]+ [A-Z][a-z]+\s+from\b/g, type: "student_name_context", label: "STUDENT_NAME", restorable: true, trimSuffix: /\s+from$/i, keep: isCommonNounPair },
  { pattern: /\bfrom\s+[A-Z][A-Za-z0-9.'-]*(?:\s+[A-Z][A-Za-z0-9.'-]*){0,3}\s+(?:High|School|Academy|Preparatory|Prep)\b/g, type: "school_context", label: "CURRENT_SCHOOL", restorable: true, trimPrefix: /^from\s+/i },
];

// ─── Request screens: academic dishonesty and essay ghost-writing ───
// Both screens refuse a REQUEST: the student (or "you") is asked to do the
// thing, so the act must follow a request frame directly: "help me", "how
// do I", "can you", "where can I", "I want to", "please", or the start of a
// sentence (an imperative). The first patterns were keyword pairs anywhere
// in the message, which refused Hack Club members, "forge ahead and apply
// ED", "I don't want to cheat on my application", "my friend wants to buy an
// essay, should I tell someone?", and every essay question with "write" in
// it ("How do I write a good Common App essay?"), with an accusation of
// fraud or a ghost-writing refusal in reply. The LLM gatekeeper's categories,
// the client's essay block and the specialist prompts remain the second layer.
const SENTENCE_START = String.raw`(?:^|[.!?;\n>:"“(]\s*)(?:(?:hey|hi|ok|okay|so|now|pls|yo|um|also|then)[,!]?\s+)*`;
const REQUEST_FRAME = String.raw`(?:\bhelp\s+me\s+(?:to\s+)?|\bhow\s+(?:do|can|could|should|would|might|will)\s+(?:i|we|you|u|one)\s+|\bhow\s+to\s+|\b(?:can|could|would|will)\s+(?:you|u)\s+(?:please\s+)?(?:help\s+me\s+(?:to\s+)?)?|\b(?:show|teach|tell)\s+me\s+(?:how\s+)?to\s+|\bwhere\s+(?:can|could|do|should)\s+(?:i|we)\s+|\b(?:is\s+there\s+(?:a|any)|what(?:'s|’s|\s+is)\s+the\s+(?:best|easiest)|the\s+(?:best|easiest))\s+ways?\s+to\s+|\bi\s+(?:want|need|plan|intend|wanna|gonna)\s+(?:to\s+)?|\bi(?:\s+am|'m|’m)\s+(?:going|trying|planning)\s+to\s+|\bi(?:'ll|’ll|\s+will)\s+|\bplease\s+|\blet'?s\s+)`;
const SOFTENER = String.raw`(?:(?:just|easily|secretly|quietly|still|quickly|somehow|actually|safely|successfully|really|also|please)\s+)*`;
const DETERMINER = String.raw`(?:(?:my|the|a|an|some|his|her|their|our|this|that|these|those|another|someone(?:\s+else)?'s|somebody(?:\s+else)?'s)\s+)`;
// Up to three words between the act and its object, never across a
// preposition ("forge ahead with my application" is not forging it).
const FILLER = String.raw`(?:(?!(?:with|for|on|in|into|to|and|or|but|about|from|at|by|of|ahead|forward|through|like|as)(?![\w'’-]))[\w'’-]+\s+){0,3}?`;
const RECORD = String.raw`(?:transcripts?|grades?|gpa|report\s+cards?|scores?|score\s+reports?|sat|act|recommendations?|(?:recommendation|rec|reference)\s+letters?|letters?(?:\s+of\s+recommendation)?|awards?|certificates?|diplomas?|signatures?|documents?|hours|research|internships?|applications?|essays?|personal\s+statements?|resumes?|résumés?|activit(?:y|ies)|achievements?|accomplishments?|credentials?|records?|attendance|(?:acceptance|admissions?|offer)\s+letters?|tax\s+(?:returns?|forms?|documents?)|w-?2s?|income|fafsa|css\s+profile)`;
const IDENTITY = String.raw`(?:(?:my|a|an|the|someone's|his|her)\s+)?(?:(?:school|guidance|college|former|own|[a-z]+)\s+)?(?:teacher|counselor|counsellor|parents?|mom|mother|dad|father|guardian|principal|recommender|reference|coach|registrar|school\s+official|supervisor|boss|employer)\b|\bsomeone\s+else\b|\bsomebody\s+else\b|\banother\s+(?:student|person|applicant)\b|\ba\s+different\s+(?:student|person)\b`;
// Each act is written twice: after a request frame the object may stand
// bare ("how do I fake volunteer hours"); at the start of a sentence it needs
// a determiner, because "Fake grades are a problem at my school" is a
// statement and "Fake my transcript" is a request.
function dishonestActs(det) {
  return [
    [/(?:fake|forge|fabricate|falsify|counterfeit|photoshop)/i, String.raw`(?:fake|forge|fabricate|falsify|counterfeit|photoshop)(?!\s+(?:ahead|forward|on\b|through|a\s+(?:new\s+)?(?:path|way|bond|connection|relationship|friendship|partnership)|my\s+own|our\s+own|(?:new|strong(?:er)?|lasting|deep(?:er)?|real|genuine|meaningful|close(?:r)?)\s+\w+))\s+(?:me\s+)?${det}${FILLER}${RECORD}\b`],
    [/(?:fake|forged|fabricated|phony|false|made-up|counterfeit|bogus)/i, String.raw`(?:write|make|create|generate|draft|produce|get|give)\s+(?:me\s+)?${det}(?:fake|forged|fabricated|phony|false|made-up|counterfeit|bogus)\s+${FILLER}${RECORD}\b`],
    [/(?:alter|tamper|doctor)/i, String.raw`(?:alter|tamper\s+with|doctor)\s+${det}${FILLER}(?:transcripts?|report\s+cards?|score\s+reports?|certificates?|diplomas?|signatures?|documents?|records?|grades?)\b`],
    [/(?:plagiari)/i, String.raw`plagiari[sz]e\b`],
    [/(?:copy|steal|paste|submit|turn)/i, String.raw`(?:copy|steal|paste|submit|turn\s+in)\s+(?:someone(?:\s+else)?'s|somebody(?:\s+else)?'s|another\s+(?:student|person|applicant)'s|(?:my|a)\s+(?:friend|classmate|sibling|brother|sister|cousin)'s|other\s+people's)\s+${FILLER}(?:essays?|personal\s+statements?|work|answers?|responses?)\b`],
    [/(?:submit|turn|copy|paste)/i, String.raw`(?:submit|turn\s+in|copy|paste)\s+${det}${FILLER}(?:essays?|personal\s+statements?)\s+(?:that\s+)?(?:i|we)\s+(?:found|bought|got|downloaded|copied)\b`],
    [/(?:cheat)/i, String.raw`cheat\s+(?:on|in|at)\s+${det}${FILLER}(?:tests?|exams?|sat|act|psat|ap(?:\s+[\w-]+)?|finals?|quiz(?:zes)?|midterms?|applications?|essays?|homework|assignments?|ib(?:\s+[\w-]+)?|toefl|ielts|duolingo|class(?:es)?|courses?)\b`],
    [/(?:cheat)/i, String.raw`cheat\s+(?:my|our|his|her)\s+way\s+(?:in|into|through|to)\b`],
    [/(?:buy|purchase|order)/i, String.raw`(?:buy|purchase|order)\s+(?:me\s+)?${det}${FILLER}(?:essays?|personal\s+statements?|grades?|transcripts?|diplomas?|degrees?|(?:test|sat|act|ap)\s+scores?|(?:recommendation|rec|reference)\s+letters?|letters?\s+of\s+recommendation|(?:acceptance|admissions?)\s+letters?)\b(?!\s+(?:coach\w*|tutor\w*|review\w*|edit\w*|help|class(?:es)?|courses?|programs?|services?|prep\w*|guides?|books?|workshops?))`],
    [/(?:pay)/i, String.raw`pay\s+for\s+${det}${FILLER}(?:essays?|personal\s+statements?|grades?|diplomas?|degrees?)\b(?!\s+(?:coach\w*|tutor\w*|review\w*|edit\w*|help|class(?:es)?|courses?|programs?|services?|prep\w*|guides?|books?|workshops?|fees?))`],
    [/(?:buy|purchase|pay)/i, String.raw`(?:buy|purchase|pay\s+for)\s+(?:(?:my|our|his|her)\s+way\s+in(?:to)?|(?:my|an?)\s+(?:acceptance|admission|spot|seat)\b|(?:admissions?|acceptances?|a\s+spot|a\s+seat)\s+(?:to|into|at)\s+(?!(?:a|an|the)\s+(?:summer|pre-?college|camp|program|museum|event|conference|concert|game|show|workshop)\b)\S+)`],
    [/(?:pay)/i, String.raw`pay\s+(?:someone|somebody|people|a\s+(?:person|tutor|writer|service|company|student|friend)|an?\s+(?:essay\s+)?(?:writer|service))\s+to\s+(?:take|write|do|sit|complete|finish)\s+(?:my|the)\s+${FILLER}(?:sat|act|psat|tests?|exams?|essays?|applications?|class(?:es)?|courses?|homework|assignments?|personal\s+statements?|ap(?:\s+[\w-]+)?)\b`],
    [/(?:impersonate)/i, String.raw`impersonate\s+(?:${IDENTITY})`],
    [/(?:pretend|pose)/i, String.raw`(?:pretend\s+to\s+be|pose\s+as)\s+(?:${IDENTITY})[^.?!\n]{0,50}?\b(?:(?:to|and)\s+(?:sign|submit|send|email|e-mail|write|fill|complete|verify|confirm|vouch|apply|register|take|call|contact|log\s+in|upload)|(?:on|in|for)\s+(?:my|the)\s+(?:application|common\s+app|fafsa|css\s+profile|portal|forms?|recommendation))\b`],
    [/(?:hack)/i, String.raw`hack\s+into\s+${det}${FILLER}(?:portal|gradebook|grade\s+book|grades|systems?|database|records?|accounts?|computers?|powerschool|naviance|infinite\s+campus|schoology|canvas|common\s+app|college\s*board|websites?|servers?)\b`],
    [/(?:hack)/i, String.raw`hack\s+${det}${FILLER}(?:grades|gradebook|transcripts?|records?)\b`],
    [/(?:lie)/i, String.raw`lie\s+(?:about|on)\s+${det}${FILLER}(?:applications?|common\s+app|resumes?|résumés?|essays?|transcripts?|grades?|gpa|scores?|activit(?:y|ies)|hours|awards?|fafsa|income|css\s+profile|race|ethnicity|citizenship|residency|age)\b`],
    [/(?:inflate)/i, String.raw`inflate\s+${det}${FILLER}(?:hours|numbers|titles?|roles?|positions?)\b`],
    [/(?:make)/i, String.raw`make\s+up\s+${det}${FILLER}(?:awards?|activit(?:y|ies)|achievements?|accomplishments?|internships?|research|leadership\s+(?:roles?|positions?)|titles?)\b`],
  ];
}
// The keyword in front of each act is a prefilter: the screen also runs on
// the model copy of a thread message, attachment text included (up to 200k
// characters), and the frame patterns run only when the act's verb occurs.
const DISHONESTY_PATTERNS = [
  ...dishonestActs(`${DETERMINER}?`).map(([keyword, act]) => ({ keyword, pattern: new RegExp(`${REQUEST_FRAME}${SOFTENER}(?:${act})`, "gi") })),
  ...dishonestActs(DETERMINER).map(([keyword, act]) => ({ keyword, pattern: new RegExp(`${SENTENCE_START}${SOFTENER}(?:${act})`, "gi") })),
];
// A negation just before the request ("nobody should help me fake my
// grades"), or a third party who asked ("my friend asked me, 'can you help me
// fake my transcript?'"), is not the student asking.
const NEGATION_BEFORE = /\b(?:don'?t|do\s+not|doesn'?t|didn'?t|not|never|won'?t|wouldn'?t|shouldn'?t|avoid(?:ing)?|without|instead|rather|refuse[sd]?|nobody|no\s+one|against|stop)\b/i;
// The third party has to be the one who voices the request, right before it:
// "my friends said it's fine, so help me fake my transcript" is the student.
const THIRD_PARTY_ASKED = /\b(?:friends?|classmates?|brother|sister|cousin|someone|somebody|he|she|they|people|kids|students?|guy|girl|teammates?)\b[^.?!\n]{0,40}\b(?:said|says|asked|asks|told|tells|texted|messaged|wrote|(?:wants|wanted)\s+to\s+know)(?:\s+(?:me|us))?(?:\s+(?:that|if|whether))?\s*[,:]?\s*["“']?\s*$/i;

function isStudentRequest(text, index) {
  const lead = text.charAt(index);
  if (index === 0 || /[.!?;\n]/.test(lead)) return true;
  const clause = text.slice(Math.max(0, index - 80), index).split(/[.!?;\n]/).pop();
  const lastWords = clause.trim().split(/\s+/).slice(-4).join(" ");
  if (NEGATION_BEFORE.test(lastWords)) return false;
  if (THIRD_PARTY_ASKED.test(clause)) return false;
  return true;
}

function findDishonestRequest(text) {
  for (const { keyword, pattern } of DISHONESTY_PATTERNS) {
    if (!keyword.test(text)) continue;
    for (const match of text.matchAll(pattern)) {
      if (isStudentRequest(text, match.index)) return match[0];
    }
  }
  return null;
}

// Essay ghost-writing — the skill's hard red line is "never ghost-write an
// application essay" (brainstorming, outlines, and feedback on the student's
// own draft are fine). The client prompts say this, but the server must not
// trust the client, so we enforce it here too. We target requests that ask us
// to PRODUCE the essay: a production verb addressed to the assistant, acting
// directly on the essay ("can you write my personal statement", "write my
// essay for me", "a first draft of my essay"). A first-person question about
// writing it ("how should I write my why-us essay?", "should I write about my
// divorce in my essay?"), "help me write", and a coaching object between the
// verb and the essay (an outline, comments, a list of topics, a better intro)
// pass through to the coaching specialists.
const GHOST_VERB = String.raw`(?:write|compose|draft|generate|create|produce|craft|pen|ghost-?write|whip\s+up)`;
const ESSAY_NOUN = String.raw`(?:essays?|personal\s+statements?|statements?\s+of\s+purpose|supplementals?|piqs?|personal\s+insight\s+(?:questions?|responses?|essays?|answers?))`;
const ESSAY_DET = String.raw`(?:my|the|a|an|this|that|these|those|one|two|three|four|five|some|all|both|each|every|our|\d+)`;
const ESSAY_GAP_STOP = String.raw`(?:about|for|of|on|in|into|to|with|from|at|by|regarding|around|before|after|if|whether|how|what|why|when|where|which|who|that|like|as|than|so|because|and|or|but|then|your|you|i|we|they|he|she|it|outlines?|feedback|comments?|notes?|ideas?|topics?|lists?|summar(?:y|ies)|plans?|structures?|intros?|introductions?|hooks?|conclusions?|paragraphs?|sentences?|thesis|openings?|endings?|titles?|prompts?|questions?|tips|advice|timelines?|schedules?|checklists?|rubrics?|reviews?|critiques?|edits?|revisions?|brainstorm\w*)`;
// A stop word must be the whole token: "why-Columbia" is a modifier, not "why".
const ESSAY_GAP = String.raw`(?:\s+(?!${ESSAY_GAP_STOP}(?![\w'’"“”-]))[\w'’"“”-]+){0,5}?`;
const NOT_COACHING_AFTER_NOUN = String.raw`(?!['’]s\b)(?!\s+(?:topics?|ideas?|outlines?|prompts?|feedback|comments?|notes?|questions?|tips|advice|structure|plans?|brainstorm\w*|reviews?|word\s+(?:count|limit)s?|deadlines?|requirements?|rubrics?|formats?|guidelines?|tutor\w*|coach\w*|help|workshops?|class(?:es)?|courses?|skills?|hooks?|intros?|introductions?|conclusions?|openings?|endings?|titles?|paragraphs?|examples?|samples?|strateg(?:y|ies)|checklists?|timelines?|schedules?)\b)`;
const ADDRESSEE_FRAME = String.raw`(?:\b(?:can|could|would|will)\s+(?:you|u|ya)\s+|\bi\s+(?:want|need|would\s+like)\s+(?:you|u)\s+to\s+|\bi(?:'d|’d)\s+like\s+(?:you|u)\s+to\s+|\b(?:are\s+you\s+able|is\s+it\s+possible\s+for\s+you)\s+to\s+|\bplease\s+)`;
const ASKED_TO_WRITE = String.raw`(?:${ADDRESSEE_FRAME}|${SENTENCE_START})${SOFTENER}${GHOST_VERB}`;
const GHOSTWRITING_PATTERNS = [
  // "can you write my personal statement", "Write my college essay"
  new RegExp(String.raw`${ASKED_TO_WRITE}(?:\s+(?:me|us|up|out))?\s+${ESSAY_DET}${ESSAY_GAP}\s+${ESSAY_NOUN}\b${NOT_COACHING_AFTER_NOUN}`, "i"),
  // "... my essay for me", "... an essay about my grandmother for me"
  new RegExp(String.raw`\b${GHOST_VERB}(?:\s+(?:me|us|up|out))?(?:\s+${ESSAY_DET})?${ESSAY_GAP}\s+${ESSAY_NOUN}\b${NOT_COACHING_AFTER_NOUN}(?:\s+(?:about|on)\s+[^.?!\n]{0,30}?)?\s+(?:please\s+)?for\s+(?:me|us)\b`, "i"),
  // "my essay is due tomorrow, can you write it for me?", "my essay written for me"
  new RegExp(String.raw`\b${ESSAY_NOUN}\b[^.?!\n]{0,40}?(?:\b(?:written|composed|drafted|ghost-?written)\s+for\s+(?:me|us)\b|\b${GHOST_VERB}\s+(?:it|one|them)\s+for\s+(?:me|us)\b|${ADDRESSEE_FRAME}${SOFTENER}${GHOST_VERB}\s+(?:it|one|them)\b)`, "i"),
  // "can you write a first draft of my essay"
  new RegExp(String.raw`${ASKED_TO_WRITE}(?:\s+me)?\s+(?:a|an|the|my)\s+(?:(?:rough|first|second|full|complete|new|final|better|whole|entire|quick|sample|model)\s+)*(?:draft|version|copy)\s+(?:of|for)\s+(?:my|the|a|an|this|that)${ESSAY_GAP}\s+${ESSAY_NOUN}\b`, "i"),
  // "write 650 words for my common app essay"
  new RegExp(String.raw`${ASKED_TO_WRITE}(?:\s+me)?\s+(?:\d{2,4}|a\s+few\s+hundred|(?:one|two|three|four|five|six)\s+hundred)\s+words?\s+(?:for|of|on)\s+(?:my|the|a|an|this|that)${ESSAY_GAP}\s+${ESSAY_NOUN}\b`, "i"),
];

const OFF_TOPIC_PATTERNS = [
  /\b(tell\s+me\s+a\s+joke|sing\s+a\s+song|write\s+a\s+poem)\b/i,
  /\b(what\s+is\s+the\s+meaning\s+of\s+life)\b/i,
  /\b(play\s+a\s+game|let'?s\s+play)\b/i,
];

// ─── Screen input before processing ───
export function screenInput(text, options = {}) {
  const results = [];

  if (!text || typeof text !== "string") {
    return { category: CATEGORIES.SAFE, results: [], redactedText: text || "", text: text || "", redacted: false, blocked: false };
  }

  // A specialist turn arrives as "<student_message>…</student_message>" plus
  // the client's one-line instruction; the request screens read the
  // student's words as sentences of their own, so the tags are breaks.
  const requestText = text.replace(/<\/?student_message>/gi, "\n");

  // 1. Credential detection (highest priority, blocks immediately)
  for (const { pattern, type, message } of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) {
      results.push({
        category: CATEGORIES.CREDENTIAL,
        type,
        message,
        blocked: true,
      });
    }
  }

  if (results.some((r) => r.blocked)) {
    const message = results.find((r) => r.blocked).message;
    return {
      category: CATEGORIES.CREDENTIAL,
      results,
      blocked: true,
      message,
      reason: message,
      redactedText: text,
      text,
      redacted: false,
    };
  }

  // 2. Academic dishonesty: a request to falsify, buy or cheat. The reply
  //    redirects to the honest version of what the student wants; the old
  //    "academic dishonesty or fraudulent activity" line accused students
  //    who had asked how not to sound fake.
  if (findDishonestRequest(requestText)) {
    const message = "I can't help with anything that misrepresents your record — a faked grade, score, letter or essay can get an application rejected or an admission withdrawn, even after you enroll. What I can do is help you present what you've really done as strongly as possible: describing your activities, explaining a weaker grade, or planning a retake. What would you like to work on?";
    results.push({ category: CATEGORIES.INAPPROPRIATE, type: "academic_dishonesty", blocked: true, message });
  }

  if (results.some((r) => r.blocked)) {
    const message = results.find((r) => r.blocked).message;
    return {
      category: CATEGORIES.INAPPROPRIATE,
      results,
      blocked: true,
      message,
      reason: message,
      redactedText: text,
      text,
      redacted: false,
    };
  }

  // 2b. Essay ghost-writing (block, but with a warm redirect — not the
  //     harsher academic-dishonesty message). Offers the coaching path the
  //     skill does allow.
  for (const pattern of GHOSTWRITING_PATTERNS) {
    if (pattern.test(requestText)) {
      const message = "I can't write your college essay for you — admissions essays have to be your own work, and a ghost-written one can get an application rescinded. What I can do is help you brainstorm ideas, shape an outline, or give honest feedback on a draft you've written yourself. Want to start by talking through what you'd like the essay to say?";
      return {
        category: CATEGORIES.INAPPROPRIATE,
        results: [{ category: CATEGORIES.INAPPROPRIATE, type: "essay_ghostwriting", blocked: true, message }],
        blocked: true,
        message,
        reason: message,
        redactedText: text,
        text,
        redacted: false,
      };
    }
  }

  // 3. Off-topic (soft block — redirect, don't hard block)
  for (const pattern of OFF_TOPIC_PATTERNS) {
    if (pattern.test(text)) {
      results.push({
        category: CATEGORIES.OFF_TOPIC,
        blocked: false,
        message: "I'm focused on college planning and admissions. How can I help with your college journey?",
      });
    }
  }

  // 4. PII detection and redaction
  let redactedText = text;
  const piiFound = [];
  for (const { pattern, type, replacement, restorable } of PII_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) {
      for (const match of matches) {
        const token = `${replacement.slice(0, -1)}_${crypto.randomUUID().slice(0, 8)}]`;
        redactedText = redactedText.replace(match, token);
        piiFound.push({ type, original: restorable ? match : null, token, restorable });
      }
    }
  }

  if (piiFound.length > 0) {
    results.push({
      category: CATEGORIES.PII_DETECTED,
      blocked: false,
      piiItems: piiFound,
      message: `${piiFound.length} PII item(s) detected and redacted before processing.`,
    });
  }

  const category = results.length > 0
    ? results[0].category
    : CATEGORIES.SAFE;

  return {
    category,
    results,
    blocked: false,
    redactedText,
    text: redactedText,
    redacted: piiFound.length > 0,
    piiTokenMap: piiFound.filter((p) => p.restorable).reduce((map, p) => {
      map[p.token] = p.original;
      return map;
    }, {}),
  };
}

// Pseudo-tool-call markup. Open-weight models sometimes emit fake tool-call
// syntax as plain text (e.g. <|tool_call>call:fetch_rag_context(focus="x")
// <tool_call|>) when a prompt mentions tools that don't exist in this
// environment. Never legitimate counselor output — strip it.
const PSEUDO_TOOL_PATTERNS = [
  /<\|?\/?\s*tool_call\s*\|?>/gi,
  /<\/?tool_(?:code|outputs?|results?)>/gi,
  /```tool_(?:code|call)[\s\S]*?```/g,
  /\bcall:\s*[a-z_][\w.]*\s*\([^()\n]*\)/gi,
  /^[ \t]*(?:fetch_rag_context|fetch_student_trends|fetch_milestones|get_student_profile|get_extracurriculars|update_extracurriculars|update_student_profile|analyze_ec_strength|suggest_ecs|get_ap_rigor|get_sat_context|search_colleges|fetch_college_match|generate_study_notes)\s*\([^)\n]*\)[ \t]*$/gim,
];

// ─── Screen output before returning to user ───
export function screenOutput(text, options = {}) {
  if (!text || typeof text !== "string") return { safe: true, text: text || "" };

  const issues = [];

  // Strip pseudo-tool-call markup before anything else.
  let strippedToolMarkup = false;
  for (const pattern of PSEUDO_TOOL_PATTERNS) {
    if (text.match(pattern)) {
      strippedToolMarkup = true;
      text = text.replace(pattern, "");
    }
  }
  if (strippedToolMarkup) {
    issues.push({ type: "pseudo_tool_markup", message: "Tool-call markup detected in model output — removed." });
    text = text.replace(/\n{3,}/g, "\n\n").trim();
  }

  // Check for leaked PII in model output. We redact the NON-restorable PII
  // types (SSN, phone) — these should never legitimately appear in a
  // counselor reply, so if one shows up it's a leak/hallucination. We do
  // NOT redact the restorable types (email, financial) here: those are
  // either deliberately round-tripped via restorePII (run right after this
  // in server.js) or are legitimate counseling content (tuition/scholarship
  // dollar figures, official admissions contacts). PII_PATTERNS regexes are
  // /g, so match via .match() (resets lastIndex) rather than stateful .test().
  for (const { pattern, type, restorable } of PII_PATTERNS) {
    if (restorable) continue;
    if (text.match(pattern)) {
      issues.push({ type: `${type}_leak`, message: `${type} detected in model output — redacting.` });
      text = text.replace(pattern, "[REDACTED]");
    }
  }

  // Check for credential patterns in output. Only the captured value is
  // blanked, every occurrence of it; the keyword and the how-to text around
  // it stay.
  for (const { pattern, type } of CREDENTIAL_PATTERNS_GLOBAL) {
    let hit = false;
    text = text.replace(pattern, (match, ...args) => {
      hit = true;
      const value = args.find((arg) => typeof arg === "string" && arg.length > 0 && match.includes(arg));
      if (!value) return "[REDACTED]";
      const at = match.lastIndexOf(value);
      return `${match.slice(0, at)}[REDACTED]${match.slice(at + value.length)}`;
    });
    if (hit) issues.push({ type: `${type}_leak`, message: `${type} detected in model output — redacting.` });
  }

  return {
    safe: issues.length === 0,
    text,
    issues,
    modified: issues.length > 0,
  };
}

// ─── Restore redacted PII in response (for restorable items only) ───
export function restorePII(text, tokenMap) {
  if (!text || !tokenMap || Object.keys(tokenMap).length === 0) return text;

  let restored = text;
  for (const [token, original] of Object.entries(tokenMap)) {
    if (original) {
      restored = restored.replaceAll(token, original);
    }
  }
  return restored;
}

// ─── Redact document before inference (when full context is unnecessary) ───
export function redactDocumentForInference(content, docClassification) {
  if (!content) return { redacted: "", piiRemoved: 0 };

  let redacted = content;
  let piiRemoved = 0;

  // Always redact SSN, phone, and addresses
  for (const { pattern, type, replacement } of PII_PATTERNS) {
    const matches = redacted.match(pattern);
    if (matches) {
      piiRemoved += matches.length;
      redacted = redacted.replace(pattern, replacement);
    }
  }

  // For sensitive financial documents, also redact dollar amounts if we only need structure
  if (docClassification === "SENSITIVE_FINANCIAL") {
    // Keep structure but redact specific values
    redacted = redacted.replace(/\$[\d,]+\.?\d{0,2}/g, "$[AMOUNT]");
  }

  return { redacted, piiRemoved };
}

function makeProviderRedactionState() {
  return {
    counters: {},
    tokenMap: {},
    countsByType: {},
    restorableCount: 0,
    nonRestorableCount: 0,
    applied: false,
  };
}

function nextProviderToken(state, label) {
  state.counters[label] = (state.counters[label] || 0) + 1;
  return `[${label}_${String(state.counters[label]).padStart(2, "0")}]`;
}

function redactProviderString(value, state) {
  if (typeof value !== "string" || value.length === 0) return value;
  let out = value;
  for (const rule of PROVIDER_REDACTION_PATTERNS) {
    out = out.replace(rule.pattern, (match, ...args) => {
      // replace() passes the captures, then the offset and the whole string.
      const whole = args[args.length - 1];
      const offset = args[args.length - 2];
      const captures = args.slice(0, -2);
      // `keep` spares a match that only has the shape of the PII (an event
      // name, a common-noun pair); `rewrite` puts the student's own figure
      // in a form the redactor leaves alone instead of erasing it.
      if (rule.keep?.(match, offset, whole)) return match;
      const rewritten = rule.rewrite?.(match, offset, whole, captures);
      if (typeof rewritten === "string") return rewritten;
      const original = match.replace(rule.trimPrefix || /^$/, "").replace(rule.trimSuffix || /^$/, "");
      const prefix = rule.trimPrefix ? match.match(rule.trimPrefix)?.[0] || "" : "";
      const suffix = rule.trimSuffix ? match.match(rule.trimSuffix)?.[0] || "" : "";
      const token = nextProviderToken(state, rule.label);
      state.applied = true;
      state.countsByType[rule.type] = (state.countsByType[rule.type] || 0) + 1;
      if (rule.restorable) {
        state.tokenMap[token] = original;
        state.restorableCount += 1;
      } else {
        state.nonRestorableCount += 1;
      }
      return `${prefix}${token}${suffix}`;
    });
  }
  return out;
}

// Redact a single string (e.g. an auto-injected system prompt) through the
// provider-redaction patterns. Returns the masked text plus a tokenMap so the
// caller can restore restorable tokens (student name / school) if the model
// echoes them back to the student. Used to mask the profile context that
// /api/chat builds outside the payload-redaction boundary.
export function redactProviderText(value) {
  if (typeof value !== "string" || value.length === 0) {
    return { text: value || "", tokenMap: {}, applied: false, byType: {} };
  }
  const state = makeProviderRedactionState();
  const text = redactProviderString(value, state);
  return { text, tokenMap: state.tokenMap, applied: state.applied, byType: state.countsByType };
}

function sanitizeDeep(value, state) {
  if (typeof value === "string") return redactProviderString(value, state);
  if (Array.isArray(value)) return value.map((item) => sanitizeDeep(item, state));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitizeDeep(child, state)]));
  }
  return value;
}

export function stripStructuredFinancialPII(payload) {
  const cloned = JSON.parse(JSON.stringify(payload ?? {}));
  const profile = cloned?.metadata?.fafsaProfile;
  if (!profile || typeof profile !== "object") {
    return { payload: cloned, structuredSanitization: { applied: false, strippedFieldCount: 0 } };
  }
  const sensitiveFields = [
    "parentAdjustedGrossIncome",
    "parentIncome",
    "studentIncome",
    "parentAssets",
    "studentAssets",
    "cashSavingsChecking",
    "taxableIncome",
  ];
  let strippedFieldCount = 0;
  for (const field of sensitiveFields) {
    if (profile[field] !== undefined) {
      delete profile[field];
      strippedFieldCount += 1;
    }
  }
  if (strippedFieldCount > 0) {
    profile.rawTaxDataStripped = true;
    profile.strippedFieldCount = strippedFieldCount;
    if (Number(profile.studentAidIndex) <= -1500) {
      profile.financialNeedCategory = "maximum_need";
    } else if (Number.isFinite(Number(profile.studentAidIndex))) {
      profile.financialNeedCategory = "estimated_need";
    }
  }
  return {
    payload: cloned,
    structuredSanitization: { applied: strippedFieldCount > 0, strippedFieldCount },
  };
}

export function sanitizeProviderPayload(payload, options = {}) {
  const structured = stripStructuredFinancialPII(payload);
  const state = makeProviderRedactionState();
  const sanitizedPayload = sanitizeDeep(structured.payload, state);
  const redactionReport = {
    applied: state.applied || structured.structuredSanitization.applied,
    byType: state.countsByType,
    restorableTokens: state.restorableCount,
    nonRestorableTokens: state.nonRestorableCount,
    structuredSanitization: structured.structuredSanitization,
    boundary: options.boundary || "provider",
  };
  return {
    sanitizedPayload,
    payload: sanitizedPayload,
    tokenMap: state.tokenMap,
    redactionReport,
    masking: {
      applied: redactionReport.applied,
      byLayer: {
        deterministic: Object.values(state.countsByType).reduce((sum, count) => sum + count, 0),
        guardian_slm: (state.countsByType.student_name_context || 0) + (state.countsByType.school_context || 0),
      },
      restorableTokens: state.restorableCount,
    },
    structuredSanitization: structured.structuredSanitization,
  };
}

// Need crypto for PII token generation
import crypto from "node:crypto";
