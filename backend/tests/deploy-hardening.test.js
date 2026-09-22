// The 2026-09-22 deploy checklist found three things a hosted instance must
// not do: parse a 20 MB JSON body for anyone on any path, fetch a repository
// link without the SSRF guard, and download OCR language data into the
// working directory (ephemeral on the host) after every deploy. These pin
// the fixes; the guard itself is exercised in cds-search.test.js and the
// body limits by real requests in endpoints.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readServerSource } from "./helpers/server-source.mjs";
import { ocrCacheDir } from "../shared/file-extractors.js";

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("JSON bodies: 1 MB on every route, 10 MB on the three file routes after the session check", () => {
  const source = readServerSource();
  assert.ok(source.includes('express.json({ limit: "1mb" })'), "the small parser");
  assert.ok(source.includes('express.json({ limit: "10mb" })'), "the large parser");
  assert.ok(!source.includes('"20mb"'), "the old 20 MB parser is gone");
  for (const route of ["/api/chat", "/api/files/extract-text", "/api/students/transcript-import"]) {
    assert.ok(source.includes(`"${route}"`), `${route} is named`);
    const line = source.split("\n").find((l) => l.includes(`app.post("${route}"`));
    assert.ok(line, `${route} route`);
    assert.match(line, /requireStudentAuth, parseLargeJsonBody, async/, `${route} parses its body after the session check`);
  }
});

test("OCR language data is cached under the data directory, not beside server.js", () => {
  const dir = path.join(os.tmpdir(), `tessdata-${process.pid}-${Date.now()}`);
  process.env.TESSDATA_CACHE_DIR = dir;
  try {
    assert.equal(ocrCacheDir(), dir);
    assert.ok(fs.existsSync(dir), "the directory is created");
  } finally {
    delete process.env.TESSDATA_CACHE_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const extractors = fs.readFileSync(path.join(BACKEND, "shared", "file-extractors.js"), "utf8");
  assert.ok(extractors.includes("cachePath: ocrCacheDir()"), "the worker is given the cache path");
  for (const ignore of [path.join(BACKEND, ".gitignore"), path.join(BACKEND, "..", ".gitignore")]) {
    assert.match(fs.readFileSync(ignore, "utf8"), /^\*\.traineddata$/m, `${ignore} ignores the cache files`);
  }
});

test("the CDS read routes log exception text instead of sending it to the client", () => {
  const text = fs.readFileSync(path.join(BACKEND, "routes", "cds.js"), "utf8");
  assert.ok(!text.includes("message: String(e.message)"));
});

test("every fetch of a URL that is not a constant goes through the guard", () => {
  // cds-search.js reads repository links, college-research.js official
  // pages, the policy scout admissions pages, the pipeline the documents.
  for (const rel of ["cds/cds-search.js", "colleges/college-research.js", "scouts/policy-scout-fetch.js", "cds/cds-ingest-pipeline.js"]) {
    const text = fs.readFileSync(path.join(BACKEND, rel), "utf8");
    assert.ok(/safeFetch\(|assertTarget\(|assertSafeFetchTarget\(/.test(text), `${rel} uses the guard`);
  }
  const search = fs.readFileSync(path.join(BACKEND, "cds", "cds-search.js"), "utf8");
  assert.ok(!/fetchImpl\(url, \{[^}]*redirect: "follow"/s.test(search), "the repository link is no longer fetched plainly");
});
