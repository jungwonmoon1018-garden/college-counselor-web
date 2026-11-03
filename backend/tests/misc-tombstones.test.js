// The 410 tombstones in server.js and the route modules must never claim the
// same path. Express answers in registration order, so a handler registered
// after a tombstone for its path never runs: on 2026-11-03 five counselor
// handlers in routes/ec-research.js (competition search, research cache
// memory, prestige read and recompute, component cache reset) had sat behind
// the tombstone for weeks, looking tested and changing nothing. The reverse
// is worse: a handler registered first silently revives a removed surface.
// The live 410 answers are pinned in misc-routes.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readServerSource } from "./helpers/server-source.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function stringsIn(text) {
  return [...text.matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
}

export function tombstonedPaths(source) {
  const paths = new Set();
  // A tombstone is an app.all over a list (or one path) whose handler
  // answers 410 before any other code runs.
  for (const match of source.matchAll(/app\.all\(\s*(\[[\s\S]*?\]|["'`][^"'`]+["'`])\s*,([\s\S]{0,400}?)\}\);/g)) {
    if (!/status\(410\)/.test(match[2])) continue;
    for (const p of stringsIn(match[1])) paths.add(p);
  }
  return paths;
}

export function handledPaths(source) {
  const found = [];
  for (const match of source.matchAll(/\b(?:app|router)\.(get|post|put|patch|delete)\(\s*(\[[^\]]*\]|["'`][^"'`]+["'`])/g)) {
    for (const p of stringsIn(match[2])) found.push({ method: match[1], path: p });
  }
  return found;
}

test("the tombstone parser finds the counselor, CDS and EC surfaces", () => {
  const tombstones = tombstonedPaths(readServerSource());
  for (const p of [
    "/api/ec/competitions/search",
    "/api/ec/cache-memory",
    "/api/ec/prestige/:activityName",
    "/api/ec/prestige/recompute",
    "/api/ec/component-cache",
    "/api/cds/canonical/:slug.xlsx",
    "/api/cds/canonical/export-all",
    "/api/audit",
    "/api/setup/status",
  ]) {
    assert.ok(tombstones.has(p), `${p} should be tombstoned`);
  }
});

test("no route module registers a path that server.js tombstones", () => {
  const source = readServerSource();
  const tombstones = tombstonedPaths(source);
  const collisions = handledPaths(source).filter((route) => tombstones.has(route.path));
  assert.deepEqual(collisions, [], `tombstoned paths with live handlers: ${JSON.stringify(collisions)}`);
});

test("the parser would catch a handler hidden behind a tombstone", () => {
  const fixture = `
app.all(["/api/old/thing", "/api/old/other"], (_req, res) => {
  res.status(410).json({ error: "gone" });
});
app.post("/api/old/thing", requireCounselorAuth, async (req, res) => {});
app.get("/api/new/thing", (req, res) => {});
`;
  const tombstones = tombstonedPaths(fixture);
  const collisions = handledPaths(fixture).filter((route) => tombstones.has(route.path));
  assert.deepEqual(collisions, [{ method: "post", path: "/api/old/thing" }]);
});

test("routes/ec-research.js registers nothing", async () => {
  const { registerEcResearchRoutes } = await import("../routes/ec-research.js");
  const registered = [];
  const app = new Proxy({}, { get: (_t, method) => (routePath) => registered.push({ method, routePath }) });
  registerEcResearchRoutes(app, {});
  assert.deepEqual(registered, []);
});

test("the CDS modules nothing imported stay deleted", () => {
  // cds-canonical-export.js served /api/cds/canonical/*, which is tombstoned,
  // and seasonal-verification-v2.js was imported only by its own test.
  for (const file of ["cds/cds-canonical-export.js", "cds/seasonal-verification-v2.js"]) {
    assert.equal(fs.existsSync(path.join(ROOT, file)), false, `${file} should not exist`);
  }
});
