// The FAFSA guidance text follows the award year the rules engine selects.
// Every case builds its own temp directory: backend/data/ holds real data
// and is never read by a test.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveFafsaGuidancePath, LEGACY_FAFSA_GUIDANCE_FILE } from "../chat/fafsa-guidance-path.js";
import { readServerSource } from "./helpers/server-source.mjs";

const RULESETS = [
  { id: "a", academicYear: "2026-2027", effectiveAt: "2026-07-01T00:00:00.000Z", expiresAt: "2027-06-30T23:59:59.999Z" },
  { id: "b", academicYear: "2027-2028", effectiveAt: "2027-07-01T00:00:00.000Z", expiresAt: "2028-06-30T23:59:59.999Z" },
];

const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fafsa-guidance-"));
  made.push(dir);
  for (const name of files) fs.writeFileSync(path.join(dir, name), `${name} guidance`);
  return dir;
}

test("the file for the selected award year wins", () => {
  const dir = tempDir(["2026-2027.txt", "2027-2028.txt"]);
  // The 2027-28 form opens on 2026-10-01, so a November date selects it.
  assert.equal(resolveFafsaGuidancePath({ dir, now: new Date("2026-11-03T12:00:00Z"), rulesets: RULESETS }), path.join(dir, "2027-2028.txt"));
  // Before that form opens, only 2026-27 is selected.
  assert.equal(resolveFafsaGuidancePath({ dir, now: new Date("2026-08-15T12:00:00Z"), rulesets: RULESETS }), path.join(dir, "2026-2027.txt"));
});

test("a missing selected file falls back to the newest award-year file present", () => {
  const dir = tempDir(["2024-2025.txt", "2025-2026.txt", "notes.txt", "2025-2027.txt"]);
  assert.equal(resolveFafsaGuidancePath({ dir, now: new Date("2026-11-03T12:00:00Z"), rulesets: RULESETS }), path.join(dir, "2025-2026.txt"));
  // No ruleset covers the date: the newest file is still used.
  assert.equal(resolveFafsaGuidancePath({ dir, now: new Date("2031-01-01T12:00:00Z"), rulesets: RULESETS }), path.join(dir, "2025-2026.txt"));
});

test("with no award-year file the old path is kept", () => {
  const dir = tempDir(["readme.md"]);
  assert.equal(resolveFafsaGuidancePath({ dir, now: new Date("2026-11-03T12:00:00Z"), rulesets: RULESETS }), path.join(dir, LEGACY_FAFSA_GUIDANCE_FILE));
  const missing = path.join(dir, "does-not-exist");
  assert.equal(resolveFafsaGuidancePath({ dir: missing, now: new Date("2026-11-03T12:00:00Z"), rulesets: RULESETS }), path.join(missing, LEGACY_FAFSA_GUIDANCE_FILE));
});

test("an explicit FAFSA_GUIDANCE_PATH overrides the award-year choice", () => {
  const dir = tempDir(["2026-2027.txt"]);
  assert.equal(resolveFafsaGuidancePath({ dir, override: "/srv/fafsa.txt", rulesets: RULESETS }), "/srv/fafsa.txt");
});

test("server.js resolves the guidance path through the award-year helper and logs the ruleset status", () => {
  const source = readServerSource();
  assert.match(source, /resolveFafsaGuidancePath\(\{[\s\S]{0,200}override:\s*process\.env\.FAFSA_GUIDANCE_PATH/);
  assert.doesNotMatch(source, /FAFSA_GUIDANCE_PATH\s*=\s*process\.env\.FAFSA_GUIDANCE_PATH\s*\|\|\s*path\.join/);
  assert.match(source, /fafsaRulesetStatus\(new Date\(\)\)/);
  assert.match(source, /\[BOOT\] FAFSA rules:/);
});
