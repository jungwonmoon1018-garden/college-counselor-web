// server/student-data.js — a student's rows across every table that carries
// a student id: collected for export, deleted with the account, files removed.
// Moved out of server.js on 2026-09-20.
// `deps` is server.js's routeDeps object: live getters onto the bindings
// these functions read there (DATA_DIR, EC_ATTACHMENTS_DIR).
import { removeStudentStorage } from "../storage/student-storage.js";
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

export function collectStudentRows(database, studentId, { exclude = [] } = {}) {
  const excluded = new Set(exclude);
  const out = {};
  for (const table of tablesContainingColumn(database, "student_id")) {
    if (excluded.has(table)) continue;
    out[table] = database.prepare(`SELECT * FROM ${quoteSqlIdentifier(table)} WHERE student_id = ?`).all(studentId);
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
