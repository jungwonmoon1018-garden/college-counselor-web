// Tests that read the date must pass on any date. The FAFSA tests called
// the rules engine on the real clock, so on 2027-07-01, the day the only
// reviewed ruleset lapsed, four unit tests and a route test would have
// failed and CI, which gates every Render deploy, would have stayed red
// (safety fixes included) until someone edited the tests. The bulk deadline
// test added 365 days to an August 1 and, across a leap day, stayed in the
// same cycle on 2027-06-22. Each file here runs again with the clock moved
// to the dates that broke something (tests/helpers/fixed-clock.mjs moves it
// in the test process and in a route test's spawned server alike).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "..");
const CLOCK = pathToFileURL(path.join(__dirname, "helpers", "fixed-clock.mjs")).href;

// The planning cycle turns on Feb 1; a cycle's last possible deadline is
// Jul 31 and its first Aug 1; the 2026-27 FAFSA ruleset lapses after Jun 30;
// Jun 22 is the Anywhere-on-Earth day whose "40 days out" is Aug 1 of the
// year before a leap year.
const DATES = ["2027-02-01T12:00:00Z", "2027-06-22T13:00:00Z", "2027-07-02T12:00:00Z", "2027-08-01T12:00:00Z"];

function runTests(args, fixedNow) {
  const env = { ...process.env, FIXED_NOW: fixedNow, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import=${CLOCK}`.trim() };
  // A nested runner that inherits the parent's test context reports to the
  // parent instead of running on its own.
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", "--test-reporter=spec", ...args], { cwd: BACKEND_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, output }));
  });
}

test("the helper moves the clock in the test process", async () => {
  const probe = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", CLOCK, "-e", "process.stdout.write(JSON.stringify([new Date().toISOString(), new Date(Date.now()).toISOString(), typeof Date(), new Date(0) instanceof Date, new Date('2020-01-01T00:00:00Z').toISOString()]))"], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, FIXED_NOW: "2027-07-02T12:00:00Z" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.once("error", reject);
    child.once("exit", () => resolve(JSON.parse(out)));
  });
  assert.match(probe[0], /^2027-07-02T12:0/);
  assert.match(probe[1], /^2027-07-02T12:0/);
  assert.equal(probe[2], "string");
  assert.equal(probe[3], true);
  assert.equal(probe[4], "2020-01-01T00:00:00.000Z");
});

for (const fixedNow of DATES) {
  test(`the FAFSA unit tests pass on ${fixedNow.slice(0, 10)}`, { timeout: 120_000 }, async () => {
    const { code, output } = await runTests([
      "tests/rules-engine.test.js",
      "tests/answer-composer.test.js",
      "tests/backendglue-fafsa-guidance.test.js",
    ], fixedNow);
    assert.equal(code, 0, output);
  });
}

// One boot per date: the route test's server runs on the moved clock too.
for (const fixedNow of ["2027-06-22T13:00:00Z", "2027-07-02T12:00:00Z"]) {
  test(`the FAFSA and bulk deadline route tests pass on ${fixedNow.slice(0, 10)}`, { timeout: 240_000 }, async () => {
    const { code, output } = await runTests([
      "--test-name-pattern=FAFSA checklist|bulk deadlines skip past items",
      "tests/council-naming-deadlines-routes.test.js",
    ], fixedNow);
    assert.equal(code, 0, output);
    // A name pattern that matched nothing would also exit 0.
    assert.match(output, /pass 2\b/, output);
  });
}
