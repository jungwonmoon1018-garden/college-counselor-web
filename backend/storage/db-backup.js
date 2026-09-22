// storage/db-backup.js — daily copies of the three SQLite databases onto
// the persistent disk, kept for seven days. The deploy checklist of
// 2026-09-22 found no backup routine at all: a disk snapshot is the host's
// to take, and this is the copy the counselor can fetch from the service
// shell (RUNBOOK.md, *Backups*). better-sqlite3's online backup API copies
// a live database consistently, page by page, without holding it locked.
import fs from "node:fs";
import path from "node:path";

export const BACKUP_KEEP = 7;
// A copy's name: the database's stem and its UTC date. The download route
// accepts nothing else, so a path can never be built from a request.
export const BACKUP_FILE_RE = /^[a-z-]+\.\d{4}-\d{2}-\d{2}\.db$/;

export function listBackupFiles(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((name) => BACKUP_FILE_RE.test(name))
    .map((name) => { const stat = fs.statSync(path.join(dir, name)); return { name, bytes: stat.size, modifiedAt: stat.mtime.toISOString() }; })
    .sort((a, b) => b.name.localeCompare(a.name));
}

export function backupFileName(name, now = new Date()) {
  return `${name}.${now.toISOString().slice(0, 10)}.db`;
}

// One copy per database per calendar day (UTC); a second run on the same
// day is a no-op for that database. `databases` maps a file stem to an
// open better-sqlite3 Database (a null entry is skipped).
export async function backupDatabases(databases, { dir, keep = BACKUP_KEEP, now = new Date() } = {}) {
  if (!dir) throw new Error("backupDatabases: dir is required");
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  const skipped = [];
  for (const [name, db] of Object.entries(databases)) {
    if (!db) continue;
    const target = path.join(dir, backupFileName(name, now));
    if (fs.existsSync(target)) { skipped.push(path.basename(target)); continue; }
    const partial = `${target}.partial`;
    try {
      await db.backup(partial);
      fs.renameSync(partial, target);
      written.push(path.basename(target));
    } catch (err) {
      fs.rmSync(partial, { force: true });
      throw err;
    }
  }
  const removed = pruneBackups(dir, Object.keys(databases), keep);
  return { dir, written, skipped, removed, changed: written.length > 0 || removed.length > 0 };
}

// Keep the newest `keep` copies of each database; the names sort by date.
export function pruneBackups(dir, names, keep = BACKUP_KEEP) {
  const removed = [];
  let files;
  try { files = fs.readdirSync(dir); } catch { return removed; }
  for (const name of names) {
    const own = files.filter((f) => f.startsWith(`${name}.`) && /\.\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    for (const f of own.slice(0, Math.max(0, own.length - keep))) {
      fs.rmSync(path.join(dir, f), { force: true });
      removed.push(f);
    }
  }
  return removed;
}
