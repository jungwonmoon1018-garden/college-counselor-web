// tests/cds-ingest-pipeline.test.js — guards for the scheduled CDS refresh.
// shouldRunCdsRefresh gates the daily job to June 1 onward (new CDS cycles
// publish across the summer). refreshAllCds is network-bound, so we only assert
// it's exported and callable — not run it here.

import test from "node:test";
import assert from "node:assert/strict";
import { shouldRunCdsRefresh, refreshAllCds } from "../cds-ingest-pipeline.js";

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
  const { isOlderCycle } = await import("../cds-ingest-pipeline.js");
  assert.equal(isOlderCycle("2024-25", "2025-26"), true);
  assert.equal(isOlderCycle("2023-24", "2025-26"), true);
  assert.equal(isOlderCycle("2025-26", "2025-26"), false);
  assert.equal(isOlderCycle("2026-27", "2025-26"), false);
  assert.equal(isOlderCycle("2024-25", null), false);
  assert.equal(isOlderCycle(null, "2025-26"), false);
});
