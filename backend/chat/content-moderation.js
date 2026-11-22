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
const EVENT_BEFORE_COURT = /\b(?:moot|food|tennis|basketball|volleyball|badminton|squash|pickleball|handball|racquetball|supreme|federal|district|appeals?|appellate|juvenile|teen|youth|traffic|family|mock|county|state|superior|circuit|peer|student|honor|homecoming|prom|royal|snowball|sweetheart|winter|spring)\s+$/i;
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
const COMMON_CAPITALIZED_WORDS = new Set(("school schools student students member members kid kids children volunteer volunteers donor donors patient patients senior seniors resident residents family families teacher teachers player players athlete athletes refugee refugees immigrant immigrants veteran veterans scout scouts peer peers tutee tutees mentee mentees camper campers participant participants delegate delegates judge judges speaker speakers leader leaders officer officers representative representatives team teams club clubs society council center program project summer science math research art arts music honor national international global world state regional county city community local model debate robotics middle high elementary university college academy award awards prize medal medals grant scholarship food bank habitat humanity red cross cancer hospital church temple library museum park camp league association foundation institute department olympiad competition tournament championship varsity junior freshman sophomore english korean spanish chinese french history biology chemistry physics computer coding engineering business united nations youth teen girls boys women men people friends classmates mentors coaches parents guests visitors attendees alumni interns workers staff faculty nurses doctors engineers scientists artists musicians writers readers learners supplies books toys clothes meals donations funds early action decision regular restrictive single choice rolling admission admissions waitlist deferral deferred transfer fall spring winter merit roll dean deans scholars presidential")
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

// ─── Identity fields of a school document ───
// A transcript or a school record names its student in labeled header
// fields, and until 2026-11-22 the shapes above were all the provider
// boundary knew: a US phone number, "123 Main Street", "ID: A1234",
// "First Last from". A mock run of the transcript import sent a real
// international school's header to the model with the student's name,
// student ID number, date of birth, the school's +82 phone number and
// Korean street address, and the signing counselor's name all intact;
// only the two emails were masked. The patterns below mask the VALUE of
// such a field and keep its label, so the parser still sees which line is
// the header.
//
// What a value may take was narrowed after the PR #7 review and three
// adversarial rounds over the first versions:
//   - a value stays on its line and in its column (a tab or two spaces end
//     it) and stops before the next label on the line, so "Counselor: Dana
//     Whitfield Cumulative GPA: 3.86" keeps the GPA, and "Phone: +82
//     02-555-0142" never takes the "3.86" printed under it;
//   - a name is read by its shape AND must be the whole field: capitalized
//     or all-caps words, initials, a title, "Last, First", particles,
//     accents, ending at the line, a column gap, "|" or the next label. A
//     sentence ("Student: Sure! I'm a junior", "Student: Economics."), a
//     status ("Counselor: Submitted"), an occupation or a degree is not a
//     name, and a Hangul value starts with a Korean surname and is not a
//     word ("보호자: 반대", "Mother: 간호사");
//   - a date of birth is a date (a month name, a four-digit year, 년, or
//     three numbers), never "parties for 25" or "Do B students";
//   - labels that are also everyday words ("Name:", "Student:", 성명, 보호자,
//     학번, 주소) count only at the start of a line or a column, and a
//     Korean address needs its province or district and a road or lot
//     number, never a subject ("과학탐구 물리 2") or a 정시 group ("가군 연세대로 1").
// A field starts at its first character after a line start, a tab, two
// spaces, or (pdf.js joins columns with one space) the previous field's
// number. The negative lookahead comes first so a position inside a run of
// spaces fails at once: "(?<=[ \t]{2})[ \t]*" rescanned the rest of the
// run from every position in it, and 200,000 spaces in an attachment took
// minutes (quadratic) on the one server process.
const FIELD_START = String.raw`(?![ \t])(?:^|(?<=^[ \t]+)|(?<=[ \t]{2})|(?<=\t)|(?<=[\d)][ ]))`;
const FIELD_END = String.raw`(?=[ \t]{2,}|\t|\r|$)`;
const FIELD_LABEL_PREFIX = /^[^:：]*[:：][ \t]*/;
const FIELD_NEXT_LINE_PREFIX = /^[^:：]*[:：][ \t]*\r?\n[ \t]*/;
const MASKED_TOKEN = /^\[[A-Z_]+_\d{2}\]$/;

// A label phrase in either case without the i flag: name values are read
// by their capitals, so the patterns that hold them are case-sensitive.
function anyCase(phrase) {
  return phrase.trim().split(/\s+/)
    .map((word) => escapeForRegExp(word).replace(/[A-Za-z]/g, (ch) => `[${ch.toLowerCase()}${ch.toUpperCase()}]`))
    .join(String.raw`[ \t]+`);
}
const anyOf = (...phrases) => `(?:${phrases.map(anyCase).join("|")})`;
// The same word with a capital first letter: the next column of a
// transcript line ("Class of 2027"), not the next word of a sentence
// ("year was rough").
function capitalized(phrase) {
  const word = phrase.trim();
  return escapeForRegExp(word[0].toUpperCase()) + escapeForRegExp(word.slice(1)).replace(/[A-Za-z]/g, (ch) => `[${ch.toLowerCase()}${ch.toUpperCase()}]`);
}

// The next label on a line ("Grade:", "Cumulative GPA:", "Date of Birth:",
// "CEEB Code:"): a value stops in front of it.
const LABEL_WORDS = ["student", "name", "id", "number", "no", "date", "birth", "birthdate", "dob", "grade", "level",
  "gpa", "cumulative", "weighted", "unweighted", "class", "rank", "credits", "credit", "graduation", "address", "phone",
  "tel", "fax", "email", "e-mail", "counselor", "counsellor", "principal", "gender", "sex", "year", "school", "ceeb",
  "code", "term", "semester", "program", "programme", "diploma", "coordinator", "director", "registrar", "advisor",
  "adviser", "preferred", "parent", "guardian", "mother", "father", "signature", "title", "homeroom", "sasid", "ssid",
  "state", "perm", "local", "ssn", "citizenship", "nationality", "enrollment", "entry", "status", "age", "major", "track"];
const LABEL_WORD = anyOf(...LABEL_WORDS);
const LABEL_WORD_CAP = `(?:${LABEL_WORDS.map(capitalized).join("|")})`;
// Words that qualify a one-word label: "SAT Total:", "Unwtd. GPA:".
const LABEL_QUALIFIER = anyOf("sat", "act", "ap", "ib", "total", "unwtd.", "wtd.", "cum.", "cumulative", "weighted", "unweighted",
  "class", "expected", "graduation", "attendance", "test", "home", "cell", "student", "school", "parent", "date", "overall",
  "final", "current", "entry", "exit", "toefl", "ielts");
const NEXT_LABEL = String.raw`(?:${LABEL_WORD}(?:[ \t]+[A-Za-z#.'’()\/-]+){0,3}|(?:${LABEL_QUALIFIER}[ ])?[A-Z][A-Za-z.]*)[ \t]*[:：]`;
// Course words that open the next column of a transcript line.
const COURSE_WORDS = "AP|IB|Honors|Hon|Studies|English|History|Biology|Bio|Chemistry|Chem|Physics|Calculus|Calc|Algebra|Geometry|Spanish|French|Korean|Chinese|Latin|Religious|Global|World|Science|Math|Literature|Lit|Seminar|Research|Economics|Psychology|Statistics|Stats|Period|Room|Rm";

// ─── Names ───
// Letters with accents and the Latin extensions count ("María José García
// López", "Nguyễn Thị Lan", "Łukasz Wójcik").
const UPPER = "A-ZÀ-ÖØ-ÞĀ-ſƀ-ɏḀ-ỿ";
const LETTER = "A-Za-zÀ-ÖØ-öø-ÿĀ-ſƀ-ɏḀ-ỿ";
// A title is a whole word ("Dr" in "Drama" is not one), and so is every
// name word; "(Grace)" between names is a preferred name.
const NAME_WORD = String.raw`(?:(?:Mrs|Mr|Ms|Mx|Dr|Prof|Rev|Fr)(?:\.|(?![${LETTER}]))|[${UPPER}][${LETTER}'’-]*\.?|\([${UPPER}][${LETTER}'’-]*\))(?![${LETTER}])`;
// "Last, First", "Daniel and Sora", "van der Berg", "de los Angeles".
const NAME_JOIN = String.raw`(?:,[ ]|[ ](?:and|&)[ ]|(?:[ ](?:van|von|der|den|de|del|della|da|di|du|dos|das|la|las|los|le|dela|delos|y|e|bin|binti|al|el|ten|ter)){1,2}[ ]|[ ])`;
// A trailing credential: "Rachel Lin, M.Ed.", "Dr. Helen Moore, Ed.D.".
const CREDENTIAL = String.raw`(?:,[ ](?:[A-Z][A-Za-z]{0,3}\.){1,3})?`;
// A label or course word is never the next word of a name: "Dana Whitfield
// Class Rank 15" is a name and the next column.
const NEXT_NAME_WORD = String.raw`(?!${NEXT_LABEL}|(?:${LABEL_WORD}|${COURSE_WORDS})(?![A-Za-z]))`;
const LATIN_NAME = String.raw`${NAME_WORD}(?:${NAME_JOIN}${NEXT_NAME_WORD}${NAME_WORD}){0,7}${CREDENTIAL}`;
const LATIN_NAME_2 = String.raw`${NAME_WORD}(?:${NAME_JOIN}${NEXT_NAME_WORD}${NAME_WORD}){1,7}`;
// The field ends after the name: the line, a column gap, "|", ";", "(",
// " /", or the next label.
const NAME_END = String.raw`(?=[ \t]*\r?$|[ \t]{2,}|\t|[ ]?[|;(]|[ ]\/|,?[ ]${NEXT_LABEL})`;
// Or a name of two words or more runs into the next column of a pdf.js
// line: "Jordan Ellis Class of 2027", "Dr. Helen Moore Economics A 0.5".
const NAME_COLUMN_END = String.raw`(?=[ ](?:${LABEL_WORD_CAP}|${COURSE_WORDS})(?![A-Za-z]))`;
// A Hangul or Han name under an English label is the whole field.
const NAME_VALUE = String.raw`(?:(?:${LATIN_NAME}|[가-힣]{2,4}|[一-鿿]{2,4})${NAME_END}|${LATIN_NAME_2}${NAME_COLUMN_END})`;

// A capitalized word that opens a sentence, a status, a family word, and
// words that make a value an organization, an activity, an occupation, a
// degree or a heading rather than a person.
const NAME_STOPWORDS = new Set(("i i'm im we you he she it they what how why when where who which whose should can could would "
  + "will do does did is are was were be been the a an this that these those my your our their his her its yes no ok okay hi "
  + "hello hey thanks thank please not none n/a na tbd tba same see unknown pending one two three four five six seven eight "
  + "nine ten first last next sure well so great honestly yeah yep nope maybe hmm um uh really just also actually basically "
  + "definitely absolutely apply applied applying good nice cool wow oh dear sorry let let's deceased divorced separated "
  + "married single widowed retired unemployed self-employed homemaker mom dad mum mother father grandma grandpa grandmother "
  + "grandfather aunt uncle sister brother parents guardian self submitted requested sent received done completed waiting "
  + "asked confirmed declined approved missing outstanding excellent advanced exceeds meets proficient strong average fair "
  + "poor staff unassigned undeclared vacant understood perfect correct right exactly agreed junior senior freshman "
  + "sophomore fall spring summer winter unweighted weighted dream final middle elementary").split(" "));
const NOT_NAME_WORDS = new Set(("club team society council program programme project academy school university college institute "
  + "foundation association league band orchestra choir committee center centre bank hospital church olympiad competition "
  + "tournament award awards prize scholarship camp lab laboratory research debate robotics science math model united nations "
  + "office department report transcript record letter form sheet profile summary recommendation official secondary "
  + "information page ap ib honors course courses class biology chemistry physics calculus history english literature "
  + "studies counseling diploma statement essay draft feedback voice story varsity jv soccer basketball baseball football "
  + "volleyball tennis swimming swim track golf hockey lacrosse wrestling newspaper yearbook drama theater theatre "
  + "nurse engineer teacher doctor driver manager owner worker citizen citizenship resident employee clerk accountant lawyer "
  + "professor pastor chef cook officer military army navy business company store shop restaurant pharmacist electrician "
  + "plumber technician mechanic carpenter farmer cashier salesperson designer developer programmer scientist analyst "
  + "consultant dentist therapist librarian secretary assistant housewife homemaker degree bachelor master associate "
  + "doctorate ged phd mba grandparent parent trial bowl squad scouts scout government country relay hacks deca fbla hosa "
  + "nhs quiz initiative alliance coalition movement network organization chapter").split(" "));
// A word and its plural or possessive read the same: "Teachers", "Bachelor's".
const nameWordKey = (word) => word.replace(/['’]s$/, "").replace(/(?<=[a-z]{3})s$/, "");
// Korean: a name is two to four syllables, starts with a surname, and is
// not a word ("반대", "간호사", "한국인", "그렇군요", "귀하").
const KO_SURNAMES = new Set("김 이 박 최 정 강 조 윤 장 임 한 오 서 신 권 황 안 송 전 홍 유 고 문 양 손 배 백 허 남 심 노 하 곽 성 차 주 우 구 민 류 나 진 지 엄 채 원 천 방 공 현 함 변 염 여 추 도 소 석 선 설 마 길 연 위 표 명 기 반 라 왕 금 옥 육 인 맹 제 모 탁 국 어 은 편 용 예 경 봉 사 부 피 범 승 갈".split(" "));
const KO_COMPOUND_SURNAMES = /^(?:남궁|황보|제갈|선우|독고|사공|서문|동방)/;
const KO_NOT_A_NAME = new Set(("할머니 외할머니 할아버지 외할아버지 어머니 아버지 엄마 아빠 부모님 부모 조부모 이모 고모 삼촌 외삼촌 큰아버지 "
  + "작은아버지 형 누나 언니 오빠 본인 없음 미정 해당없음 선생님 반대 찬성 사망 이혼 별거 재혼 한국인 미국인 외국인 중국인 "
  + "일본인 회사원 주부 자영업 공무원 교사 간호사 의사 학생 무직 은퇴 직장인 한글 국문 영문 한자 제한없음 귀하 담당자 "
  + "대리인 서명 날인 직인 확인 추천 명의 새엄마 새아빠 양부모 조모 조부 고민 진행 완료 대기 제출 미제출 동의 미동의").split(" "));
function isKoreanName(value) {
  if (!/^[가-힣]{2,4}$/.test(value) || KO_NOT_A_NAME.has(value)) return false;
  if (/(?:요|다|니다|군요|죠|네|음|함|됨|임|중)$/.test(value)) return false;
  return KO_SURNAMES.has(value[0]) || KO_COMPOUND_SURNAMES.test(value);
}
function notAName(prefix) {
  return (match) => {
    const value = match.replace(prefix, "").trim();
    if (!value || MASKED_TOKEN.test(value)) return true;
    if (/^[가-힣]+$/.test(value)) return !isKoreanName(value);
    // A sentence ends in a period; a name ends in an initial or a title.
    const lastWord = value.split(/\s+/).at(-1);
    if (/\.$/.test(lastWord) && !/^(?:[A-Z]\.|(?:[A-Z][A-Za-z]{0,3}\.){1,3}|Jr\.|Sr\.)$/.test(lastWord)) return true;
    const words = value.toLowerCase().replace(/[.,&()]/g, " ").split(/\s+/).filter(Boolean);
    if (NAME_STOPWORDS.has(words[0])) return true;
    if (words.some((word) => NOT_NAME_WORDS.has(word) || NOT_NAME_WORDS.has(nameWordKey(word)))) return true;
    // Every word an everyday capitalized noun ("Early Action") is not a
    // name either, unless it ends in a surname ("Grace Park").
    return words.length > 1 && words.every((word) => COMMON_CAPITALIZED_WORDS.has(word)) && !SURNAME_WORDS.has(words.at(-1));
  };
}
const notKoreanName = (prefix) => (match) => !isKoreanName(match.replace(prefix, "").trim());

// "Name: Mock Trial\nPosition: Lead Attorney" is an activity, not a person:
// a bare name label next to activity fields, or under "Activity 2".
const ACTIVITY_FIELD = /^[ \t]*(?:[-*•][ \t]*)?(?:position|role|title|hours|grades?|category|type|description|organization|activity|level|leadership|award|weeks|participation|timing)\b[^:\n]{0,24}:/i;
function inActivityBlock(match, offset, whole) {
  const end = offset + match.length;
  const nextBreak = whole.indexOf("\n", end);
  const nextLine = nextBreak < 0 ? "" : whole.slice(nextBreak + 1).split("\n")[0];
  const lineStart = whole.lastIndexOf("\n", offset - 1);
  const prevLine = lineStart > 0 ? whole.slice(whole.lastIndexOf("\n", lineStart - 1) + 1, lineStart) : "";
  return ACTIVITY_FIELD.test(nextLine) || /^[ \t]*(?:activit(?:y|ies)\b|ec\b|\d+[.)])/i.test(prevLine);
}
const notAPersonField = (prefix) => (match, offset, whole) => notAName(prefix)(match) || inActivityBlock(match, offset, whole);

// Labels that take a name: "Name:", "Student:", "Preferred:", "Mother:",
// "Parent/Guardian:", "Parent 1:", "Applicant Name:", "Surname:",
// "Parents' Names:". "First:", "Family:" and "Last:" take a name only with
// "Name" after them. A format hint may sit before the colon: "Name (Last,
// First, M.I.):".
const LABEL_HINT = String.raw`(?:[ \t]*\([^)\n]{1,24}\))?`;
const PARENT_WORD = String.raw`${anyCase("parent")}(?:[sS]|\([sS]\))?(?:['’][sS]?)?(?:[ \t]*\d)?(?:[ \t]*(?:\/|${anyCase("or")})[ \t]*${anyCase("guardian")}(?:[sS]|\([sS]\))?)?`;
const NAME_WORD_LABEL = String.raw`${anyCase("name")}(?:[sS])?`;
const NAME_LABEL = String.raw`(?:(?:${anyOf("student", "preferred", "mother", "father", "guardian", "surname", "applicant", "candidate")}(?:['’][sS])?(?:[ \t]+${NAME_WORD_LABEL})?`
  + String.raw`|${anyOf("full", "legal", "first", "last", "given", "family", "middle", "english", "korean", "chinese", "native")}[ \t]+${NAME_WORD_LABEL}`
  + String.raw`|${PARENT_WORD}(?:[ \t]+${NAME_WORD_LABEL})?`
  + String.raw`|${NAME_WORD_LABEL}(?:[ \t]+${anyCase("of")}[ \t]+(?:${anyOf("student", "guardian")}|${PARENT_WORD}))?|${anyCase("emergency contact")}(?:[ \t]+${NAME_WORD_LABEL})?)${LABEL_HINT})`;
const QUALIFIED_NAME_LABEL = String.raw`(?:${anyOf("student", "full", "legal", "preferred", "first", "last", "given", "family", "middle", "mother", "father", "guardian", "applicant", "candidate", "english", "korean", "chinese", "native")}|${PARENT_WORD})(?:['’][sS])?[ \t]+${NAME_WORD_LABEL}`;
// School staff, with the modifiers a school title takes: "University
// Counsellor", "IB Diploma Programme Coordinator", "College & Career
// Counselor", "Director of College Counseling", "Head of Upper School".
const STAFF_TITLE = anyOf("counselor", "counsellor", "principal", "vice principal", "headmaster", "headmistress", "head of school",
  "head teacher", "head", "registrar", "coordinator", "director", "advisor", "adviser", "teacher", "dean");
const STAFF_MODIFIER = anyOf("college", "guidance", "school", "university", "academic", "assistant", "associate", "upper", "lower",
  "middle", "senior", "ib", "dp", "diploma", "programme", "program", "career", "careers", "international", "admissions",
  "homeroom", "vice", "deputy", "lead", "chief", "high", "&", "and", "english", "math", "science", "history");
const STAFF_OF = String.raw`(?:[ \t]+${anyCase("of")}(?:[ \t]+[A-Za-z&]+){1,4})?`;
const STAFF_LABEL = String.raw`(?:${STAFF_MODIFIER}[ \t]+){0,4}${STAFF_TITLE}${STAFF_OF}(?:['’][sS])?(?:[ \t]+${anyOf("name", "signature")})?${LABEL_HINT}`;
const SIGNED_BY = String.raw`${anyOf("authorized", "authorised", "signed", "certified", "issued", "attested", "approved", "prepared", "verified", "reviewed")}[ \t]+${anyCase("by")}`;
// A signature block's title line: the whole line is the title, with an
// optional ", School Name" or "| School Name" after it.
const TITLE_LINE = String.raw`(?:${STAFF_MODIFIER}[ \t]+){0,4}${STAFF_TITLE}(?:[ \t]+${anyCase("of")}(?:[ \t]+[A-Z][A-Za-z&]*){1,4})?(?:[ \t]*[,|][^\n]{1,60})?[ \t]*\r?$`;

// 성명, 보호자, 담임, 교장, 학생 이름: with a colon at a field's start, or the
// form field with the name and nothing after it. 이름 alone heads a club
// or a project as often as a person ("이름: 방송부"). A sub-label may sit in
// between ("성명(한글): 박민지", "성명  한글  김민지  영문  KIM MINJI").
const KO_LABEL_HINT = String.raw`(?:[ \t]*\([가-힣A-Za-z .]{1,12}\))?`;
const KO_NAME_LABEL = String.raw`(?:성[ \t]*명|학생[ \t]*(?:성명|이름)|보호자(?:[ \t]*(?:성명|이름))?|담임(?:[ \t]*(?:교사|성명))?|교[ \t]*장|[부모][ \t]*성명)${KO_LABEL_HINT}`;
const KO_NAME_FIELD = String.raw`(?:성[ \t]*명|학생[ \t]*성명|보호자[ \t]*성명)${KO_LABEL_HINT}(?:[ \t]+(?:한글|국문))?`;
const KO_NAME_END = String.raw`(?=[ \t]*(?:\r?$|[(,;|])|[ \t]{2,}|\t)`;
// A seal after a signer: "(인)", "[직인]".
const KO_SEAL = String.raw`[ \t]*(?:[[(]직?인[)\]]|직인|인(?![가-힣]))`;

// ─── Dates of birth ───
// A month by its name or abbreviation: "juniors" and "decisions" are not
// June and December.
const MONTH = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?(?![a-z])`;
// A number token is the whole number: "2009" is one token, not "200" and "9".
const DATE_TOKEN = String.raw`(?:${MONTH}|\d{1,4}(?!\d)(?:[ \t]*[년월일])?)`;
const DATE_VALUE = String.raw`(?:\d{8}\b|${DATE_TOKEN}(?:[ \t]*[\/.,-]?[ \t]*${DATE_TOKEN}){1,2}\.?)`;
// "DOB", "D.O.B.", "D. O. B.", "Date and Place of Birth", "DOB/Sex",
// "Date of Birth / Age"; "Do B students" is not one.
const DOB_LABEL = String.raw`(?:date[ \t]+(?:and|&)[ \t]+place[ \t]+of[ \t]+birth|date[ \t]+of[ \t]+birth|birth[ \t]*date|birthdate|birthday|d(?:\.[ \t]?)?o(?:\.[ \t]?)?b\.?)(?![A-Za-z])(?:[ \t]*\/[ \t]*[A-Za-z]+)?(?:[ \t]*\([^)\n]{1,12}\))?`;
// A colon may end its line, with the date on the next one ("Date of
// Birth:\nMar/04/2008"); the date itself stays on that line.
const DOB_SEPARATOR = String.raw`(?:[ \t]*[:：](?:[ \t]*\r?\n)?|[ \t]+is)?[ \t]*`;
const DOB_PREFIX = new RegExp(String.raw`^${DOB_LABEL}${DOB_SEPARATOR}`, "i");
const KO_DOB_LABEL = String.raw`생[ \t]*년[ \t]*월[ \t]*일`;
const KO_DOB_PREFIX = new RegExp(String.raw`^${KO_DOB_LABEL}[ \t]*(?:[:：](?:[ \t]*\r?\n)?)?[ \t]*`);
// A date names a month, a four-digit year, 년, or three numbers: "3.86"
// under an empty "Date of Birth:" is a GPA.
function notADate(prefix) {
  return (match) => {
    const value = match.replace(prefix, "");
    if (!/\d/.test(value)) return true;
    return !(/[A-Za-z]{3}/.test(value) || /\d{4}|년/.test(value) || (value.match(/\d+/g) || []).length >= 3);
  };
}

// ─── ID numbers ───
// "Course ID: 1220", "Meeting ID: 845 2231 0098" and "CEEB Code" are not
// the student's.
const NOT_A_STUDENT_ID = String.raw`(?<!\b${anyOf("course", "class", "section", "exam", "test", "school", "college", "unit", "program", "activity", "club", "team", "ceeb", "app", "room", "order", "ticket", "meeting", "zoom", "webinar", "session", "event", "tracking", "confirmation")}[ \t]*)`;
const ID_WORDS = String.raw`(?:${anyCase("student")}[ \t]*)?${anyOf("id", "identification", "i.d.", "i. d.")}(?:[ \t]*${anyOf("number", "num", "no.", "no", "#")})?`;
const FIELD_ID_PREFIX = /^[^\n]*?(?:\bis\b|[:：=#])[ \t]*/i;
const KO_ID_LABEL = String.raw`(?:학[ \t]*번|학생[ \t]*번호|수험[ \t]*번호)`;

// ─── Phones ───
// A phone number has at least eight digits, a labeled one seven: "+1.0
// weighted" and "+0.5 for honors" have the start of an international one.
const tooFewDigits = (min) => (match) => (match.replace(FIELD_LABEL_PREFIX, "").match(/\d/g) || []).length < min;
const PHONE_LABEL = String.raw`(?:\b${anyOf("phone", "tel", "telephone", "mobile", "cell", "fax", "home phone", "cell phone")}(?:[ \t]+${anyOf("number", "no.")})?|전화[ \t]*(?:번호)?|연락처|휴대[ \t]*(?:폰|전화)(?:[ \t]*번호)?)`;

// ─── Addresses ───
// An address stops before the next label or label word ("Grade 11",
// "SAT Total: 1480", "Weighted GPA 4.21") and after a ZIP code.
const ADDRESS_VALUE = String.raw`\S+(?:(?<!\b\d{5}(?:-\d{4})?)[ ](?!${NEXT_LABEL}|${LABEL_WORD}(?![A-Za-z]))\S+){0,11}`;
const KO_PROVINCE = String.raw`(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|충청북|충청남|전북|전남|전라북|전라남|경북|경남|경상북|경상남|제주)(?:특별시|광역시|특별자치시|특별자치도|도|시)?`;
// A district: a city or county of two syllables or more, or a 구 that is
// not a word ("탐구", "축구", "연구"). "가군" (a 정시 group), "수시" and
// "혹시" are not districts.
const KO_NOT_GU = String.raw`(?![가-힣]*(?:탐구|연구|친구|축구|야구|농구|배구|입구|출구|요구|도구|가구|기구|구구)(?![가-힣]))`;
const KO_DISTRICT = String.raw`(?:[가-힣]{2,}(?:시|군)|${KO_NOT_GU}[가-힣]+구)`;
// A 동 or 리 with a lot number, never a subject ("물리 2", "윤리 2",
// "활동 3").
const KO_NOT_DONG = String.raw`(?![가-힣]*(?:물리|지리|윤리|심리|논리|원리|관리|처리|정리|수리|총리|활동|운동|행동|감동|이동|자동|공동|변동|노동|충동)(?![가-힣]))`;
const KO_LOT = String.raw`${KO_NOT_DONG}[가-힣]+(?:동|읍|면|리)`;
// A building, an apartment and a unit after the number: "래미안아파트
// 101동 1203호".
const KO_UNIT = String.raw`(?:[ ][가-힣A-Za-z0-9]*(?:아파트|빌라|오피스텔|타워|맨션|빌딩))?(?:[ ]\d+동)?(?:[ ]\d+호)?`;
// A Korean address: an optional province, a district, more districts, then
// a road (not a noun with 으로) or a 동 with a building or lot number.
const KO_ADDRESS = String.raw`(?:${KO_PROVINCE} )?${KO_DISTRICT}(?: [가-힣]+(?:구|읍|면|동))* (?:[가-힣0-9]+(?<!으)(?:로|길)(?: ?\d+(?:번)?길)?|${KO_LOT}) ?\d+(?:-\d+)?(?:번지)?(?![가-힣.\d])(?: ?\([^)\n]{1,20}\))?${KO_UNIT}`;
// One 시/구/면 ending is not an address: everyday words end in them (이면,
// 수시, 축구, 혹시 진로). A province with a district, a road with a number,
// or a lot number is.
const KO_ADDRESS_SHAPE = new RegExp([
  String.raw`(?<![가-힣])${KO_PROVINCE} ${KO_DISTRICT}(?![가-힣])`,
  String.raw`[가-힣0-9]+(?<!으)(?:로|길) ?\d+(?![가-힣.\d])`,
  String.raw`${KO_LOT} ?\d+(?:-\d+)?(?:번지)?(?![가-힣.\d])`,
].join("|"));
// An address starts with a house number before a street word, or is a
// Korean address: "Texas, but I live in Seoul" and "3 blocks from school"
// are not addresses.
function notAnAddress(prefix) {
  return (match) => {
    const value = match.replace(prefix, "").trim();
    if (!value || MASKED_TOKEN.test(value)) return true;
    return !(/^\[[A-Z_]+_\d{2}\]/.test(value)
      || /^\d{1,6}[A-Za-z]?(?:-\d+)?,?[ ][A-Z0-9]/.test(value)
      || /\bP\.?\s?O\.?\s?Box\b/i.test(value)
      || KO_ADDRESS_SHAPE.test(value));
  };
}
// A course row, a teacher or a placement, not an address: "1 AP Calculus
// BC Dr. Nguyen", "Religious St. B+ 0.5", "2 First Place".
const COURSE_MARKER = new RegExp(String.raw`\b(?:${COURSE_WORDS})\b`);
function isCourseRowNotAddress(match, offset, whole) {
  if (COURSE_MARKER.test(match)) return true;
  if (/^\d{1,3} (?:First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth|Honorable)\b/.test(match)) return true;
  return /\bDr\.?$/.test(match) && /^ [A-Z]/.test(whole.slice(offset + match.length, offset + match.length + 2));
}

const IDENTITY_FIELD_PATTERNS = [
  // Korean resident registration number (주민등록번호), with or without the
  // back half starred out: the front half is the date of birth.
  { pattern: /\b\d{6} ?- ?(?:[1-8](?:\d{6}\b|\*{6})|\*{7})/g, type: "national_id", label: "NATIONAL_ID", restorable: false },
  // International numbers: "+82 2-555-0100", "(+82) 02-555-0100", "+1 (555) 123-4567".
  // One separator between groups, so a column gap or a line break ends it.
  { pattern: /(?:\([ \t]*)?\+\d{1,3}(?:[ \t]*\))?[ .-]?(?:\(\d{1,4}\)[ .-]?)?\d{1,4}(?:[ .-]\d{2,4}){1,3}\b/g, type: "phone", label: "PHONE", restorable: false, keep: tooFewDigits(8) },
  // Korean domestic numbers: "02-555-0100", "010-1234-5678", "031) 123-4567".
  // Only real area and mobile codes, and never a school-year range:
  // "Grade: 09 2023-2024" and "Term 01 2025-2026" are not phones.
  { pattern: /\b0(?:2|3[1-3]|4[1-4]|5[1-5]|6[1-4]|1[016-9]|70|50\d)(?:\) ?|[-. ])(?!(?:19|20)\d{2}[-–](?:19|20)\d{2}\b)\d{3,4}[-. ]\d{4}\b/g, type: "phone", label: "PHONE", restorable: false },
  // "(555) 867-5309", the way a US school header prints its number.
  { pattern: /\(\d{3}\) ?\d{3}[-. ]\d{4}\b/g, type: "phone", label: "PHONE", restorable: false },
];

// After the plain US number, so "Tel: (217) 555-0142 2025-2026" is masked
// before a label could take the year range with it.
const LABELED_PHONE_PATTERNS = [
  { pattern: new RegExp(String.raw`${PHONE_LABEL}[ \t]*[:：][ \t]*[(+]{0,2}\d[\d().-]*(?: (?!\d{4}-\d{4})[(+]{0,2}\d[\d().-]*){0,3}`, "g"), type: "phone", label: "PHONE", restorable: false, trimPrefix: FIELD_LABEL_PREFIX, keep: tooFewDigits(7) },
];

const IDENTITY_ADDRESS_PATTERNS = [
  // Romanized Korean road addresses: "12 Banpo-daero 3-gil, Seocho-gu",
  // "Teheran-ro 123". The hyphen is required: "AP Euro 5" is a score. A
  // road followed by its own number is the second form, so "Class of 2026
  // Banpo-daero 58" keeps the class year.
  { pattern: /\b\d{1,4}(?:-\d{1,4})?,? [A-Z][a-z]+(?:[ -]?\d{1,3})?-(?:gil|ro|daero)\b(?: \d{1,3}(?:beon)?-gil\b)?(?! \d)(?:,? [A-Z][a-z]+-(?:gu|si|gun|dong|eup|myeon|do)\b)*/g, type: "street_address", label: "STREET_ADDRESS", restorable: false },
  { pattern: /\b[A-Z][a-z]+(?:[ -]?\d{1,3})?-(?:gil|ro|daero)(?: \d{1,3}(?:beon)?-gil)? \d{1,4}(?:-\d{1,4})?\b(?!-(?:gil|ro|daero|beon))(?:,? [A-Z][a-z]+-(?:gu|si|gun|dong|eup|myeon|do)\b)*/g, type: "street_address", label: "STREET_ADDRESS", restorable: false },
  // 서울특별시 서초구 반포대로 12 래미안아파트 101동 1203호, 서울시 강남구 역삼동
  // 123-45, with no label: the province, a district, a road or a 동 and its
  // number, and any building and unit.
  { pattern: new RegExp(String.raw`(?<![가-힣\d])${KO_PROVINCE} ${KO_DISTRICT}(?: [가-힣]+(?:구|읍|면))? (?:[가-힣0-9]+(?<!으)(?:로|길)(?: ?\d+(?:번)?길)?|${KO_LOT}) ?\d+(?:-\d+)?(?:번지)?(?=[ \t]*(?:$|[,)(\r\n])|번지|[ ][가-힣A-Za-z0-9]*(?:아파트|빌라|오피스텔|타워|맨션|빌딩)|[ ]\d+동|[ ]?(?:에|에서|에요|이에요|예요|입니다|살아요|거주)(?![가-힣]))${KO_UNIT}`, "gm"), type: "street_address", label: "STREET_ADDRESS", restorable: false },
  { pattern: new RegExp(String.raw`\b${anyOf("home", "mailing", "street", "permanent", "residential", "current", "student", "student's", "school")}[ \t]+${anyCase("address")}[ \t]*[:：][ \t]*${ADDRESS_VALUE}`, "g"), type: "street_address", label: "STREET_ADDRESS", restorable: false, trimPrefix: FIELD_LABEL_PREFIX, keep: notAnAddress(FIELD_LABEL_PREFIX) },
  { pattern: new RegExp(String.raw`${FIELD_START}${anyCase("address")}[ \t]*[:：][ \t]*${ADDRESS_VALUE}`, "gm"), type: "street_address", label: "STREET_ADDRESS", restorable: false, trimPrefix: FIELD_LABEL_PREFIX, keep: notAnAddress(FIELD_LABEL_PREFIX) },
  // 주소: the Korean address itself, not the sentence after it ("기숙사
  // 주소: 경기도 수원시 영통구 월드컵로 206 이렇게 써요?").
  { pattern: new RegExp(String.raw`(?:현|자택|실거주지|거주지|본적|기숙사[ \t]*)?주[ \t]*소[ \t]*[:：][ \t]*${KO_ADDRESS}`, "g"), type: "street_address", label: "STREET_ADDRESS", restorable: false, trimPrefix: FIELD_LABEL_PREFIX },
];

const IDENTITY_NUMBER_PATTERNS = [
  // "Student ID Number: 48213", "Student I.D.: 204871", "my student id is 48213".
  { pattern: new RegExp(String.raw`${NOT_A_STUDENT_ID}\b${ID_WORDS}[ \t]*(?:${anyCase("is")}|[:：=#])[ \t]*[A-Z]{0,4}-?\d{3,}[A-Z0-9-]*\b`, "g"), type: "student_id", label: "STUDENT_ID", restorable: false, trimPrefix: FIELD_ID_PREFIX },
  // "Student ID:" with the number on the next line, as pdf.js reads a table.
  { pattern: new RegExp(String.raw`${FIELD_START}${ID_WORDS}[ \t]*[:：][ \t]*\r?\n[ \t]*[A-Z]{0,4}-?\d{4,}[A-Z0-9-]*(?=[ \t]*\r?$)`, "gm"), type: "student_id", label: "STUDENT_ID", restorable: false, trimPrefix: FIELD_NEXT_LINE_PREFIX },
  // "Student ID 204871" in a header column, with no colon.
  { pattern: new RegExp(String.raw`\b${anyCase("student")}[ \t]+${anyCase("id")}(?:[ \t]*${anyOf("number", "no.", "#")})?[ \t]+[A-Z]{0,4}-?\d{4,}[A-Z0-9-]*\b`, "g"), type: "student_id", label: "STUDENT_ID", restorable: false, trimPrefix: /^[^\d]*?(?=[A-Z]{0,4}-?\d{4,})/ },
  // State, district and admission numbers: "SASID: 10483726", "Perm #:
  // 204871", "Admission No.: 20230512".
  { pattern: new RegExp(String.raw`\b(?:${anyOf("sasid", "ssid", "osis", "oen", "nsn")}|${anyOf("state", "local")}[ \t]+(?:${anyCase("student")}[ \t]+)?${anyCase("id")}|${anyCase("perm")}(?:${anyCase("anent")})?[ \t]*(?:#|${anyOf("id", "number", "no.")})|${anyOf("admission", "admissions", "enrollment", "enrolment")}[ \t]*(?:#|${anyOf("number", "no.", "no")}))[ \t]*[:#：]?[ \t]*[A-Z]{0,4}-?\d{4,}[A-Z0-9-]*\b`, "g"), type: "student_id", label: "STUDENT_ID", restorable: false, trimPrefix: /^[^\n]*?(?=[A-Z]{0,4}-?\d{4,})/ },
  { pattern: /\bstudent[ \t]*(?:number|num|no\.?|#)[ \t]*(?:is|:|：|=)?[ \t]*[A-Z]{0,4}-?\d{3,}[A-Z0-9-]*\b/gi, type: "student_id", label: "STUDENT_ID", restorable: false, trimPrefix: /^student[ \t]*(?:number|num|no\.?|#)[ \t]*(?:is|:|：|=)?[ \t]*/i },
  // 학번: 20231234 anywhere, the number alone ("학번: 2023학번이면" is a
  // cohort); without the colon only as a form field.
  { pattern: new RegExp(String.raw`${KO_ID_LABEL}[ \t]*[:：][ \t]*[A-Z0-9-]*\d{3,}[A-Z0-9-]*(?![가-힣\d])`, "g"), type: "student_id", label: "STUDENT_ID", restorable: false, trimPrefix: FIELD_LABEL_PREFIX },
  { pattern: new RegExp(String.raw`${FIELD_START}${KO_ID_LABEL}[ \t]+[A-Z0-9-]*\d{3,}[A-Z0-9-]*${FIELD_END}`, "gm"), type: "student_id", label: "STUDENT_ID", restorable: false, trimPrefix: new RegExp(String.raw`^[ \t]*${KO_ID_LABEL}[ \t]+`) },
  // "Date of Birth: Mar/04/2008", "Date of Birth (MM/DD/YYYY): 03/04/2008",
  // "DOB 2008-03-04", "생 년 월 일 : 2008. 03. 04.".
  { pattern: new RegExp(String.raw`\b${DOB_LABEL}${DOB_SEPARATOR}${DATE_VALUE}`, "gi"), type: "date_of_birth", label: "DATE_OF_BIRTH", restorable: false, trimPrefix: DOB_PREFIX, keep: notADate(DOB_PREFIX) },
  { pattern: new RegExp(String.raw`${KO_DOB_LABEL}[ \t]*(?:[:：](?:[ \t]*\r?\n)?)?[ \t]*${DATE_VALUE}`, "gi"), type: "date_of_birth", label: "DATE_OF_BIRTH", restorable: false, trimPrefix: KO_DOB_PREFIX, keep: notADate(KO_DOB_PREFIX) },
];

const IDENTITY_NAME_PATTERNS = [
  // "Student Name: …", "Legal name: …", "Parent/Guardian Name: …" anywhere.
  { pattern: new RegExp(String.raw`\b${QUALIFIED_NAME_LABEL}${LABEL_HINT}[ \t]*[:：][ \t]*${NAME_VALUE}`, "gm"), type: "person_name", label: "PERSON_NAME", restorable: true, trimPrefix: FIELD_LABEL_PREFIX, keep: notAPersonField(FIELD_LABEL_PREFIX) },
  // "Name:", "Student:", "Mother:", "Parent/Guardian:" at a field's start,
  // with the name on the label's line or alone on the next one.
  { pattern: new RegExp(String.raw`${FIELD_START}${NAME_LABEL}[ \t]*[:：][ \t]*${NAME_VALUE}`, "gm"), type: "person_name", label: "PERSON_NAME", restorable: true, trimPrefix: FIELD_LABEL_PREFIX, keep: notAPersonField(FIELD_LABEL_PREFIX) },
  { pattern: new RegExp(String.raw`${FIELD_START}${NAME_LABEL}[ \t]*[:：][ \t]*\r?\n[ \t]*${NAME_VALUE}`, "gm"), type: "person_name", label: "PERSON_NAME", restorable: true, trimPrefix: FIELD_NEXT_LINE_PREFIX, keep: notAPersonField(FIELD_NEXT_LINE_PREFIX) },
  // The adults who sign or stand behind the document: "Counselor:",
  // "University Counsellor:", "IB Diploma Programme Coordinator:",
  // "Counselor's Signature:", "Authorized by:".
  { pattern: new RegExp(String.raw`${FIELD_START}${STAFF_LABEL}[ \t]*[:：][ \t]*${NAME_VALUE}`, "gm"), type: "person_name", label: "PERSON_NAME", restorable: true, trimPrefix: FIELD_LABEL_PREFIX, keep: notAName(FIELD_LABEL_PREFIX) },
  { pattern: new RegExp(String.raw`${FIELD_START}${STAFF_LABEL}[ \t]*[:：][ \t]*\r?\n[ \t]*${NAME_VALUE}`, "gm"), type: "person_name", label: "PERSON_NAME", restorable: true, trimPrefix: FIELD_NEXT_LINE_PREFIX, keep: notAName(FIELD_NEXT_LINE_PREFIX) },
  { pattern: new RegExp(String.raw`\b${SIGNED_BY}[ \t]*[:：][ \t]*${NAME_VALUE}`, "gm"), type: "person_name", label: "PERSON_NAME", restorable: true, trimPrefix: FIELD_LABEL_PREFIX, keep: notAName(FIELD_LABEL_PREFIX) },
  // A signature block: a name of two words or more alone on its line, a
  // school title alone on the next one.
  { pattern: new RegExp(String.raw`^[ \t]*${NAME_WORD}(?:${NAME_JOIN}${NAME_WORD}){1,4}${CREDENTIAL}(?=[ \t]*\r?\n[ \t]*${TITLE_LINE})`, "gm"), type: "person_name", label: "PERSON_NAME", restorable: true, trimPrefix: /^[ \t]*/, keep: notAName(/^[ \t]*/) },
  { pattern: new RegExp(String.raw`${FIELD_START}${KO_NAME_LABEL}[ \t]*[:：][ \t]*[가-힣]{2,4}${KO_NAME_END}`, "gm"), type: "person_name", label: "PERSON_NAME", restorable: true, trimPrefix: FIELD_LABEL_PREFIX, keep: notKoreanName(FIELD_LABEL_PREFIX) },
  { pattern: new RegExp(String.raw`${FIELD_START}${KO_NAME_FIELD}[ \t]+[가-힣]{2,4}${KO_NAME_END}`, "gm"), type: "person_name", label: "PERSON_NAME", restorable: true, trimPrefix: new RegExp(String.raw`^[ \t]*${KO_NAME_FIELD}[ \t]+`), keep: notKoreanName(new RegExp(String.raw`^[ \t]*${KO_NAME_FIELD}[ \t]+`)) },
  // The romanized name beside it: "성명(영문): PARK MINJI", "영문  KIM MINJI".
  { pattern: new RegExp(String.raw`${FIELD_START}(?:${KO_NAME_FIELD}[ \t]*\((?:영문|English)\)|(?:성[ \t]*명[ \t]+)?영문(?:[ \t]*(?:성명|이름))?)[ \t]*[:：]?[ \t]*${LATIN_NAME}${NAME_END}`, "gm"), type: "person_name", label: "PERSON_NAME", restorable: true, trimPrefix: /^(?:[^:：\n]*[:：][ \t]*|[^A-Za-z]*)/, keep: notAName(/^(?:[^:：\n]*[:：][ \t]*|[^A-Za-z]*)/) },
  // The signer: "한빛고등학교장  김철수  [직인]", "담임 이수정 (인)". "학교장
  // 추천", "학교장 확인서", "학교장 귀하" and "교장 선생님" are not names.
  { pattern: new RegExp(String.raw`(?:학교장|교장)(?:[ \t]{2,}|\t)[가-힣]{2,4}(?![가-힣])(?=[ \t]{2,}|\t|${KO_SEAL}|[ \t]*\r?$)`, "gm"), type: "person_name", label: "PERSON_NAME", restorable: true, trimPrefix: /^(?:학교장|교장)[ \t]+/, keep: notKoreanName(/^(?:학교장|교장)[ \t]+/) },
  { pattern: new RegExp(String.raw`(?:학교장|교장|담임(?:[ \t]*교사)?)[ \t]+[가-힣]{2,4}(?![가-힣])(?=${KO_SEAL})`, "g"), type: "person_name", label: "PERSON_NAME", restorable: true, trimPrefix: /^(?:학교장|교장|담임(?:[ \t]*교사)?)[ \t]+/, keep: notKoreanName(/^(?:학교장|교장|담임(?:[ \t]*교사)?)[ \t]+/) },
];

// ─── The student's own registered name ───
// The patterns find a name only by its shape or its label. The server holds
// the name the student registered with, and a document prints it in any
// form: "MINJI PARK" as a heading, "Park, Minji" in a roster, "Minji G.
// Park" or "Minji (Grace) Park", "PARK MIN JI" or "Min-ji" romanized
// another way, "GARCIA LOPEZ, MARIA" without its accents. The whole name is
// masked in any order of its parts, with a comma only after the family
// name, a middle name, and a hyphen or a space inside a romanized part.
// Each part starts with a capital ("let's go to the park, Minji" is a
// sentence), one part alone ("Park", "Grace") is too often an ordinary
// word, and a title before the family name is someone else ("Ms. Park,
// Minji here"). A Hangul name of three syllables or more ("김민지", "박
// 민지") is masked as written.
function escapeForRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// One letter in either case (or as a capital), with and without its
// accent: "María" also reads "MARIA".
function nameLetter(ch, { capital = false } = {}) {
  if (ch === "'" || ch === "’") return "['’]";
  if (!/\p{L}/u.test(ch)) return escapeForRegExp(ch);
  const base = ch.normalize("NFD").replace(/\p{M}/gu, "");
  const forms = capital
    ? [ch.toUpperCase(), base.toUpperCase()]
    : [ch.toLowerCase(), ch.toUpperCase(), base.toLowerCase(), base.toUpperCase()];
  return `[${[...new Set(forms)].map(escapeForRegExp).join("")}]`;
}

// A part: a capital first ("Minji"), the rest in either case, a hyphen or
// a space before a capital allowed inside ("Min-ji", "MIN JI").
function namePart(part, { capital = true } = {}) {
  const chars = [...part];
  return [nameLetter(chars[0], { capital }), ...chars.slice(1).map((ch) => nameLetter(ch))].join(String.raw`(?:-|[ ](?=\p{Lu}))?`);
}

// The parts in this order: separated by a space (or, in a reversed order,
// a comma after the family name: "García López, María"), or joined
// ("Min" + "ji").
function nameRun(parts, { comma = false } = {}) {
  const separator = comma ? String.raw`(?:,[ \t]*|[ \t]+)` : String.raw`[ \t]+`;
  return parts.map((part, i) => (i === 0
    ? namePart(part)
    : `(?:${separator}${namePart(part)}|-?${namePart(part, { capital: false })})`)).join("");
}

// A pattern is built from the name on every chat turn, so the name is
// bounded twice: registration refuses a longer one (routes/students.js),
// and a stored name over the bound, or with more parts than a name has, is
// not made into a pattern at all. An unbounded registered name of about a
// megabyte held the one server process for seconds per turn (PR #7 review).
export const MAX_REGISTERED_NAME_CHARS = 100;
const MAX_REGISTERED_NAME_PARTS = 6;
const NO_TITLE_BEFORE = String.raw`(?<!(?:Mrs?|Ms|Mx|Dr|Prof)\.?[ \t])`;

function knownNameRules(names) {
  const rules = [];
  const seen = new Set();
  for (const raw of Array.isArray(names) ? names.slice(0, 4) : []) {
    const text = String(raw || "").normalize("NFKC").trim();
    if (!text || text.length > MAX_REGISTERED_NAME_CHARS) continue;
    // "Min-ji" registers the hyphen as optional.
    const parts = text.split(/[\s,]+/).map((part) => part.replace(/-/g, "")).filter((part) => /\p{L}/u.test(part));
    if (parts.length > MAX_REGISTERED_NAME_PARTS) continue;
    let alternatives = [];
    if (parts.length === 1 && /^\p{Script=Hangul}{3,}$/u.test(parts[0])) {
      alternatives = [[...parts[0]].join(String.raw`[ \t]?`)];
    } else if (parts.length >= 2 && parts.every((part) => !/\p{Script=Hangul}/u.test(part))) {
      // Every rotation of the parts.
      for (let shift = 0; shift < parts.length; shift += 1) {
        const order = [...parts.slice(shift), ...parts.slice(0, shift)];
        alternatives.push(`${shift > 0 ? NO_TITLE_BEFORE : ""}${nameRun(order, { comma: shift > 0 })}`);
      }
      // The first given name and the family name, with any middle name or
      // initial between them, or none: "Minji G. Park", "Minji (Grace)
      // Park", "Minji Park" for "Minji Grace Park". Not for a name with a
      // romanized syllable ("Park Min Ji"): "Park Ji" would be someone else.
      if (parts.length === 2 || parts.every((part) => part.length >= 3)) {
        const middle = String.raw`(?:[ \t]+(?:\p{Lu}[\p{L}'’-]*\.?|\(\p{Lu}[\p{L}'’-]*\)))?`;
        alternatives.push(String.raw`${namePart(parts[0])}${middle}[ \t]+${namePart(parts.at(-1))}`);
      }
    }
    const key = alternatives.join("|");
    if (!alternatives.length || seen.has(key)) continue;
    seen.add(key);
    rules.push({
      pattern: new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${alternatives.join("|")})(?![\p{L}\p{N}])`, "gmu"),
      type: "student_name_known",
      label: "STUDENT_NAME",
      restorable: true,
    });
  }
  return rules;
}

const STREET_SUFFIX = String.raw`(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Lane|Ln\.?|Drive|Dr\.?|Court|Ct\.?|Parkway|Pkwy\.?|Highway|Hwy\.?)`;
// Words that are also common nouns ("2 First Place awards", "8 Story
// Circle nights") end an address only where an address ends: a comma, the
// line, a unit, or a column gap.
const STREET_SUFFIX_NOUN = String.raw`(?:Way|Circle|Cir\.?|Place|Pl\.?|Terrace|Ter\.?|Trail|Trl\.?|Square|Sq\.?|Plaza|Loop)`;
const ADDRESS_TAIL = String.raw`(?=,|[ \t]*\r?$|[ \t]+(?:Apt|Suite|Unit|#)\b|[ \t]{2,}|\t)`;
const streetKeep = (match, offset, whole) => isEventNotAddress(match, offset, whole) || isCourseRowNotAddress(match, offset, whole);

const PROVIDER_REDACTION_PATTERNS = [
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, type: "email", label: "STUDENT_EMAIL", restorable: true },
  ...IDENTITY_FIELD_PATTERNS,
  { pattern: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, type: "phone", label: "PHONE", restorable: false },
  ...LABELED_PHONE_PATTERNS,
  // Deliberately broader than the input screen's SSN shape: a bare
  // nine-digit run no longer blocks a question, so it is masked here
  // instead. The same separator in both places: "780 99 2025" in a score
  // table and "412 12 2026" under "Class Size Rank Year" are not SSNs; a
  // spaced one counts after its label.
  { pattern: /\b\d{3}(-?)\d{2}\1\d{4}\b/g, type: "ssn", label: "SSN", restorable: false },
  { pattern: new RegExp(String.raw`\b(?:${anyCase("ssn")}|${anyCase("social security")}(?:[ \t]+${anyOf("number", "no.")})?)[ \t#:：]*\d{3}[- ]?\d{2}[- ]?\d{4}\b`, "g"), type: "ssn", label: "SSN", restorable: false, trimPrefix: /^[^\d]*/ },
  { pattern: MONEY_AMOUNT, type: "financial", label: "ANNUAL_INCOME", restorable: false, rewrite: achievementAmountAsUsd },
  // One line, single spaces: "7\nSpringfield Avenue" used to take the 7.
  { pattern: new RegExp(String.raw`\b\d{1,6} [A-Z][A-Za-z0-9.'-]*(?: [A-Z][A-Za-z0-9.'-]*){0,4} ${STREET_SUFFIX}\b`, "g"), type: "street_address", label: "STREET_ADDRESS", restorable: false, keep: streetKeep },
  { pattern: new RegExp(String.raw`\b\d{1,6} [A-Z][A-Za-z0-9.'-]*(?: [A-Z][A-Za-z0-9.'-]*){0,4} ${STREET_SUFFIX_NOUN}\b${ADDRESS_TAIL}`, "gm"), type: "street_address", label: "STREET_ADDRESS", restorable: false, keep: streetKeep },
  ...IDENTITY_ADDRESS_PATTERNS,
  { pattern: new RegExp(String.raw`${NOT_A_STUDENT_ID}\b(?:${anyCase("student")}[ \t]*${anyCase("id")}|${anyCase("id")})[ \t]*(?:${anyCase("is")}|[:=])?[ \t]*[A-Z]-?\d{3,}\b`, "g"), type: "student_id", label: "STUDENT_ID", restorable: false },
  // Numbers and dates before names: a header line can carry the ID after
  // the name.
  ...IDENTITY_NUMBER_PATTERNS,
  ...IDENTITY_NAME_PATTERNS,
  { pattern: /\b[A-Z][a-z]+ [A-Z][a-z]+[ \t]+from\b/g, type: "student_name_context", label: "STUDENT_NAME", restorable: true, trimSuffix: /[ \t]+from$/i, keep: isCommonNounPair },
  { pattern: /\bfrom[ \t]+[A-Z][A-Za-z0-9.'-]*(?:[ \t]+[A-Z][A-Za-z0-9.'-]*){0,3}[ \t]+(?:High|School|Academy|Preparatory|Prep)\b/g, type: "school_context", label: "CURRENT_SCHOOL", restorable: true, trimPrefix: /^from[ \t]+/i },
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

function makeProviderRedactionState(options = {}) {
  return {
    rules: options.knownNames?.length
      ? [...knownNameRules(options.knownNames), ...PROVIDER_REDACTION_PATTERNS]
      : PROVIDER_REDACTION_PATTERNS,
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
  for (const rule of state.rules) {
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
// /api/chat builds outside the payload-redaction boundary. `knownNames` is
// the student's own registered name, masked wherever it appears.
export function redactProviderText(value, options = {}) {
  if (typeof value !== "string" || value.length === 0) {
    return { text: value || "", tokenMap: {}, applied: false, byType: {} };
  }
  const state = makeProviderRedactionState(options);
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
  const state = makeProviderRedactionState(options);
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
