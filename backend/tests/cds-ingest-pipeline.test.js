// tests/cds-ingest-pipeline.test.js — guards for the scheduled CDS refresh.
// shouldRunCdsRefresh gates the daily job to June 1 onward (new CDS cycles
// publish across the summer). refreshAllCds is network-bound, so we only assert
// it's exported and callable — not run it here.

import test from "node:test";
import assert from "node:assert/strict";
import { shouldRunCdsRefresh, refreshAllCds } from "../cds/cds-ingest-pipeline.js";

test("shouldRunCdsRefresh: idle Jan–May, active Jun–Dec", () => {
  const at = (iso) => shouldRunCdsRefresh(Date.parse(iso));
  assert.equal(at("2026-01-15T12:00:00Z"), false, "January → idle");
  assert.equal(at("2026-05-31T12:00:00Z"), false, "May 31 → idle");
  assert.equal(at("2026-06-01T12:00:00Z"), true,  "June 1 → active");
  assert.equal(at("2026-08-20T12:00:00Z"), true,  "August → active");
  assert.equal(at("2026-12-15T12:00:00Z"), true,  "December → active");
});

test("refreshAllCds is exported as an async function", () => {
  assert.equal(typeof refreshAllCds, "function");
});

test("isOlderCycle: a fallback download from an earlier cycle must not replace a newer stored record", async () => {
  const { isOlderCycle } = await import("../cds/cds-ingest-pipeline.js");
  assert.equal(isOlderCycle("2024-25", "2025-26"), true);
  assert.equal(isOlderCycle("2023-24", "2025-26"), true);
  assert.equal(isOlderCycle("2025-26", "2025-26"), false);
  assert.equal(isOlderCycle("2026-27", "2025-26"), false);
  assert.equal(isOlderCycle("2024-25", null), false);
  assert.equal(isOlderCycle(null, "2025-26"), false);
});

test("refreshHoldReasons: a parse that thins the stored record is held back, a fuller or equal one is not", async () => {
  const { refreshHoldReasons } = await import("../cds/cds-ingest-pipeline.js");
  const stored = { yearLabel: "2025-26", overallAdmitRate: 0.061, enrolledSAT: { p25: 1530, p75: 1565 }, enrolledACT: { p25: 34, p75: 35 }, b1: { applied: 50259, admitted: 3072 }, c7: { rigor: "very_important", interview: "not_considered" } };
  assert.deepEqual(refreshHoldReasons(null, { overallAdmitRate: null }), []);
  assert.deepEqual(refreshHoldReasons(stored, { ...stored }), []);
  assert.deepEqual(refreshHoldReasons(stored, { ...stored, yearLabel: "2026-27", overallAdmitRate: 0.058 }), []);
  assert.deepEqual(
    refreshHoldReasons(stored, { yearLabel: "2025-26", overallAdmitRate: null, enrolledSAT: null, b1: null, c7: { rigor: "not_considered" } }),
    ["admit rate lost", "SAT band lost", "ACT band lost", "C1 counts lost", "C7 weights lost"],
  );
  assert.deepEqual(refreshHoldReasons(stored, { ...stored, overallAdmitRate: 0.5 }), ["admit rate moved 6.1% → 50.0% within 2025-26"]);
  // A new cycle may legitimately move the rate; only a thinner record is held.
  assert.deepEqual(refreshHoldReasons(stored, { ...stored, yearLabel: "2026-27", overallAdmitRate: 0.5 }), []);
});

// Memory, measured on 2026-09-21: the daily refresh re-parsed every cached
// document of the 329-school index, three at a time, and a scanned one
// rasterizes 25 pages. What follows keeps that work small and bounded.
test("cachedParseIsCurrent: a cached document the store already carries is not parsed again", async () => {
  const { cachedParseIsCurrent } = await import("../cds/cds-ingest-pipeline.js");
  const { CDS_PARSER_VERSION } = await import("../cds/cds-pdf-parser.js");
  const stored = { year_label: "2025-26", parser_version: CDS_PARSER_VERSION };
  assert.equal(cachedParseIsCurrent(stored, { fromCache: true, year: "2025-26" }), true);
  // A fresh download, a new cycle, an older parser or no stored row all parse.
  assert.equal(cachedParseIsCurrent(stored, { fromCache: false, year: "2025-26" }), false);
  assert.equal(cachedParseIsCurrent(stored, { fromCache: true, year: "2026-27" }), false);
  assert.equal(cachedParseIsCurrent({ ...stored, parser_version: CDS_PARSER_VERSION - 1 }, { fromCache: true, year: "2025-26" }), false);
  assert.equal(cachedParseIsCurrent({ ...stored, parser_version: null }, { fromCache: true, year: "2025-26" }), false);
  assert.equal(cachedParseIsCurrent(null, { fromCache: true, year: "2025-26" }), false);
});

test("parseInLane: documents are parsed one at a time, and a failed parse frees the lane", async () => {
  const { parseInLane } = await import("../cds/cds-ingest-pipeline.js");
  let running = 0;
  let most = 0;
  const parse = (result) => async () => {
    running += 1;
    most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    if (result instanceof Error) throw result;
    return result;
  };
  const results = await Promise.allSettled([parseInLane(parse("a")), parseInLane(parse(new Error("bad pdf"))), parseInLane(parse("c"))]);
  assert.equal(most, 1);
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "rejected", "fulfilled"]);
  assert.equal(results[2].value, "c");
});

test("readBodyCapped: a download larger than the ceiling is refused, declared or not", async () => {
  const { readBodyCapped } = await import("../cds/cds-ingest-pipeline.js");
  const body = (bytes) => new Response(new Uint8Array(bytes));
  assert.equal((await readBodyCapped(body(1000), 4096)).length, 1000);
  await assert.rejects(readBodyCapped(body(5000), 4096), /larger than/);
  const declared = new Response(new Uint8Array(10), { headers: { "content-length": "999999" } });
  await assert.rejects(readBodyCapped(declared, 4096), /larger than/);
  // A stub without a readable stream (the tests' fetch doubles) still works.
  const stub = { headers: { get: () => null }, arrayBuffer: async () => new Uint8Array(12).buffer };
  assert.equal((await readBodyCapped(stub, 4096)).length, 12);
});
