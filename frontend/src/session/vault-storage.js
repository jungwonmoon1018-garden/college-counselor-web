// vault-storage.js — the passphrase-encrypted per-student vault: key derivation,
// AES-GCM encrypt/decrypt, the storage wrapper and the blob shape that keeps
// identity inside the ciphertext. Moved out of App.jsx on 2026-09-20.
// ═══════════════════════════════════════════════════════════
// ENCRYPTION
// ═══════════════════════════════════════════════════════════
const te = new TextEncoder(), td = new TextDecoder();

async function dk(pw, userSalt) {
  const b = await crypto.subtle.importKey("raw", te.encode(pw), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: te.encode("cv4:" + (userSalt || "default")), iterations: 600000, hash: "SHA-256" }, b, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function encrypt(data, pw, userSalt) {
  const k = await dk(pw, userSalt), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, te.encode(JSON.stringify(data)));
  return JSON.stringify({ iv: Array.from(iv), ct: Array.from(new Uint8Array(ct)) });
}

export async function decrypt(blob, pw, userSalt) {
  try { const { iv, ct } = JSON.parse(blob); const k = await dk(pw, userSalt);
    return JSON.parse(td.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(iv) }, k, new Uint8Array(ct))));
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════
// Encrypted cache storage. Account identity and session metadata are never
// written here; the local backend is the authority for login and recovery.
// ═══════════════════════════════════════════════════════════
export const storageApi = {
  async get(key) {
    if (window?.storage?.get && window.storage !== storageApi) return window.storage.get(key);
    try {
      const value = window.localStorage.getItem(key);
      return { value };
    } catch {
      return { value: null };
    }
  },
  async set(key, value) {
    if (window?.storage?.set && window.storage !== storageApi) return window.storage.set(key, value);
    window.localStorage.setItem(key, value);
  },
  async delete(key) {
    if (window?.storage?.delete && window.storage !== storageApi) return window.storage.delete(key);
    window.localStorage.removeItem(key);
  }
};

// Unicode-safe base64 for storage keys (btoa crashes on non-ASCII)
export function safeBtoa(str) {
  return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, p1) => String.fromCharCode(parseInt(p1, 16))));
}

async function hashEmail(email) {
  const data = te.encode("local_vault:" + String(email || "").normalize("NFKC").trim().toLowerCase());
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function storageKeyFor(email) {
  return `cv4_${await hashEmail(email)}`;
}

export async function clearSession() {
  // Remove legacy identity hints during migration. Current sessions are
  // memory-only and are revoked at the backend on logout.
  try {
    await storageApi.delete("cc_active_session");
    await storageApi.delete("cc_accounts_registry");
  } catch {}
}

// ─── Vault blob shape ────────────────────────────────────────────────────
// The passphrase-encrypted per-student vault carries both the student's data
// and their identity (name/grade). Identity lives here — inside the encrypted
// blob — rather than in a plaintext registry, so login can recover it without
// the backend disclosing who has an account. `_verifier` marks a vault seeded
// at signup that holds no data yet. Every write must go through
// buildVaultBlob() so identity survives auto-save.
export function buildVaultBlob(data, identity, { verifier = false } = {}) {
  const blob = { ...data, _identity: identity };
  if (verifier) blob._verifier = true;
  return blob;
}

export function readVaultIdentity(blob) {
  const identity = blob?._identity;
  return identity?.name && identity?.grade ? identity : null;
}

export function readVaultData(blob) {
  const { _identity, _verifier, ...data } = blob || {};
  return data;
}
