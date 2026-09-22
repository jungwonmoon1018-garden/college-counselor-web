// Daily copies of the databases onto the persistent disk (storage/db-backup.js):
// one per database per day, the newest seven kept, nothing partial left
// behind, and the server registering the job with a copy at boot.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

import { BACKUP_KEEP, backupDatabases, backupFileName, pruneBackups } from "../storage/db-backup.js";

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 24 * 60 * 60 * 1000;

test("copies each open database once a day and keeps the newest seven of each", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-backup-"));
  const dir = path.join(root, "backups");
  const counselor = new Database(path.join(root, "counselor.db"));
  counselor.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  counselor.prepare("INSERT INTO t (v) VALUES (?)").run("x");
  counselor.prepare("INSERT INTO t (v) VALUES (?)").run("y");
  const vault = new Database(path.join(root, "pii-vault.db"));
  vault.exec("CREATE TABLE s (k TEXT)");
  const now = new Date("2026-09-22T12:00:00Z");
  try {
    assert.equal(backupFileName("counselor", now), "counselor.2026-09-22.db");
    const first = await backupDatabases({ counselor, "pii-vault": vault, vectors: null }, { dir, now });
    assert.deepEqual(first.written, ["counselor.2026-09-22.db", "pii-vault.2026-09-22.db"]);
    assert.equal(first.changed, true);
    const copy = new Database(path.join(dir, "counselor.2026-09-22.db"), { readonly: true });
    assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM t").get().n, 2, "the copy holds the rows");
    copy.close();

    const again = await backupDatabases({ counselor, "pii-vault": vault }, { dir, now });
    assert.deepEqual(again.written, []);
    assert.deepEqual(again.skipped, ["counselor.2026-09-22.db", "pii-vault.2026-09-22.db"]);
    assert.equal(again.changed, false);

    for (let day = 1; day <= 8; day += 1) await backupDatabases({ counselor }, { dir, now: new Date(now.getTime() + day * DAY) });
    const kept = fs.readdirSync(dir).filter((f) => f.startsWith("counselor.")).sort();
    assert.equal(kept.length, BACKUP_KEEP);
    assert.equal(kept[0], "counselor.2026-09-24.db");
    assert.equal(kept[kept.length - 1], "counselor.2026-09-30.db");
    assert.ok(fs.existsSync(path.join(dir, "pii-vault.2026-09-22.db")), "each database is pruned by its own count");
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".partial")), []);
  } finally {
    counselor.close();
    vault.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a copy that fails leaves no partial file and the error reaches the job", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-backup-fail-"));
  try {
    const broken = { backup: async () => { throw new Error("disk full"); } };
    await assert.rejects(backupDatabases({ counselor: broken }, { dir }), /disk full/);
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.deepEqual(pruneBackups(dir, ["counselor"]), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the server registers the daily backup with a copy at boot, off under the test runner", () => {
  const jobs = fs.readFileSync(path.join(BACKEND, "server", "jobs.js"), "utf8");
  assert.ok(jobs.includes('registerJob("db_backup", () => backupDatabases('));
  assert.ok(jobs.includes('{ dir: path.join(deps.DATA_DIR, "backups") }'));
  assert.ok(jobs.includes('{ enabled: process.env.NODE_ENV !== "test", runOnStartup: true }'));
});
