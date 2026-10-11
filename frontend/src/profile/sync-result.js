// sync-result.js — what to tell the student after a profile save.
//
// The survey and the auto-save treated any answer from POST
// /api/students/sync as a save, because authedFetch resolves on every HTTP
// status and only a network failure threw. A 413, 429, 500 or 503 told the
// student "your profile is saved and synced" while the counselor kept the
// old record. These sentences say what happened and what to do; the local
// copy on the device is saved either way.

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

// The server's `setAside` list ({ field, reason, count }) as one sentence,
// or "" when everything was saved.
export function describeSetAside(setAside) {
  if (!Array.isArray(setAside) || setAside.length === 0) return "";
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
