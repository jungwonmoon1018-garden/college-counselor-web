// profile-reconcile.js — the one rule for joining the profile this device
// holds with the profile the server holds, and the sync body built from it.
//
// Login and the profile pull each carried a hand-written merge that kept the
// device's copy of a field whenever it was non-empty, and whichever course or
// activity list was longer. A student who changed her SAT and GPA on the home
// laptop and then signed in on a school Chromebook with a day-old vault got
// the old numbers back: the merge kept the Chromebook's non-empty copies, the
// course counts matched, and a second after the chat opened the auto-save
// posted the stale record over the server's. Activities she had deleted came
// back, and the fidelity check then held the counselor to the old SAT.
//
// The device now remembers a sync base: the server revision its copy was last
// in step with, and the value every field had at that point. A field the
// device changed since then is a local edit and is kept; every other field
// takes the server's value, so a newer server profile wins whole on a device
// that edited nothing. A vault written before the sync base existed is read
// with its own contents as the base, so it counts as unedited and the server
// wins it too. Each sync sends the base revision; a server that has moved on
// answers 409 with its profile, which goes through this same merge.
//
// Everything here is pure: callers fetch, then hand the bodies in.
import { hasGpa, normalizeGpa } from "./gpa.js";

// The fields a sync carries, read from the app's `data` shape. majorInterest
// lives both at the top of `data` and inside `data.profile`; the server keeps
// one value, the top-level one the sync sends.
const PROFILE_FIELDS = ["gpa", "gpaStatus", "classRank", "courses", "apScores", "testScores", "testingStatus"];
export const SYNC_FIELDS = [...PROFILE_FIELDS, "activities", "goals", "majorInterest"];
const LIST_FIELDS = new Set(["courses", "apScores", "testScores", "activities", "goals"]);

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);
const asList = (value) => (Array.isArray(value) ? value : []);
const asText = (value) => (typeof value === "string" ? value : "");
const asStatus = (value) => (typeof value === "string" && value ? value : undefined);
const asObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : null);

function readField(field, value) {
  if (field === "gpa") return normalizeGpa(value);
  if (field === "classRank") return asObject(value);
  if (field === "gpaStatus" || field === "testingStatus") return asStatus(value);
  if (field === "majorInterest") return asText(value);
  return LIST_FIELDS.has(field) ? asList(value) : value;
}

// The sync fields of a `data`-shaped object.
export function readLocalView(data) {
  const d = data || {};
  const profile = d.profile || {};
  const view = {};
  for (const field of PROFILE_FIELDS) view[field] = readField(field, profile[field]);
  view.activities = readField("activities", d.activities);
  view.goals = readField("goals", d.goals);
  view.majorInterest = readField("majorInterest", d.majorInterest || profile.majorInterest);
  return view;
}

// The server's profile from a GET /api/students/profile body or a 409
// conflict body. `exists` is false when the server holds no profile yet. A
// field the server does not report (gpaStatus and testingStatus, on a server
// that does not store them) is left out of the view, so the merge keeps the
// device's value for it instead of reading the absence as a deletion. A
// field is looked for in the profile first and then beside it, where a
// conflict body may carry the activities and goals.
export function readServerProfile(body) {
  const profile = asObject(body?.profile);
  const revision = body?.revision ?? profile?.revision ?? null;
  if (!profile) return { exists: false, revision, view: {} };
  const view = {};
  for (const field of SYNC_FIELDS) {
    if (hasOwn(profile, field)) view[field] = readField(field, profile[field]);
    else if (field !== "gpaStatus" && field !== "testingStatus" && hasOwn(body, field)) view[field] = readField(field, body[field]);
  }
  return { exists: true, revision, view };
}

// Values that mean the same thing compare equal: a missing field, null, an
// empty string and an empty list are all "nothing", key order is ignored, and
// a key holding nothing is the same as an absent key.
function canonical(value) {
  if (value == null || value === "") return null;
  if (Array.isArray(value)) return value.length ? value.map((item) => canonical(item)) : null;
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const inner = canonical(value[key]);
      if (inner !== null) out[key] = inner;
    }
    return Object.keys(out).length ? out : null;
  }
  return value;
}

export function sameValue(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

const sameRevision = (a, b) => a != null && b != null && String(a) === String(b);

// A GPA and a "no GPA yet" statement cannot both stand, nor test scores and
// "not taken yet": when the merge brings a real value from one side, the
// other side's statement that there is none goes.
function cohere(view) {
  const out = { ...view };
  if (hasGpa(out.gpa) && out.gpaStatus === "pending") out.gpaStatus = undefined;
  if (asList(out.testScores).length && out.testingStatus === "planned") out.testingStatus = undefined;
  return out;
}

// Write a view's fields onto a `data`-shaped object, keeping everything else
// it holds (study notes, documents, the survey flag, profile keys the sync
// does not carry).
function applyView(data, view) {
  const d = data || {};
  const profile = { ...(d.profile || {}) };
  for (const field of PROFILE_FIELDS) {
    if (view[field] === undefined) delete profile[field];
    else profile[field] = view[field];
  }
  if (view.majorInterest) profile.majorInterest = view.majorInterest;
  else delete profile.majorInterest;
  return { ...d, profile, activities: view.activities, goals: view.goals, majorInterest: view.majorInterest };
}

// A sync base whose snapshot is what `data` holds now: used for a vault from
// before sync bases, whose contents are all the device knows of the server.
export function baseFromData(data, serverRevision = null) {
  return { serverRevision, snapshot: readLocalView(data) };
}

// The base after a save landed: the server now holds what was sent.
export function baseFromPayload(payload, serverRevision = null) {
  return baseFromData({ profile: payload?.profile, activities: payload?.activities, goals: payload?.goals, majorInterest: payload?.majorInterest }, serverRevision);
}

// Whether `data` holds edits the server has not received. With no base at
// all nothing is known, so a profile counts as unsent; a base with no
// snapshot means the server held nothing when it was taken.
export function isDirty(data, base) {
  if (!data?.profile) return false;
  if (!base) return true;
  const view = readLocalView(data);
  const snapshot = base.snapshot || {};
  return SYNC_FIELDS.some((field) => !sameValue(view[field], snapshot[field]));
}

// The sync base as the vault keeps it: the revision, the snapshot, and
// whether the device held unsent edits when it was written.
export function vaultSyncRecord(data, base) {
  if (!base) return undefined;
  return { serverRevision: base.serverRevision ?? null, snapshot: base.snapshot || null, dirty: isDirty(data, base) };
}

// The body POST /api/students/sync takes, with the base revision when one is
// known. A server from before revisions ignores baseRevision.
export function buildSyncPayload(data, base) {
  const view = readLocalView(data);
  const payload = {
    profile: data?.profile || null,
    activities: view.activities,
    goals: view.goals,
    majorInterest: view.majorInterest,
  };
  if (base?.serverRevision != null) payload.baseRevision = base.serverRevision;
  return payload;
}

/**
 * Join the device's data with the server's profile.
 * @param {object} args
 * @param {object} args.local   the device's `data` (vault or in memory)
 * @param {object} args.server  readServerProfile(body)
 * @param {object|null} args.base the device's sync base ({ serverRevision, snapshot, dirty? })
 * @returns {{ data, base, changed: boolean, adopted: string[], kept: string[], conflicts: string[] }}
 *   adopted: fields that took the server's value where the device held another;
 *   kept: local edits kept over a different server value; conflicts: the kept
 *   fields the server had also changed since the base.
 */
export function reconcileProfile({ local, server, base = null } = {}) {
  const localData = local || { profile: null, activities: [], studyNotes: [], documents: [] };
  const localView = readLocalView(localData);
  if (!server?.exists) {
    // The server holds no profile yet: nothing to adopt, and everything this
    // device holds is still to be sent.
    return { data: localData, base: { serverRevision: server?.revision ?? null, snapshot: null }, changed: false, adopted: [], kept: [], conflicts: [] };
  }
  const snapshot = base?.snapshot || null;
  const serverUnmoved = sameRevision(base?.serverRevision, server.revision);
  const merged = {};
  const adopted = [], kept = [], conflicts = [];
  for (const field of SYNC_FIELDS) {
    const mine = localView[field];
    if (!hasOwn(server.view, field)) { merged[field] = mine; continue; }
    const theirs = server.view[field];
    // Without a snapshot only a vault that recorded unsent edits has any.
    const editedHere = snapshot ? !sameValue(mine, snapshot[field]) : base?.dirty === true && !sameValue(mine, null);
    if (editedHere) {
      merged[field] = mine;
      if (!sameValue(mine, theirs)) {
        kept.push(field);
        const movedThere = !serverUnmoved && (snapshot ? !sameValue(theirs, snapshot[field]) : true);
        if (movedThere) conflicts.push(field);
      }
    } else {
      merged[field] = theirs;
      if (!sameValue(mine, theirs)) adopted.push(field);
    }
  }
  const view = cohere(merged);
  const data = applyView(localData, view);
  // The new base is the server's view; a field the server does not report
  // is taken as in step at its merged value.
  const nextSnapshot = {};
  for (const field of SYNC_FIELDS) nextSnapshot[field] = hasOwn(server.view, field) ? server.view[field] : view[field];
  const changed = SYNC_FIELDS.some((field) => !sameValue(view[field], localView[field]));
  return {
    data: changed ? data : localData,
    base: { serverRevision: server.revision ?? null, snapshot: cohere(nextSnapshot) },
    changed,
    adopted,
    kept,
    conflicts,
  };
}

const FIELD_LABELS = {
  gpa: "GPA", gpaStatus: "GPA", classRank: "class rank", courses: "courses",
  apScores: "AP scores", testScores: "test scores", testingStatus: "test scores",
  activities: "activities", goals: "goals", majorInterest: "intended major",
};

function listLabels(fields) {
  const labels = [...new Set(fields.map((field) => FIELD_LABELS[field] || field))];
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

// What the student is told when the server's profile had moved on. Empty
// when nothing the student would notice changed.
export function describeProfileConflict(result) {
  const adopted = result?.adopted || [];
  const kept = result?.kept || [];
  if (!adopted.length && !kept.length) return "";
  if (adopted.length && kept.length) {
    return `Your profile changed on another device. This device kept your edits to your ${listLabels(kept)} and took your ${listLabels(adopted)} from the other device.`;
  }
  if (adopted.length) return `Your profile changed on another device, so this device now shows that version of your ${listLabels(adopted)}.`;
  return `Your profile also changed on another device. This device kept your edits to your ${listLabels(kept)}.`;
}
