// server/student-data.js — a student's rows across every table that carries
// a student id: collected for export, deleted with the account, files removed.
// Moved out of server.js on 2026-09-20.
// `deps` is server.js's routeDeps object: live getters onto the bindings
// these functions read there (DATA_DIR, EC_ATTACHMENTS_DIR, authStore, db,
// piiVault, vectorStore).
import { removeStudentStorage } from "../storage/student-storage.js";
import { SEALED_COLUMNS, openSealedRow } from "../chat/chat-history.js";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";

let deps;
export function bindStudentData(serverDeps) { deps = serverDeps; }

export function quoteSqlIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

export function tablesContainingColumn(database, columnName) {
  return database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
    .map((row) => row.name)
    .filter((table) => database.prepare(`PRAGMA table_info(${quoteSqlIdentifier(table)})`).all().some((column) => column.name === columnName));
}

// Every row of the student's in each table that has a student_id column.
// With `open` (chat-history's openText), the sealed columns are opened: the
// export used to hand the student their conversations as ciphertext.
export function collectStudentRows(database, studentId, { exclude = [], open = null } = {}) {
  const excluded = new Set(exclude);
  const out = {};
  for (const table of tablesContainingColumn(database, "student_id")) {
    if (excluded.has(table)) continue;
    const rows = database.prepare(`SELECT * FROM ${quoteSqlIdentifier(table)} WHERE student_id = ?`).all(studentId);
    out[table] = open && SEALED_COLUMNS[table] ? rows.map((row) => openSealedRow(table, row, open)) : rows;
  }
  return out;
}

export function deleteStudentRows(database, studentId) {
  const tables = tablesContainingColumn(database, "student_id");
  const tx = database.transaction(() => {
    const names = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    if (names.has("chat_messages") && names.has("chat_threads")) {
      database.prepare("DELETE FROM chat_messages WHERE thread_id IN (SELECT id FROM chat_threads WHERE student_id = ?)").run(studentId);
    }
    if (names.has("evidence_items")) {
      database.prepare("DELETE FROM evidence_items WHERE entity_type = 'student' AND entity_id = ?").run(studentId);
    }
    if (names.has("canonical_facts")) {
      database.prepare("DELETE FROM canonical_facts WHERE entity_type = 'student' AND entity_id = ?").run(studentId);
    }
    if (names.has("college_values")) {
      const cols = database.prepare("PRAGMA table_info(college_values)").all();
      if (cols.some((column) => column.name === "extracted_by_student_id")) {
        database.prepare("DELETE FROM college_values WHERE extracted_by_student_id = ?").run(studentId);
      }
    }
    for (const table of tables) {
      database.prepare(`DELETE FROM ${quoteSqlIdentifier(table)} WHERE student_id = ?`).run(studentId);
    }
  });
  tx();
}

export async function removeStudentFiles(studentId) {
  await removeStudentStorage(studentId, deps.DATA_DIR);
  const root = path.resolve(deps.EC_ATTACHMENTS_DIR);
  const target = path.resolve(root, String(studentId));
  if (target !== root && target.startsWith(root + path.sep)) {
    await fs.promises.rm(target, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════
// ACCOUNT ERASURE
// ═══════════════════════════════════════════════════════════
// "Delete my account" used to delete the rows that carry a student_id and
// the files, and miss three things. The sync route wrote audit rows keyed by
// a prefix of the email hash (a fixed salt in source, so recomputable from
// the email) whose details named the student's activities and GPA; they sat
// in the counselor's log for 90 days, or seven years in institutional mode.
// The credential went last, so the account stayed usable while its rows were
// being removed. And a background writer that finished after the delete (the
// auto-narrative's model call, a usage-ledger write) put rows back for an id
// nobody could reach or delete again.
//
// eraseStudent now ends the account first (credential and sessions), writes
// a tombstone, removes the rows in all three databases, the audit rows that
// can point back at the student, and the files, and sweeps the same id again
// a few minutes later. The tombstone holds a salted hash of the id, never the
// id, and the daily sweep below removes rows for any tombstoned id found in
// any table, which also covers a write that lands after the follow-up sweep.
const TOMBSTONE_SALT = "cc_erasure_tombstone";
const RESWEEP_MS = Number(process.env.ERASURE_RESWEEP_MS) > 0 ? Number(process.env.ERASURE_RESWEEP_MS) : 5 * 60 * 1000;

export function erasureIdHash(studentId) {
  return crypto.createHash("sha256").update(`${TOMBSTONE_SALT}:${studentId}`).digest("hex");
}

export function ensureErasureTombstones(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS erasure_tombstones (
      id_hash TEXT PRIMARY KEY,
      erased_at TEXT NOT NULL
    );
  `);
}

function tableExists(database, name) {
  return !!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

// The audit rows that can lead back to the student. Rows keyed by the email
// hash prefix (only the sync route wrote those) are deleted; so are the
// profile_* rows keyed by the id prefix, the ones that ever carried profile
// content. The rest keyed by the id prefix are content-free events (consent
// granted, input blocked, crisis detected) whose counts the counselor relies
// on, so they are kept with the hint and the IP hash cleared: nothing in them
// points to anyone once the account is gone.
export function purgeStudentAudit(database, { studentId, emailHash = null } = {}) {
  const result = { deleted: 0, unlinked: 0 };
  if (!studentId) return result;
  const idHint = String(studentId).slice(0, 12);
  const emailHint = emailHash ? String(emailHash).slice(0, 12) : null;
  if (tableExists(database, "audit_events")) {
    if (emailHint) result.deleted += database.prepare("DELETE FROM audit_events WHERE user_hint = ?").run(emailHint).changes;
    result.deleted += database.prepare("DELETE FROM audit_events WHERE user_hint = ? AND type LIKE 'profile\\_%' ESCAPE '\\'").run(idHint).changes;
    result.unlinked += database.prepare("UPDATE audit_events SET user_hint = NULL, ip_hash = NULL WHERE user_hint = ?").run(idHint).changes;
  }
  if (tableExists(database, "notification_queue")) {
    for (const hint of [idHint, emailHint].filter(Boolean)) {
      result.deleted += database.prepare("DELETE FROM notification_queue WHERE student_hint = ?").run(hint).changes;
    }
  }
  return result;
}

// Every row of one student in the three databases (no files).
export function purgeStudentRecords(studentId, { emailHash = null } = {}) {
  if (!studentId) return;
  if (deps.piiVault?.db) deleteStudentRows(deps.piiVault.db, studentId);
  deleteStudentRows(deps.db, studentId);
  if (deps.vectorStore?.db && tableExists(deps.vectorStore.db, "embeddings")) {
    deps.vectorStore.db.prepare("DELETE FROM embeddings WHERE source_id = ? AND source_type LIKE 'student%'").run(studentId);
  }
  purgeStudentAudit(deps.db, { studentId, emailHash });
}

export async function eraseStudent({ studentId, emailHash = null } = {}) {
  if (!studentId) throw new Error("studentId required");
  // The account ends first: no session works and no login succeeds while
  // the rest is removed.
  deps.authStore.deleteStudentCredential(studentId);
  ensureErasureTombstones(deps.db);
  deps.db.prepare("INSERT OR IGNORE INTO erasure_tombstones (id_hash, erased_at) VALUES (?, ?)")
    .run(erasureIdHash(studentId), new Date().toISOString());
  purgeStudentRecords(studentId, { emailHash });
  await removeStudentFiles(studentId);
  // A write already under way (a model call outlives a request by up to two
  // minutes) is caught by sweeping the id again once it has had time to land.
  const resweep = setTimeout(() => {
    try { purgeStudentRecords(studentId, { emailHash }); } catch (err) { console.warn("[ERASURE] follow-up sweep failed:", err.message); }
    removeStudentFiles(studentId).catch((err) => console.warn("[ERASURE] follow-up file sweep failed:", err.message));
  }, RESWEEP_MS);
  resweep.unref?.();
  return { erased: true };
}

// The ids in `database` whose tombstone hash is in `hashes`.
function tombstonedIdsIn(database, hashes, { column = "student_id", tables = null } = {}) {
  const found = new Set();
  for (const table of tables || tablesContainingColumn(database, column)) {
    if (!tableExists(database, table)) continue;
    for (const row of database.prepare(`SELECT DISTINCT ${quoteSqlIdentifier(column)} AS id FROM ${quoteSqlIdentifier(table)}`).all()) {
      if (row.id != null && hashes.has(erasureIdHash(row.id))) found.add(String(row.id));
    }
  }
  return found;
}

// The boot and daily sweep: rows (and files) for any erased id that a late
// write, or a restore from one of the daily backups, put back.
export async function sweepErasedStudents() {
  ensureErasureTombstones(deps.db);
  const hashes = new Set(deps.db.prepare("SELECT id_hash FROM erasure_tombstones").all().map((row) => row.id_hash));
  if (hashes.size === 0) return { deleted: 0 };
  const ids = tombstonedIdsIn(deps.db, hashes);
  if (deps.piiVault?.db) for (const id of tombstonedIdsIn(deps.piiVault.db, hashes)) ids.add(id);
  if (deps.vectorStore?.db) for (const id of tombstonedIdsIn(deps.vectorStore.db, hashes, { column: "source_id", tables: ["embeddings"] })) ids.add(id);
  try {
    const root = path.resolve(deps.EC_ATTACHMENTS_DIR);
    for (const entry of fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : []) {
      if (entry.isDirectory() && hashes.has(erasureIdHash(entry.name))) ids.add(entry.name);
    }
  } catch (err) {
    console.warn("[ERASURE] attachment directory scan failed:", err.message);
  }
  for (const id of ids) {
    // A tombstoned id with a live credential cannot happen (ids are random
    // UUIDs), but the sweep never removes an account that can sign in.
    if (deps.authStore?.studentExists?.(id)) continue;
    purgeStudentRecords(id);
    await removeStudentFiles(id).catch((err) => console.warn("[ERASURE] file sweep failed:", err.message));
  }
  return { deleted: ids.size };
}
