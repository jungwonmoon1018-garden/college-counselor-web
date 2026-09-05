// Client-side crisis handling, in three layers of certainty:
//   • CRISIS_STRICT_RE — explicit self-harm / abuse / danger statements about
//     the student. Always the crisis response, no model involved.
//   • IDEATION_RE — hopelessness about life itself ("no point in going on",
//     "everyone would be better off without me"). Corroborates a model
//     "crisis" call. Never fires on academic despair.
//   • DISTRESS_RE — ordinary stress words ("hopeless at chemistry",
//     "overwhelmed"). Never blocks: the answer just gains a supportive footer.
// The old single list contained bare "hopeless", so "I'm hopeless at
// calculus" returned the hotlines instead of help. Pure module so the lexicon
// is unit-tested; the server's policy-router.js keeps the matching rules for
// its own deterministic path.

export const CRISIS_STRICT_RE = /\b(?:suicid\w*|kill(?:ing)?\s+myself|hurt(?:ing)?\s+myself|cut(?:ting)?\s+myself|self[\s-]?harm(?:ing)?|don'?t\s+want\s+to\s+(?:live|be\s+alive|exist|wake\s+up)|end\s+(?:it\s+all|my\s+(?:own\s+)?life)|take\s+my\s+(?:own\s+)?life|wanna\s+die|want\s+to\s+die|better\s+off\s+dead|wish\s+i\s+(?:was|were)\s+dead|overdos(?:e|ing)|(?:my|our)\s+(?:dad|father|mom|mother|parents?|step\w+|coach|teacher|boyfriend|girlfriend|uncle|aunt|brother|sister|guardian)\s+(?:hits?|beats?|abuses?|touch(?:es|ed)|molest(?:s|ed)?|assault(?:s|ed)?)\s+me|i(?:'m| am| was| have been)\s+(?:being\s+)?(?:abused|molested|assaulted|raped|groomed)|threaten(?:s|ing|ed)\s+(?:to\s+(?:hurt|kill)\s+)?me|i(?:'m| am)\s+(?:in\s+danger|not\s+safe|unsafe))\b/i;

export const IDEATION_RE = /\b(?:no\s+point\s+(?:in|to)\s+(?:living|anything|going\s+on)|better\s+(?:off\s+)?without\s+me|nobody\s+would\s+(?:care|notice|miss\s+me)|disappear\s+(?:forever|for\s+good)|give\s+up\s+on\s+(?:life|everything)|can'?t\s+go\s+on(?:\s+like\s+this)?|hate\s+my\s+life|life\s+is(?:n'?t|\s+not)\s+worth|don'?t\s+see\s+the\s+point\s+(?:of|in)\s+(?:anything|living|life))\b/i;

export const DISTRESS_RE = /\b(?:hopeless|worthless|overwhelmed|burn(?:ed|t)\s*out|breaking\s+down|panic(?:king|\s+attacks?)?|can'?t\s+(?:cope|handle|take)\s+(?:this|it|any\s*more)|falling\s+apart|depress(?:ed|ing|ion)|anxiety|so\s+stressed|crying)\b/i;

export const SUPPORT_FOOTER = "\n\n_If the stress is getting heavy, talking with a school counselor or another trusted adult really helps — and if you ever feel unsafe, you can call or text 988 any time._";

// True when the message itself states a risk to the student's safety.
export function isCrisisStatement(text) {
  const s = String(text || "");
  return CRISIS_STRICT_RE.test(s) || IDEATION_RE.test(s);
}

export function isDistressed(text) {
  return DISTRESS_RE.test(String(text || ""));
}

// Append the supportive footer once, never on top of the hotline text.
export function withSupport(text, needed) {
  if (!needed || typeof text !== "string" || !text.trim() || text.includes("988")) return text;
  return text + SUPPORT_FOOTER;
}
