// chat/usable-reply.js — two judgements the chat route makes about a model
// reply before the student sees it: whether it is something to show at all,
// and whether a fidelity retry lost a figure the first answer took from the
// VERIFIED DATA block.

// Keys a tool call carries in the JSON shapes models emit when they imitate
// one ({"name": "fetch_rag_context", "arguments": {...}}). A reply whose
// whole text is such an object (or a list of them) is markup, not an answer;
// a utility reply such as the gatekeeper's {"category": ...} has other keys.
const TOOL_CALL_KEYS = new Set(["name", "arguments", "parameters", "input", "id", "type", "function", "tool", "tool_name"]);

function looksLikeToolCallPayload(text) {
  const trimmed = String(text || "").trim();
  if (!/^[[{]/.test(trimmed)) return false;
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { return false; }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.length > 0 && items.every((item) => item
    && typeof item === "object"
    && !Array.isArray(item)
    && (typeof item.name === "string" || typeof item.tool_name === "string" || (item.function && typeof item.function === "object"))
    && Object.keys(item).every((key) => TOOL_CALL_KEYS.has(key)));
}

// Why a reply cannot be shown, or null when it can. `screenedText` is the
// text after screenOutput, which strips tool-call tags but leaves the JSON
// payload that sat between <tool_call> and </tool_call>. The small tier
// sometimes answers with nothing at all, and OpenRouter reports a provider
// that failed mid-route as a 200 with an error body (the adapter turns that
// into stop_reason "error"); all of these used to be composed into "There is
// not enough information to produce a specific suggestion." and saved to
// the student's thread as an answer.
export function unusableReplyReason(response, screenedText) {
  if (response?.stop_reason === "error" || response?.provider_error) return "provider_error_body";
  const text = String(screenedText || "").trim();
  if (!text) return response?.stop_reason === "length" ? "cut_off_empty" : "empty";
  if (looksLikeToolCallPayload(text)) return "tool_markup_only";
  return null;
}

// Figures written the way answers and the VERIFIED DATA block write them:
// 62,484 · 49% · 3.9 · 1330. One-digit numbers are left out, since list
// numbering and "2 essays" would otherwise count as figures.
const FIGURE_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?%?|\d+(?:\.\d+)?%?/g;

function figures(text) {
  const out = new Set();
  for (const match of String(text || "").matchAll(FIGURE_RE)) {
    const value = match[0].replace(/,/g, "");
    if (value.replace(/[^0-9]/g, "").length < 2) continue;
    out.add(value);
  }
  return out;
}

// The figures the first answer shares with the VERIFIED DATA block that the
// retry no longer carries. The fidelity retry is asked to correct the
// student's own record; when it drops or changes a school's verified figure
// on the way, the first answer (with the correction footnote) is kept. The
// values the fidelity check flagged (`contradictions[].stated`) are the ones
// the retry is meant to change, so they never count as lost, even when a
// misstated GPA happens to equal a school's average.
export function numbersDroppedFromVerified(firstText, retryText, verifiedDataContext, contradictions = []) {
  if (!verifiedDataContext) return [];
  const verified = figures(verifiedDataContext);
  if (!verified.size) return [];
  const retry = figures(retryText);
  const meantToChange = new Set();
  for (const entry of Array.isArray(contradictions) ? contradictions : []) {
    for (const value of figures(entry?.stated)) meantToChange.add(value);
  }
  return [...figures(firstText)].filter((value) => verified.has(value) && !retry.has(value) && !meantToChange.has(value));
}
