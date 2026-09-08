import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { initRAGTables, prepareRAGStatements } from "../rag-engine.js";
import {
  ingestParsedCdsCache,
  ensureCdsStoreSeeded,
  resolveStoredCdsRecord,
  cdsRecordToPositioningResult,
  normalizeCdsTestPolicy,
  slugifySchoolName,
  strictSchoolKey,
  schoolNamesCompatible,
} from "../cds-store.js";
import { resolveDownloadURL, unwrapGoogleRedirect, isBlockedIp, assertSafeFetchTarget } from "../cds-ingest-pipeline.js";

function freshStmts() {
  const db = new Database(":memory:");
  initRAGTables(db);
  return prepareRAGStatements(db);
}

test("slugifySchoolName matches the parsed-cache convention", () => {
  assert.equal(slugifySchoolName("Columbia University"), "columbia-university");
  assert.equal(slugifySchoolName("University of Michigan"), "university-of-michigan");
});

test("normalizeCdsTestPolicy maps onto the engine's two buckets", () => {
  assert.equal(normalizeCdsTestPolicy("test_optional"), "test_optional_or_deemphasized");
  assert.equal(normalizeCdsTestPolicy("test_blind"), "test_optional_or_deemphasized");
  assert.equal(normalizeCdsTestPolicy("test_required"), "test_considered_or_required");
  assert.equal(normalizeCdsTestPolicy(""), null);
});

test("ingest populates cds_records and resolves a school to real data", async () => {
  const stmts = freshStmts();
  const res = await ingestParsedCdsCache(stmts);
  assert.ok(res.ingested >= 15, `expected a healthy ingest, got ${res.ingested}`);
  assert.deepEqual(res.errors, []);

  // Exact-name resolution + the conservative fuzzy fallback.
  const exact = resolveStoredCdsRecord(stmts, { schoolName: "Columbia University" });
  assert.ok(exact, "Columbia should resolve");
  assert.ok(exact.overallAdmitRate > 0 && exact.overallAdmitRate < 0.1, "Columbia admit rate should be single-digit %");
  assert.ok(exact.c7 && exact.c7.gpa, "C7 factor weights should be present");
  assert.ok(exact.enrolledSAT?.p25, "enrolled SAT range should be present");
});

test("adapter shapes a stored record for the positioning engine", async () => {
  const stmts = freshStmts();
  await ingestParsedCdsCache(stmts);
  const rec = resolveStoredCdsRecord(stmts, { schoolName: "Columbia University" });

  const live = { schoolName: "Columbia University", fetchStatus: "not_found", parsed: null, sourceUrl: null };
  const adapted = cdsRecordToPositioningResult(rec, { liveFallback: live });

  assert.equal(adapted.fetchStatus, "ok");
  assert.ok(adapted.parsed.c7.gpa, "c7 carried through");
  assert.ok(adapted.parsed.admitRatePercent > 0 && adapted.parsed.admitRatePercent < 10);
  assert.ok(adapted.parsed.satComposite.low > 0 && adapted.parsed.satComposite.high > adapted.parsed.satComposite.low);
  assert.equal(adapted.parsed.testPolicy, "test_optional_or_deemphasized");
  assert.equal(adapted.provenance.kind, "cds_store");
  assert.equal(adapted.provenance.validated, true);
  assert.ok(adapted.repositoryMatch.latestAvailableYear);
});

test("adapter returns the live fallback when no record is given", () => {
  const live = { schoolName: "Unknown", fetchStatus: "not_found", parsed: null };
  assert.equal(cdsRecordToPositioningResult(null, { liveFallback: live }), live);
});

test("adapter tags unvalidated live records as cds_live / validated:false", () => {
  const rec = { slug: "x-university", school: "X University", overallAdmitRate: 0.5, enrolledSAT: { p25: 1200, p75: 1400 }, c7: { gpa: "very_important" }, year: 2024 };
  const validatedOut = cdsRecordToPositioningResult(rec, { validated: true });
  const liveOut = cdsRecordToPositioningResult(rec, { validated: false });
  assert.equal(validatedOut.validated, true);
  assert.equal(validatedOut.provenance.kind, "cds_store");
  assert.equal(liveOut.validated, false);
  assert.equal(liveOut.provenance.kind, "cds_live");
  assert.equal(liveOut.provenance.validated, false);
});

test("strict matching keeps distinct institutions apart", () => {
  // The bug this guards: "University"/"College" must NOT be stripped, or
  // "Boston University" binds to "Boston College".
  assert.equal(schoolNamesCompatible("Boston University", "Boston College"), false);
  assert.equal(schoolNamesCompatible("Columbia University", "Columbia University in the City of New York"), true);
  assert.equal(schoolNamesCompatible("University of Missouri-Columbia", "Columbia University"), false);
  assert.equal(schoolNamesCompatible("Boston University", "Boston University"), true);
  assert.notEqual(strictSchoolKey("Boston University"), strictSchoolKey("Boston College"));
});

test("resolveDownloadURL unwraps Google redirect + Drive links", () => {
  const wrapped = "https://www.google.com/url?q=https://drive.google.com/file/d/ABC123XYZ&sa=D&source=editors&ust=1";
  assert.equal(unwrapGoogleRedirect(wrapped), "https://drive.google.com/file/d/ABC123XYZ");
  assert.equal(resolveDownloadURL(wrapped), "https://drive.google.com/uc?export=download&id=ABC123XYZ");
  // Direct PDF passes through.
  assert.equal(resolveDownloadURL("https://x.edu/cds.pdf"), "https://x.edu/cds.pdf");
  // Sheets → xlsx export (then rejected downstream as non-PDF).
  assert.match(resolveDownloadURL("https://docs.google.com/spreadsheets/d/SHEET1/edit"), /export\?format=xlsx/);
});

test("isBlockedIp rejects loopback/private/link-local, allows public", () => {
  assert.equal(isBlockedIp("127.0.0.1", 4), true);
  assert.equal(isBlockedIp("10.0.0.5", 4), true);
  assert.equal(isBlockedIp("172.16.0.1", 4), true);
  assert.equal(isBlockedIp("172.31.255.255", 4), true);
  assert.equal(isBlockedIp("172.32.0.1", 4), false); // just outside the 172.16/12 block
  assert.equal(isBlockedIp("192.168.1.1", 4), true);
  assert.equal(isBlockedIp("169.254.1.1", 4), true);
  assert.equal(isBlockedIp("100.64.0.1", 4), true); // carrier-grade NAT
  assert.equal(isBlockedIp("8.8.8.8", 4), false);
  assert.equal(isBlockedIp("::1", 6), true);
  assert.equal(isBlockedIp("::ffff:127.0.0.1", 6), true); // IPv4-mapped loopback
  assert.equal(isBlockedIp("fe80::1", 6), true);
  assert.equal(isBlockedIp("fd00::1", 6), true); // unique-local
  assert.equal(isBlockedIp("2001:4860:4860::8888", 6), false);
});

test("a parsed record replaced by a newer document is re-ingested on boot", async () => {
  // Columbia's cached CDS was the School of General Studies document; the
  // Columbia College and Engineering one replaced it on disk with a new
  // year label. A populated deployment used to keep the old row forever
  // because the boot seed only topped up missing slugs.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cds-parsed-"));
  const file = path.join(dir, "example-university.json");
  const record = (overrides) => ({
    school: "Example University", slug: "example-university", tier: "T50", year: 2024, yearLabel: "2023-24",
    source: "cds", parserVersion: 3, testPolicy: "test_optional",
    b1: { applied: 509, admitted: 152, enrolled: 75 }, overallAdmitRate: 0.2986, yieldRate: 0.4934,
    enrolledSAT: { p25: 1460, p75: 1530 }, c7: { gpa: "very_important" },
    extras: { dates: { regularClosing: { mmdd: "05-15", raw: "May 15" } } },
    ...overrides,
  });
  try {
    fs.writeFileSync(file, JSON.stringify(record({})));
    const stmts = freshStmts();
    const first = await ensureCdsStoreSeeded(stmts, { dir });
    assert.equal(first.seeded, true);
    assert.equal((await ensureCdsStoreSeeded(stmts, { dir })).reason, "already_populated");

    fs.writeFileSync(file, JSON.stringify(record({
      year: 2024, yearLabel: "2024-25",
      b1: { applied: 60247, admitted: 2325, enrolled: 1483 }, overallAdmitRate: 0.0386, yieldRate: 0.6378,
      enrolledSAT: { p25: 1510, p75: 1560 },
      extras: { dates: { regularClosing: { mmdd: "01-01", raw: "January 1" } } },
    })));
    const again = await ensureCdsStoreSeeded(stmts, { dir });
    assert.equal(again.seeded, true, JSON.stringify(again));
    const stored = resolveStoredCdsRecord(stmts, { schoolName: "Example University" });
    assert.equal(stored.yearLabel, "2024-25");
    assert.equal(stored.overallAdmitRate, 0.0386);
    assert.deepEqual(stored.b1, { applied: 60247, admitted: 2325, enrolled: 1483 });
    assert.equal(stored.extras.dates.regularClosing.mmdd, "01-01");
    assert.equal((await ensureCdsStoreSeeded(stmts, { dir })).reason, "already_populated");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("assertSafeFetchTarget rejects malformed URLs, non-http(s) schemes, and loopback hosts", async () => {
  await assert.rejects(() => assertSafeFetchTarget("file:///etc/passwd"), /non-http/);
  await assert.rejects(() => assertSafeFetchTarget("ftp://internal.example/x"), /non-http/);
  await assert.rejects(() => assertSafeFetchTarget("http://127.0.0.1/admin"), /non-public address/);
  await assert.rejects(() => assertSafeFetchTarget("http://localhost:3001/api/health"), /non-public address/);
  await assert.rejects(() => assertSafeFetchTarget("not a url"), /malformed/);
});

test("the adapter carries the wider read (sections, distributions, class rank, GPA band) to the engine", () => {
  const rec = {
    slug: "x-university", school: "X University", overallAdmitRate: 0.05, year: 2024,
    enrolledSAT: { p25: 1500, p75: 1570 }, enrolledGPA: { p25: 3.75, p75: 4 }, testPolicy: "test_optional", c7: { gpa: "very_important" },
    extras: {
      satSections: { ebrw: { p25: 740, p75: 780 }, math: { p25: 770, p75: 800 } },
      actSections: { english: { p25: 35, p75: 36 }, math: { p25: 33, p75: 36 } },
      scoreDistribution: { satComposite: [{ low: 1400, high: 1600, pct: 97 }, { low: 1200, high: 1399, pct: 3 }] },
      gpaDistribution: [{ low: 4, high: 4, pct: 73 }, { low: 3.75, high: 3.99, pct: 17 }, { low: 3.5, high: 3.74, pct: 10 }],
      gpa: { average: 3.94, submittedPct: 68 },
      classRank: { topTenthPct: 98, topQuarterPct: 100, submittedPct: 19 },
      submitting: { satPct: 50, actPct: 19 },
    },
  };
  const out = cdsRecordToPositioningResult(rec, { validated: true });
  assert.deepEqual(out.parsed.gpaBand, { low: 3.75, high: 4 });
  assert.equal(out.parsed.gpaAverage, 3.94, "the C12 average in extras fills a record without one");
  assert.deepEqual(out.parsed.satSections, rec.extras.satSections);
  assert.deepEqual(out.parsed.actSections, rec.extras.actSections);
  assert.deepEqual(out.parsed.scoreDistribution, rec.extras.scoreDistribution);
  assert.deepEqual(out.parsed.gpaDistribution, rec.extras.gpaDistribution);
  assert.deepEqual(out.parsed.classRank, rec.extras.classRank);
  assert.deepEqual(out.parsed.submitting, rec.extras.submitting);
  const bare = cdsRecordToPositioningResult({ slug: "y", school: "Y", overallAdmitRate: 0.5 }, { validated: false });
  assert.equal(bare.parsed.gpaBand, null);
  assert.equal(bare.parsed.satSections, null);
  assert.equal(bare.parsed.gpaDistribution, null);
});

test("a parsed file re-parsed by a newer parser version is re-ingested on boot", async () => {
  const stmts = freshStmts();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cds-store-version-"));
  try {
    const record = {
      school: "Version University", slug: "version-university", year: 2024, yearLabel: "2024-25", parserVersion: 3,
      overallAdmitRate: 0.2, enrolledSAT: { p25: 1300, p75: 1450 }, testPolicy: "test_optional", c7: { gpa: "very_important" },
      extras: { satSections: { math: { p25: 650, p75: 740 } } },
    };
    fs.writeFileSync(path.join(dir, "version-university.json"), JSON.stringify(record));
    const first = await ensureCdsStoreSeeded(stmts, { dir });
    assert.equal(first.seeded, true);
    assert.equal(resolveStoredCdsRecord(stmts, { slug: "version-university" }).parserVersion, 3);
    // Same file, same year: nothing to do.
    assert.equal((await ensureCdsStoreSeeded(stmts, { dir })).seeded, false);
    // The parser learned to read more; the row must follow the file.
    record.parserVersion = 4;
    record.extras.actSections = { math: { p25: 28, p75: 33 } };
    record.enrolledGPA = { p25: 3.5, p75: 4, avg: 3.86 };
    fs.writeFileSync(path.join(dir, "version-university.json"), JSON.stringify(record));
    const again = await ensureCdsStoreSeeded(stmts, { dir });
    assert.equal(again.seeded, true);
    const stored = resolveStoredCdsRecord(stmts, { slug: "version-university" });
    assert.equal(stored.parserVersion, 4);
    assert.deepEqual(stored.extras.actSections, { math: { p25: 28, p75: 33 } });
    assert.deepEqual(stored.enrolledGPA, { p25: 3.5, p75: 4, avg: 3.86 });
    assert.equal((await ensureCdsStoreSeeded(stmts, { dir })).seeded, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
