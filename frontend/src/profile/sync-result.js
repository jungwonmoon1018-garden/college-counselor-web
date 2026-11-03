// sync-result.js — what to tell the student after a profile save.
//
// The survey and the auto-save treated any answer from POST
// /api/students/sync as a save, because authedFetch resolves on every HTTP
// status and only a network failure threw. A 413, 429, 500 or 503 told the
// student "your profile is saved and synced" while the counselor kept the
// old record. These sentences say what happened and what to do; the local
// copy on the device is saved either way.
import { detectLocale } from "../i18n.js";

export function syncFailureMessage(status) {
  if (status === 413) return "Your profile is too large to save — shorten a long activity description and try again.";
  if (status === 429) return "Too many saves in a row — wait a minute, then try again.";
  if (status === 401) return "Your session ended — sign out and sign in again to save.";
  if (status === 503) return "Your counselor isn't available right now — try again in a few minutes.";
  return "Your profile didn't reach your counselor — try again.";
}

function counted(n, one, many, whole) {
  if (n === 1) return { text: `1 ${one}`, plural: false };
  if (n > 1) return { text: `${n} ${many}`, plural: true };
  return { text: whole, plural: false };
}

function labelFor(item) {
  const n = Number(item?.count) || 0;
  switch (item?.field) {
    case "gpa":
    case "gpa.unweighted": return { text: "your GPA", plural: false };
    case "gpa.weighted": return { text: "your weighted GPA", plural: false };
    case "classRank": return { text: "your class rank", plural: false };
    case "majorInterest": return { text: "your intended major", plural: false };
    case "profile": return { text: "your profile", plural: false };
    case "courses": return counted(n, "course", "courses", "your course list");
    case "testScores": return counted(n, "test score", "test scores", "your test score list");
    case "apScores": return counted(n, "AP score", "AP scores", "your AP score list");
    case "activities": return counted(n, "activity", "activities", "your activity list");
    case "goals": return counted(n, "goal", "goals", "your goal list");
    default: return { text: "one field", plural: false };
  }
}

// Korean field names, for the same items.
function labelForKo(item) {
  const n = Number(item?.count) || 0;
  const many = (name) => (n > 0 ? `${name} ${n}개` : `${name} 목록`);
  switch (item?.field) {
    case "gpa":
    case "gpa.unweighted": return "GPA";
    case "gpa.weighted": return "가중 GPA";
    case "classRank": return "석차";
    case "majorInterest": return "희망 전공";
    case "profile": return "프로필";
    case "courses": return many("과목");
    case "testScores": return many("시험 점수");
    case "apScores": return many("AP 점수");
    case "activities": return many("활동");
    case "goals": return many("목표 대학");
    default: return "항목 하나";
  }
}

// Why an entry was set aside, in Korean. The server's message is English
// (it comes from the same validator the English form shows), so the Korean
// note says the reason from its code instead.
const KO_REASONS = Object.freeze({
  scale_needed: "점수 척도를 골라야 해요 (0-120 점수인지 1-6 밴드 점수인지)",
  date_unreadable: "시험 날짜를 읽지 못해 날짜 없이 저장했어요. 월을 다시 골라 주세요",
  invalid_entry: "범위를 벗어났거나 읽을 수 없는 값이에요",
  out_of_range: "범위를 벗어난 값이에요",
  not_a_number: "숫자가 아니에요",
});

const stripPeriod = (text) => String(text || "").trim().replace(/[.。]+$/, "");

// One entry the server named ({ index, label, message, kept }): which one,
// why, and whether the saved version stood in for it.
function entryPart(entry, reason, ko) {
  const label = String(entry?.label || "").trim() || (ko ? "항목" : "an entry");
  const why = ko ? (KO_REASONS[reason] || KO_REASONS.invalid_entry) : stripPeriod(entry?.message) || "it couldn't be read";
  const kept = entry?.kept ? (ko ? " — 이전에 저장된 값을 그대로 두었어요" : "; your saved version was kept") : "";
  return ko ? `${label}: ${why}${kept}` : `${label} (${why}${kept})`;
}

// The server's `setAside` list as one note, or "" when everything was
// saved. Items are { field, reason, count, kept?, entries? }; `entries`
// names each test or AP score that was set aside (its place, a label such
// as "SAT 1700 (2026-03)", the reason, and whether the stored version was
// kept). Before entries existed every auto-save repeated "1 test score
// couldn't be read" without saying which one, and only in English.
export function describeSetAside(setAside, { locale = detectLocale() } = {}) {
  if (!Array.isArray(setAside) || setAside.length === 0) return "";
  const ko = locale === "ko";
  if (ko || setAside.some((item) => Array.isArray(item?.entries) && item.entries.length)) {
    const parts = [];
    for (const item of setAside) {
      if (Array.isArray(item?.entries) && item.entries.length) {
        for (const entry of item.entries) parts.push(entryPart(entry, item.reason, ko));
      } else {
        const name = ko ? labelForKo(item) : labelFor(item).text;
        const kept = item?.kept ? (ko ? " — 이전에 저장된 값을 그대로 두었어요" : "; your saved version was kept") : "";
        const part = ko ? `${name}: ${KO_REASONS[item?.reason] || "읽을 수 없는 값이에요"}${kept}` : `${name} (it couldn't be read${kept})`;
        if (!parts.includes(part)) parts.push(part);
      }
    }
    if (ko) return `저장했어요. 다만 다음 항목은 저장하지 못했어요: ${parts.join("; ")}. 프로필에서 고치거나 지워 주세요.`;
    const plural = parts.length > 1;
    return `Saved, except ${parts.join("; ")}. Fix ${plural ? "them" : "it"} in your profile, or remove ${plural ? "them" : "it"}.`;
  }
  const labels = [];
  for (const item of setAside) {
    const label = labelFor(item);
    if (!labels.some((l) => l.text === label.text)) labels.push(label);
  }
  const names = labels.map((l) => l.text);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const plural = labels.length > 1 || labels[0].plural;
  return `Saved, except ${list}, which couldn't be read — check ${plural ? "them" : "it"} in your profile.`;
}
