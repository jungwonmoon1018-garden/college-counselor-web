import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initFactStore, prepareFactStatements } from "../fact-store.js";
import {
  initPolicyScout,
  preparePolicyScoutStatements,
  runPolicyScout,
  extractPolicyFromPages,
  extractTestPolicy,
  diffPolicies,
  parseRobots,
  robotsAllows,
  resolveCycleDate,
  readPolicySnapshot,
  snapshotAsDeadlineRecord,
  formatPolicyLine,
  listRecentChanges,
  lastRunSummary,
} from "../admissions-policy-scout.js";

const NOW = new Date("2026-09-03T12:00:00Z"); // cycle 2026-27 → entering fall 2027

const HOMEPAGE = `<html><body>
<h1>Example University</h1>
<p>Welcome to Example University, a residential liberal arts college on the coast of Maine with a long tradition of undergraduate research, close faculty mentorship, and community engagement across every department.</p>
<nav>
  <a href="/admission/first-year">First-Year Admission</a>
  <a href="/private/deadlines">Internal deadlines</a>
  <a href="https://elsewhere.com/admission">Partner admission page</a>
  <a href="/athletics">Athletics</a>
</nav>
</body></html>`;

const POLICY_V1 = `<html><body>
<h1>First-Year Applicants</h1>
<p>Testing policy: Example University is test-optional for first-year applicants through the fall 2027 entering class. Students may choose whether to submit SAT or ACT scores, and no student is disadvantaged for not submitting.</p>
<h2>Deadlines</h2>
<table>
<tr><td>Early Decision I</td><td>November 1</td></tr>
<tr><td>Early Decision II</td><td>January 5</td></tr>
<tr><td>Regular Decision</td><td>January 15</td></tr>
</table>
<p>The application fee is $75; fee waivers are available to any student for whom the fee is a hardship.</p>
</body></html>`;

const POLICY_V2 = POLICY_V1
  .replace(/Testing policy:[^<]+/, "Testing policy: Beginning with the fall 2027 entering class, SAT or ACT scores are required for all first-year applicants. ")
  .replace("<td>November 1</td>", "<td>November 15</td>");

function makeSite(policyHtml) {
  const site = new Map([
    ["https://example-university.edu/robots.txt", { type: "text/plain", body: "User-agent: *\nDisallow: /private\n" }],
    ["https://example-university.edu", { type: "text/html", body: HOMEPAGE }],
    ["https://example-university.edu/admission/first-year", { type: "text/html", body: policyHtml }],
    ["https://example-university.edu/private/deadlines", { type: "text/html", body: "<p>SECRET: Early Decision December 25</p>".repeat(8) }],
  ]);
  const requested = [];
  const fetchImpl = async (url) => {
    const key = String(url).replace(/\/+$/, "");
    requested.push(key);
    const entry = site.get(key);
    if (!entry) return { ok: false, status: 404, url, headers: new Headers(), text: async () => "" };
    return { ok: true, status: 200, url, headers: new Headers({ "content-type": entry.type }), text: async () => entry.body };
  };
  return { fetchImpl, requested };
}

function freshStores() {
  const db = new Database(":memory:");
  initFactStore(db);
  initPolicyScout(db);
  return { db, factStmts: prepareFactStatements(db), stmts: preparePolicyScoutStatements(db) };
}

const scoutOptions = (stores, fetchImpl) => ({
  stmts: stores.stmts,
  factStmts: stores.factStmts,
  fetchImpl,
  assertTarget: async () => {},
  sleep: async () => {},
  now: () => NOW,
});

test("robots.txt groups and longest-match rules are honored", () => {
  const groups = parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/open\n\nUser-agent: CollegeCounselorBot\nDisallow: /bot-only\n");
  assert.equal(robotsAllows(groups, "/admission"), true);
  assert.equal(robotsAllows(groups, "/bot-only/page"), false);
  assert.equal(robotsAllows(groups, "/private/deadlines"), true); // our own group wins over "*"
  assert.equal(robotsAllows(groups, "/private/deadlines", "othercrawler"), false);
  assert.equal(robotsAllows(groups, "/private/open/page", "othercrawler"), true);
  assert.equal(robotsAllows([], "/anything"), true);
});

test("cycle dates resolve month/day into the admissions cycle in progress", () => {
  assert.equal(resolveCycleDate(11, 1, null, NOW), "2026-11-01");
  assert.equal(resolveCycleDate(1, 15, null, NOW), "2027-01-15");
  assert.equal(resolveCycleDate(1, 15, 2027, NOW), "2027-01-15");
  assert.equal(resolveCycleDate(1, 15, 2020, NOW), null); // far in the past
  assert.equal(resolveCycleDate(13, 1, null, NOW), null);
});

test("policy extraction reads test policy, plan deadlines, and the fee from official text", () => {
  const pages = [{ url: "https://example-university.edu/admission/first-year", text: htmlText(POLICY_V1) }];
  const policy = extractPolicyFromPages(pages, NOW);
  assert.equal(policy.cycle, "2026-27");
  assert.equal(policy.testPolicy.value, "test_optional");
  assert.equal(policy.testPolicy.through, "2027");
  assert.match(policy.testPolicy.evidence, /test-optional for first-year applicants/);
  assert.equal(policy.deadlines.early_decision.date, "2026-11-01");
  assert.equal(policy.deadlines.early_decision_2.date, "2027-01-05");
  assert.equal(policy.deadlines.regular_decision.date, "2027-01-15");
  assert.equal(policy.deadlines.early_action, undefined);
  assert.equal(policy.applicationFee.amount, 75);

  // "not required" must never read as a testing requirement, and the sentence
  // about the entering cycle outranks a stale one about a past cycle.
  const stale = [{ url: "u", text: "For fall 2024 applicants, SAT scores were required. SAT and ACT scores are not required for the fall 2027 entering class." }];
  assert.equal(extractTestPolicy(stale, NOW).value, "test_optional");
  const blind = [{ url: "u", text: "Example is test-blind: we will not consider SAT or ACT scores in admission decisions." }];
  assert.equal(extractTestPolicy(blind, NOW).value, "test_blind");
  assert.equal(extractTestPolicy([{ url: "u", text: "Our campus has a lake." }], NOW), null);
});

test("diffing ignores fields that merely dropped out of the fetched pages", () => {
  const before = { testPolicy: { value: "test_optional" }, deadlines: { early_decision: { date: "2026-11-01" } }, applicationFee: { amount: 75 } };
  const after = { testPolicy: { value: "test_required" }, deadlines: { early_decision: { date: "2026-11-01" } }, applicationFee: null };
  const changes = diffPolicies(before, after);
  assert.deepEqual(changes.map((c) => [c.field, c.previousValue, c.newValue, c.severity]), [
    ["test_policy", "test-optional", "test scores required", "high"],
  ]);
});

test("a scout run snapshots a school, writes verified facts, and logs changes on the next visit", async () => {
  const stores = freshStores();
  const v1 = makeSite(POLICY_V1);
  const first = await runPolicyScout(
    [{ name: "Example University", website: "https://example-university.edu" }],
    scoutOptions(stores, v1.fetchImpl),
  );
  assert.equal(first.total, 1);
  assert.equal(first.checked, 1);
  assert.equal(first.changes, 0);
  // Same-site policy page fetched; robots-disallowed and off-site links never
  // requested.
  assert.ok(v1.requested.includes("https://example-university.edu/admission/first-year"));
  assert.ok(!v1.requested.includes("https://example-university.edu/private/deadlines"));
  assert.ok(!v1.requested.some((u) => u.includes("elsewhere.com")));

  const facts = stores.factStmts.getFactsByEntity.all("university", "example-university");
  const byKey = Object.fromEntries(facts.map((f) => [f.fact_key, f]));
  assert.equal(byKey.test_policy.fact_value, "test-optional (through 2027)");
  assert.equal(byKey.deadline_early_decision.fact_value, "2026-11-01");
  assert.equal(byKey.deadline_regular_decision.fact_value, "2027-01-15");
  assert.equal(byKey.application_fee.fact_value, "75 USD");
  assert.equal(byKey.test_policy.confidence, "verified");
  assert.equal(byKey.test_policy.source_domain, "example-university.edu");
  assert.equal(byKey.test_policy.academic_year, "2026-27");
  assert.equal(byKey.test_policy.expires_at, "2027-08-01T00:00:00.000Z");

  const snapshot = readPolicySnapshot(stores.stmts, { name: "Example University" });
  assert.equal(snapshot.school, "Example University");
  assert.equal(snapshot.checkedAt, NOW.toISOString());
  assert.equal(snapshot.changedAt, NOW.toISOString());
  assert.match(formatPolicyLine(snapshot), /^Admissions policy \(official site, checked 2026-09-03\): test policy — test-optional \(through 2027\); Early Decision deadline 2026-11-01; Early Decision II deadline 2027-01-05; Regular Decision deadline 2027-01-15; application fee 75 USD \[Source: https:\/\/example-university\.edu\/admission\/first-year\]$/);
  assert.deepEqual(snapshotAsDeadlineRecord(snapshot).deadlines, { ea: null, ed: "2026-11-01", rd: "2027-01-15", financialAid: null, commitBy: null, decisionRelease: null });

  // The policy page changes: testing becomes required, ED moves to Nov 15.
  const later = new Date("2026-09-04T12:00:00Z");
  const v2 = makeSite(POLICY_V2);
  const second = await runPolicyScout(
    [{ name: "Example University", website: "https://example-university.edu" }],
    { ...scoutOptions(stores, v2.fetchImpl), now: () => later, trigger: "manual" },
  );
  assert.equal(second.checked, 1);
  assert.equal(second.changes, 2);
  const changes = listRecentChanges(stores.stmts, { days: 30 });
  assert.deepEqual(
    changes.map((c) => [c.label, c.previousValue, c.newValue, c.severity]).sort(),
    [
      ["Early Decision deadline", "2026-11-01", "2026-11-15", "high"],
      ["Testing policy", "test-optional (through 2027)", "test scores required", "high"],
    ],
  );
  const updated = stores.factStmts.getFactsByEntity.all("university", "example-university");
  assert.equal(updated.find((f) => f.fact_key === "test_policy").fact_value, "test scores required");
  assert.equal(updated.find((f) => f.fact_key === "deadline_early_decision").fact_value, "2026-11-15");
  assert.equal(readPolicySnapshot(stores.stmts, { name: "Example University" }).changedAt, later.toISOString());

  const run = lastRunSummary(stores.stmts);
  assert.equal(run.trigger, "manual");
  assert.equal(run.schoolsChecked, 1);
  assert.equal(run.changes, 2);
});

test("a school whose site cannot be resolved or read is reported, not invented", async () => {
  const stores = freshStores();
  const { fetchImpl } = makeSite(POLICY_V1);
  const summary = await runPolicyScout(
    [{ name: "Nowhere University" }, { name: "Blocked College", website: "https://blocked.example.edu" }],
    scoutOptions(stores, fetchImpl),
  );
  assert.equal(summary.checked, 0);
  assert.deepEqual(summary.failures.map((f) => f.reason).sort(), ["no_pages", "site_unresolved"]);
  assert.equal(stores.factStmts.getFactsByTopic.all("school_policies").length, 0);
});

function htmlText(html) {
  return html
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}
