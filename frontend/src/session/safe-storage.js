// safe-storage.js — the one guarded way the student app touches
// localStorage. When a browser blocks site data (Chrome's "block all
// cookies", some school-managed devices, in-app webviews), merely reading
// `window.localStorage` throws a SecurityError, and optional chaining does
// not help because the getter itself throws. Locale detection read it
// unguarded during the first render, so those students got the crash page
// instead of the login screen, and every api.js call threw the same way.
//
// Each call is wrapped; when storage cannot be used the value lives in
// memory for this page load instead, so a locale picked or a section
// folded still holds until reload. Nothing that must persist reliably
// belongs here: the server is the authority for the profile and the vault
// is an offline copy.
const memory = new Map();

function storage() {
  try {
    if (typeof window === "undefined") return null;
    const s = window.localStorage;
    return s && typeof s.getItem === "function" ? s : null;
  } catch {
    return null;
  }
}

export function safeGet(key) {
  const s = storage();
  if (s) {
    try {
      const value = s.getItem(key);
      if (value !== null && value !== undefined) return value;
    } catch { /* fall through to memory */ }
  }
  return memory.has(key) ? memory.get(key) : null;
}

// True when the value reached localStorage; false when it is held in memory
// only, so a caller that needs to know can say so.
// Memory holds only what storage refused, so a value another tab or a
// direct write changed later is read from storage, not from a stale copy.
export function safeSet(key, value) {
  const text = String(value);
  const s = storage();
  if (s) {
    try {
      s.setItem(key, text);
      memory.delete(key);
      return true;
    } catch { /* quota or blocked: keep it in memory below */ }
  }
  memory.set(key, text);
  return false;
}

export function safeRemove(key) {
  memory.delete(key);
  const s = storage();
  if (!s) return;
  try { s.removeItem(key); } catch { /* nothing to remove */ }
}

// Parsed JSON or the fallback, for the small per-device conveniences
// (collapsed sections, saved target lists) whose stored text may be old or
// hand-edited.
export function safeGetJson(key, fallback = null) {
  const raw = safeGet(key);
  if (raw == null || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// For tests: forget what was held in memory.
export function resetSafeStorageMemory() {
  memory.clear();
}
