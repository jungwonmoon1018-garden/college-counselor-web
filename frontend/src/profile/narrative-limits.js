// narrative-limits.js — the bounds the server holds a saved narrative to
// (backend/activities/narrative-store.js NARRATIVE_MIN_CHARS and friends),
// for the editor's counter and its save button. The editor kept its own
// copy that agreed with the server by luck: nothing compared them, so a
// changed server limit would have left a form that let a student type what
// the server refuses, or refused what it accepts (debt-11). The backend's
// misc-client-parity test holds the two equal.
export const NARRATIVE_MIN_CHARS = 100;
export const NARRATIVE_MAX_CHARS = 1500;
export const NARRATIVE_MIN_WORDS = 20;

// What the server would refuse in this text, by the code its
// validateNarrativeText throws ("too_short", "too_long", "too_few_words"),
// or null. Both sides trim first and count words split on whitespace.
export function narrativeTextProblem(text) {
  const s = String(text || "").trim();
  if (s.length < NARRATIVE_MIN_CHARS) return "too_short";
  if (s.length > NARRATIVE_MAX_CHARS) return "too_long";
  const words = s ? s.split(/\s+/).filter(Boolean).length : 0;
  if (words < NARRATIVE_MIN_WORDS) return "too_few_words";
  return null;
}
