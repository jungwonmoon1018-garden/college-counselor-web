// quick-prompts.js — the quick questions under the chat box.
//
// They were fixed English text: "Plan my junior year" for every student, a
// senior included, and "Search colleges for CS" whatever the student meant
// to study, under the Korean locale too (mock run, 2026-11-22). A chip only
// fills the composer; the student still reads and sends it, so it is
// written in the student's language as a question the counselor answers.
import { currentYearKey } from "../profile/transcript-utils.js";

const YEAR_LABEL = Object.freeze({
  "en-US": { freshman: "freshman", sophomore: "sophomore", junior: "junior", senior: "senior" },
  ko: { freshman: "9학년", sophomore: "10학년", junior: "11학년", senior: "12학년" },
});

export function quickPrompts({ locale = "en-US", grade = null, major = "" } = {}) {
  const ko = locale === "ko";
  const year = currentYearKey(grade);
  const subject = String(major || "").replace(/\s+/g, " ").trim().slice(0, 40);
  const yearLabel = year ? YEAR_LABEL[ko ? "ko" : "en-US"][year] : null;
  return [
    ko ? "내 프로필 요약해 줘" : "What's my profile?",
    ko ? "나에게 맞는 활동 추천해 줘" : "Suggest ECs for me",
    subject
      ? (ko ? `${subject} 전공에 맞는 대학 찾아 줘` : `Search colleges for ${subject}`)
      : (ko ? "나에게 맞는 대학 찾아 줘" : "Find colleges that fit me"),
    yearLabel
      ? (ko ? `${yearLabel} 계획 세워 줘` : `Plan my ${yearLabel} year`)
      : (ko ? "올해 계획 세워 줘" : "Plan my school year"),
  ];
}
