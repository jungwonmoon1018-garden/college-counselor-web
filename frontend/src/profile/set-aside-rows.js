// The exact rows a profile save set aside (input-12), so the sidebar can mark
// each one where it is and offer to fix or remove it. The save's note names
// them ("SAT 1700 (2026-03)"), but the sidebar showed every score alike, and
// a student with two SAT sittings could not tell which one had not saved.
//
// The server names a set-aside test or AP score by its place in the list
// that was sent (`index`), and the sync sends the device's own lists, so the
// row is the one at that place in what was sent. Each mark is held against
// the row's content, not its place: removing an earlier score moves the
// places, and an edited row is no longer the one the server refused, so its
// mark goes until the next save says otherwise.
import { t } from "../i18n.js";

// The lists whose set-aside entries carry an index.
export const SET_ASIDE_ROW_FIELDS = Object.freeze(["testScores", "apScores"]);

function rowKey(entry) {
  try { return JSON.stringify(entry ?? null); } catch { return ""; }
}

// The server's `setAside` and the profile that was sent, as the marks the
// sidebar reads: { testScores: [{ key, label, message, reason, kept }], ... }.
// A save that set nothing aside gives no marks, which clears the last ones.
export function setAsideRowsFrom(setAside, sentProfile) {
  const rows = {};
  for (const item of Array.isArray(setAside) ? setAside : []) {
    if (!SET_ASIDE_ROW_FIELDS.includes(item?.field) || !Array.isArray(item.entries)) continue;
    const list = Array.isArray(sentProfile?.[item.field]) ? sentProfile[item.field] : [];
    for (const entry of item.entries) {
      const index = Number(entry?.index);
      if (!Number.isInteger(index) || index < 0 || index >= list.length) continue;
      (rows[item.field] ||= []).push({
        key: rowKey(list[index]),
        label: String(entry?.label || ""),
        message: String(entry?.message || ""),
        reason: String(item.reason || "invalid_entry"),
        kept: entry?.kept === true,
      });
    }
  }
  return rows;
}

// The mark for one row of a list, or null.
export function setAsideMarkFor(rows, field, entry) {
  const marks = rows?.[field];
  if (!Array.isArray(marks) || !marks.length) return null;
  const key = rowKey(entry);
  return marks.find((mark) => mark.key === key) || null;
}

// What the row says. English reads the server's own reason (the validator
// the form uses); Korean says it from the reason code, as the save's note
// does (profile/sync-result.js).
export function setAsideMarkText(mark, locale) {
  if (!mark) return "";
  // An unreadable date is the one set-aside that still saved the score.
  if (mark.reason === "date_unreadable") return t(locale, "profile.set_aside.row_undated");
  const ko = String(locale || "").toLowerCase().startsWith("ko");
  const reasonKey = `profile.set_aside.reason.${mark.reason}`;
  let why = t(locale, reasonKey);
  if (why === reasonKey) why = t(locale, "profile.set_aside.reason.invalid_entry");
  if (!ko && mark.message) why = mark.message.trim().replace(/[.]+$/, "");
  const kept = mark.kept ? t(locale, "profile.set_aside.kept") : "";
  return t(locale, "profile.set_aside.row", { why, kept });
}
