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
  rankedPolicyLinks,
  schoolRootHost,
  schoolDomainToken,
  readPolicySnapshot,
  snapshotAsDeadlineRecord,
  formatPolicyLine,
  listRecentChanges,
  lastRunSummary,
} from "../admissions-policy-scout.js";

const NOW = new Date("2026-09-03T12:00:00Z"); // cycle 2026-27 → entering fall 2027

// exampleu.edu runs its admissions office on exampleuadmissions.org (as MIT
// does on mitadmissions.org); the deadlines page is on the main site.
const HOMEPAGE = `<html><body>
<h1>Example University</h1>
<p>Welcome to Example University, a residential liberal arts college on the coast of Maine with a long tradition of undergraduate research, close faculty mentorship, and community engagement across every department.</p>
<nav>
  <a href="/admission/first-year">First-Year Admission</a>
  <a href="https://exampleuadmissions.org/apply/">Office of Undergraduate Admissions</a>
  <a href="/private/deadlines">Internal deadlines</a>
  <a href="https://elsewhere.com/admission">Partner admission page</a>
  <a href="/athletics">Athletics</a>
  <a href="/news">Campus news and events for the whole community</a>
</nav>
</body></html>`;

const FIRST_YEAR = `<html><body>
<h1>First-Year Applicants</h1>
<p>Everything you need to apply to Example University as a first-year student, from the application itself to what we look for and how we read your file with care and context.</p>
<h2>Deadlines</h2>
<table>
<tr><td>Early Decision I</td><td>November 1</td></tr>
<tr><td>Early Decision II</td><td>January 5</td></tr>
<tr><td>Regular Decision</td><td>January 15</td></tr>
</table>
<p>The application fee is $75; fee waivers are available to any student for whom the fee is a hardship.</p>
</body></html>`;

const ADMISSIONS_LANDING = `<html><body>
<h1>Apply to Example University</h1>
<p>Our admissions office reads every application in context. Start with the process overview, then review what first-year applicants need to submit, including our standardized testing policy and interview options.</p>
<a href="/apply/process/">Understanding the process</a>
<a href="/apply/firstyear/tests-scores/">standardized tests</a>
<a href="/blogs/">Blogs</a>
</body></html>`;

const TESTS_V1 = `<html><body>
<h1>Tests & scores</h1>
<p>Testing policy: Example University is test-optional for first-year applicants through the fall 2027 entering class. Students may choose whether to submit SAT or ACT scores, and no student is disadvantaged for not submitting.</p>
</body></html>`;

const TESTS_V2 = TESTS_V1.replace(/Testing policy:[^<]+/, "Testing policy: Beginning with the fall 2027 entering class, SAT or ACT scores are required for all first-year applicants. ");
const FIRST_YEAR_V2 = FIRST_YEAR.replace("<td>November 1</td>", "<td>November 15</td>");

function makeSite({ firstYear = FIRST_YEAR, tests = TESTS_V1 } = {}) {
  const site = new Map([
    ["https://exampleu.edu/robots.txt", { type: "text/plain", body: "User-agent: *\nDisallow: /private\n" }],
    ["https://exampleu.edu", { type: "text/html", body: HOMEPAGE }],
    // Both admissions subdomains land on one page — must be counted once.
    ["https://admission.exampleu.edu", { type: "text/html", body: HOMEPAGE, finalUrl: "https://admission.exampleu.edu/" }],
    ["https://admissions.exampleu.edu", { type: "text/html", body: HOMEPAGE, finalUrl: "https://admission.exampleu.edu/" }],
    ["https://exampleu.edu/admission/first-year", { type: "text/html", body: firstYear }],
    ["https://exampleu.edu/private/deadlines", { type: "text/html", body: "<p>SECRET: Early Decision December 25</p>".repeat(8) }],
    ["https://exampleuadmissions.org/robots.txt", { type: "text/plain", body: "User-agent: *\nDisallow:\n" }],
    ["https://exampleuadmissions.org/apply", { type: "text/html", body: ADMISSIONS_LANDING }],
    ["https://exampleuadmissions.org/apply/firstyear/tests-scores", { type: "text/html", body: tests }],
  ]);
  const requested = [];
  const fetchImpl = async (url) => {
    const key = String(url).replace(/\/+$/, "");
    requested.push(key);
    const entry = site.get(key);
    if (!entry) return { ok: false, status: 404, url, headers: new Headers(), text: async () => "" };
    return { ok: true, status: 200, url: entry.finalUrl || url, headers: new Headers({ "content-type": entry.type }), text: async () => entry.body };
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

const TARGET = { name: "Example University", website: "https://exampleu.edu" };

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

test("the school's domain token comes from the registrable domain, not a deep homepage host", () => {
  // Scorecard reports MIT's site as web.mit.edu; the token must still be "mit"
  // so mitadmissions.org is recognized and admission.mit.edu is probed.
  assert.equal(schoolRootHost("web.mit.edu"), "mit.edu");
  assert.equal(schoolDomainToken("web.mit.edu"), "mit");
  assert.equal(schoolRootHost("www.stanford.edu"), "stanford.edu");
  assert.equal(schoolDomainToken("exampleu.edu"), "exampleu");
  assert.equal(schoolDomainToken("home.admissions.example-college.edu"), "example-college");
});

test("links are ranked by their path and anchor, not by an admissions hostname", () => {
  const html = `
    <a href="https://admission.exampleu.edu/plan/">Plan a visit</a>
    <a href="https://admission.exampleu.edu/apply/first-year">Application Requirements</a>
    <a href="https://admission.exampleu.edu/apply/first-year/testing/">Standardized testing</a>
    <a href="https://admission.exampleu.edu/brochure.pdf">Deadlines brochure</a>
    <a href="https://exampleuadmissions.org/apply/">Office of Undergraduate Admissions</a>
    <a href="https://elsewhere.com/apply">Apply elsewhere</a>
    <a href="mailto:admission@exampleu.edu">Email</a>`;
  const ranked = rankedPolicyLinks(html, "https://admission.exampleu.edu/", { domainToken: "exampleu" });
  assert.deepEqual(ranked.map((l) => [l.url, l.offSite]), [
    ["https://admission.exampleu.edu/apply/first-year/testing/", false],
    ["https://admission.exampleu.edu/apply/first-year", false],
    ["https://exampleuadmissions.org/apply/", true],
  ]);
  // Without the school's domain token, no off-site host is ever followed.
  assert.ok(!rankedPolicyLinks(html, "https://admission.exampleu.edu/").some((l) => l.offSite));
});

test("policy extraction reads test policy, plan deadlines, and the fee from official text", () => {
  const pages = [
    { url: "https://exampleu.edu/admission/first-year", text: htmlText(FIRST_YEAR) },
    { url: "https://exampleuadmissions.org/apply/firstyear/tests-scores/", text: htmlText(TESTS_V1) },
  ];
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

// Line sequences copied from the real Stanford and MIT first-year pages
// (September 2026): plan names as headings with dates on later lines,
// portfolio sub-blocks, prose with "due", and a component table.
const STANFORD_LINES = `Application Deadlines
Submit your Common Application by 11:59 p.m. (in your local timezone) on the listed date. Click below to view details.
Restrictive Early Action
Application with Optional Arts Portfolio - October 15
Common Application Deadline: October 15
Arts Portfolio Materials Deadline: October 20
Notification of Missing Documents: by mid-November
Decision Released: by mid-December
Student Reply Date: May 1
Please note: If you intend to submit an REA application with an Optional Arts Portfolio , you must submit the Common Application by October 15.
Your transcripts), School Report, and teacher/counselor letters of recommendation, can be submitted by November 1.
Standard Application Deadline - November 1
Common Application Deadline: November 1
Notification of Missing Documents: by mid-November
Decision Released: by mid-December
Regular Decision
Application with Optional Arts Portfolio - December 5
Common Application Deadline: December 5
Arts Portfolio Materials Deadline: December 10
Please note: If you intend to submit an RD application with an Optional Arts Portfolio , you must submit the Common Application by December 5.
Standard Application Deadline - January 5
Common Application Deadline: January 5
$100 nonrefundable application fee or fee waiver request
ACT or SAT test scores`;

const MIT_LINES = `First-year applicants: Deadlines & requirements
Standardized tests : We require the SAT or ACT. Applicants must take required tests before November 30 for EA, and before December 31 for RA.
Application fee of $75 (or fee waiver )
Deadlines
Early Action (EA) applications are due November 1 and admission decisions are released in mid-December.
Regular Action (RA) applications are due January 4 and admission decisions are released in mid-March.
Financial aid applications are managed separately from admissions applications, and are due November 30 for EA applicants and February 15 for RA applicants.
EA Deadline
RA Deadline
Application Component
November 1
January 4
MIT first-year application form and fee (or waiver )
Optional: Creative portfolios
November 1*
January 4*`;

test("deadline extraction handles real page layouts: headed sections with portfolio sub-blocks, and 'due' prose", () => {
  const stanford = extractPolicyFromPages([{ url: "https://admission.stanford.edu/apply/first-year/", text: STANFORD_LINES }], NOW);
  assert.equal(stanford.deadlines.restrictive_early_action.date, "2026-11-01", JSON.stringify(stanford.deadlines));
  assert.equal(stanford.deadlines.regular_decision.date, "2027-01-05");
  assert.match(stanford.deadlines.restrictive_early_action.evidence, /Standard Application Deadline - November 1/);
  assert.equal(stanford.deadlines.early_action, undefined);
  assert.equal(stanford.applicationFee.amount, 100);

  const stanfordRecord = snapshotAsDeadlineRecord({ school: "Stanford University", slug: "stanford-university", checkedAt: NOW.toISOString(), policy: stanford });
  assert.equal(stanfordRecord.deadlines.ea, "2026-11-01");
  assert.deepEqual(stanfordRecord.labels, { ea: "Restrictive Early Action" });

  const mit = extractPolicyFromPages([{ url: "https://mitadmissions.org/apply/firstyear/deadlines-requirements/", text: MIT_LINES }], NOW);
  assert.equal(mit.deadlines.early_action.date, "2026-11-01", JSON.stringify(mit.deadlines));
  assert.deepEqual(snapshotAsDeadlineRecord({ school: "MIT", slug: "mit", checkedAt: NOW.toISOString(), policy: mit }).labels, { rd: "Regular Action" });
  assert.equal(mit.deadlines.regular_decision.date, "2027-01-04");
  assert.equal(mit.deadlines.early_decision, undefined);
  assert.equal(mit.applicationFee.amount, 75);
  assert.equal(mit.testPolicy.value, "test_required");
  assert.match(mit.testPolicy.evidence, /We require the SAT or ACT/);
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
  const v1 = makeSite();
  const first = await runPolicyScout([TARGET], scoutOptions(stores, v1.fetchImpl));
  assert.equal(first.total, 1);
  assert.equal(first.checked, 1);
  assert.equal(first.changes, 0);
  // Same-site policy page and the school's off-site admissions host fetched;
  // robots-disallowed and unrelated off-site links never requested.
  assert.ok(v1.requested.includes("https://exampleu.edu/admission/first-year"));
  assert.ok(v1.requested.includes("https://exampleuadmissions.org/apply/firstyear/tests-scores"));
  assert.ok(!v1.requested.includes("https://exampleu.edu/private/deadlines"));
  assert.ok(!v1.requested.some((u) => u.includes("elsewhere.com")));
  const pagesFetched = JSON.parse(stores.stmts.getSnapshot.get("example-university").pages_json);
  assert.equal(new Set(pagesFetched).size, pagesFetched.length, "pages are de-duplicated by their final URL");
  assert.equal(pagesFetched.filter((u) => u.startsWith("https://admission.exampleu.edu")).length, 1);

  const facts = stores.factStmts.getFactsByEntity.all("university", "example-university");
  const byKey = Object.fromEntries(facts.map((f) => [f.fact_key, f]));
  assert.equal(byKey.test_policy.fact_value, "test-optional (through 2027)");
  assert.equal(byKey.test_policy.source_domain, "exampleuadmissions.org");
  assert.equal(byKey.deadline_early_decision.fact_value, "2026-11-01");
  assert.equal(byKey.deadline_early_decision.source_domain, "exampleu.edu");
  assert.equal(byKey.deadline_regular_decision.fact_value, "2027-01-15");
  assert.equal(byKey.application_fee.fact_value, "75 USD");
  assert.equal(byKey.test_policy.confidence, "verified");
  assert.equal(byKey.test_policy.academic_year, "2026-27");
  assert.equal(byKey.test_policy.expires_at, "2027-08-01T00:00:00.000Z");

  const snapshot = readPolicySnapshot(stores.stmts, { name: "Example University" });
  assert.equal(snapshot.school, "Example University");
  assert.equal(snapshot.checkedAt, NOW.toISOString());
  assert.equal(snapshot.changedAt, NOW.toISOString());
  assert.match(formatPolicyLine(snapshot), /^Admissions policy \(official site, checked 2026-09-03\): test policy — test-optional \(through 2027\); Early Decision deadline 2026-11-01; Early Decision II deadline 2027-01-05; Regular Decision deadline 2027-01-15; application fee 75 USD \[Source: https:\/\/exampleuadmissions\.org\/apply\/firstyear\/tests-scores\/ ; https:\/\/exampleu\.edu\/admission\/first-year\]$/);
  assert.deepEqual(snapshotAsDeadlineRecord(snapshot).deadlines, { ea: null, ed: "2026-11-01", rd: "2027-01-15", financialAid: null, commitBy: null, decisionRelease: null });

  // The pages change: testing becomes required, ED moves to Nov 15.
  const later = new Date("2026-09-04T12:00:00Z");
  const v2 = makeSite({ firstYear: FIRST_YEAR_V2, tests: TESTS_V2 });
  const second = await runPolicyScout([TARGET], { ...scoutOptions(stores, v2.fetchImpl), now: () => later, trigger: "manual" });
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

test("schema init removes first-population 'changes' logged by scout versions before 3", () => {
  const { db, stmts } = freshStores();
  // A v2 run that filled empty snapshots and logged every field as a change…
  stmts.insertRun.run("run-v2", "2026-09-03T03:26:55.000Z", "boot", 60, JSON.stringify({ scoutVersion: 2 }));
  stmts.finishRun.run("2026-09-03T03:34:13.000Z", 44, 8, 92, JSON.stringify({ scoutVersion: 2 }), "run-v2");
  stmts.insertChange.run("c1", "stanford-university", "Stanford University", "2026-09-03T03:26:55.424Z", "test_policy", null, "test scores required", "https://admission.stanford.edu/", "high");
  // …a real change from that run, and a genuine later addition (v3, other fields already known).
  stmts.insertChange.run("c2", "stanford-university", "Stanford University", "2026-09-03T03:30:00.000Z", "application_fee", "90 USD", "100 USD", "https://admission.stanford.edu/", "normal");
  stmts.insertRun.run("run-v3", "2026-09-03T03:44:45.000Z", "boot", 60, JSON.stringify({ scoutVersion: 3 }));
  stmts.insertChange.run("c3", "mit", "MIT", "2026-09-03T03:45:00.000Z", "deadline_early_decision_2", null, "2027-01-05", "https://mitadmissions.org/", "high");

  initPolicyScout(db); // idempotent re-init, as on every boot
  assert.deepEqual(listRecentChanges(stmts, { days: 3650 }).map((c) => c.id).sort(), ["c2", "c3"]);
  initPolicyScout(db);
  assert.equal(listRecentChanges(stmts, { days: 3650 }).length, 2);
});

test("a school whose site cannot be resolved or read is reported, not invented", async () => {
  const stores = freshStores();
  const { fetchImpl } = makeSite();
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
