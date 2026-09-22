// A lazy import() of a relative path is resolved only when its line runs, so a module
// that moves to another folder leaves the literal pointing at nothing and
// no boot, lint or static-import check notices. Two moves did exactly that:
// the route families (2026-09-16) and the server helpers (2026-09-20) kept
// "./cds-validator.js" and "./cds-ingest-pipeline.js" after those files were
// no longer beside them, which answered /api/cds/school/:slug with a 500 and
// silently switched off the live Common Data Set search in College Fit.
// Every relative dynamic import in the backend must name a file that exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", "data", "tools", "generated", "public"]);

function modules(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) modules(path.join(dir, entry.name), out);
    } else if (/\.(js|mjs)$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

test("every relative dynamic import names a file that exists", () => {
  const broken = [];
  let seen = 0;
  for (const file of modules(BACKEND)) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/\bimport\(\s*(["'`])(\.{1,2}\/[^"'`]+)\1\s*\)/g)) {
      seen += 1;
      const target = path.resolve(path.dirname(file), match[2]);
      if (!fs.existsSync(target)) broken.push(`${path.relative(BACKEND, file)} → ${match[2]}`);
    }
  }
  assert.ok(seen >= 10, `expected to find the backend's lazy imports, found ${seen}`);
  assert.deepEqual(broken, []);
});

// The revived live search must not hold a College Fit request for as long as
// a scanned document takes to read (minutes, one page at a time): the
// request waits a bounded time, the read goes on in the background.
test("valueWithin: a slow read is no longer waited for, a fast one is returned", async () => {
  const { valueWithin } = await import("../server/positioning.js");
  let finished = false;
  const slow = new Promise((resolve) => setTimeout(() => { finished = true; resolve("record"); }, 60));
  assert.equal(await valueWithin(slow, 10), null);
  assert.equal(finished, false, "the read is not cancelled, only not waited for");
  assert.equal(await slow, "record");
  assert.equal(await valueWithin(Promise.resolve("record"), 1000), "record");

  const source = fs.readFileSync(path.join(BACKEND, "server", "positioning.js"), "utf8");
  assert.match(source, /return valueWithin\(read, CDS_LIVE_WAIT_MS\);/);
});

// "consistent" is what a live read of a school with no same-cycle truth
// returns; the live search used to log it as "no CDS" and answer from the
// baseline until the next request.
test("liveIngestStored: the statuses that leave a usable record behind", async () => {
  const { liveIngestStored } = await import("../server/positioning.js");
  for (const status of ["ok", "discrepancies", "scope_mismatch", "no_truth", "consistent", "unchanged", "kept_newer"]) assert.equal(liveIngestStored(status), true, status);
  for (const status of ["inconsistent", "held_back", "parse_failed", "download_failed", "not_in_index", "non_pdf", undefined]) assert.equal(liveIngestStored(status), false, String(status));
});
