import test from "node:test";
import assert from "node:assert/strict";

import {
  parseCdsRepositoryIndex,
  findBestRepositoryEntry,
  selectPreferredCdsLink,
  parseCdsText,
  parseCdsDocument,
  extractCdsDocumentText,
  extractC7TableRowsFromText,
  extractTargetSchoolNames,
  computeCdsQueryCacheKey,
  normalizeC7Object,
  normalizeC7TableRows,
  resolveAndParseCdsTargets,
  loadRepositoryIndexHtml,
  resetRepositoryIndexMemo,
  CDS_REPOSITORY_URL,
} from "../cds/cds-search.js";

test("parseCdsRepositoryIndex extracts schools, years, and links", () => {
  const html = `
    <table>
      <tr><th>Institution</th><th>2024-25</th><th>2023-24</th></tr>
      <tr>
        <td>Example University</td>
        <td><a href="https://example.edu/cds/2024-25.pdf">CDS</a></td>
        <td>CDS</td>
      </tr>
    </table>
  `;
  const entries = parseCdsRepositoryIndex(html);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].schoolName, "Example University");
  assert.equal(entries[0].years[0].available, true);
  assert.equal(entries[0].years[0].links[0].url, "https://example.edu/cds/2024-25.pdf");
  assert.equal(entries[0].years[1].available, true);
});

test("findBestRepositoryEntry fuzzy matches school names", () => {
  const entries = parseCdsRepositoryIndex(`
    <table><tr><th>Institution</th><th>2024-25</th></tr>
    <tr><td>University of Michigan</td><td><a href="https://umich.edu/cds.pdf">CDS</a></td></tr>
    </table>
  `);
  const match = findBestRepositoryEntry(entries, "Michigan");
  assert.ok(match);
  assert.equal(match.schoolName, "University of Michigan");
});

test("selectPreferredCdsLink skips google relay URLs when a direct URL exists", () => {
  const entry = {
    years: [
      {
        year: "2024-25",
        available: true,
        links: [
          { label: "CDS", url: "https://www.google.com/search?q=foo" },
          { label: "CDS", url: "https://school.edu/cds/latest.pdf" },
        ],
      },
    ],
  };
  const selected = selectPreferredCdsLink(entry);
  assert.equal(selected.url, "https://school.edu/cds/latest.pdf");
});

test("parseCdsText extracts key admissions signals", () => {
  const text = `
    Overall admission rate 9.1%
    Percent who actually enrolled 82.4%
    Average high school GPA of all degree-seeking, first-time, first-year 3.93
    SAT Evidence-Based Reading and Writing 740 SAT Math 790
    ACT Composite 34 ACT Composite 35
    Percent who had high school class rank in top tenth of graduating class 94%
    Rigor of secondary school record Very Important
    Academic GPA Very Important
    Standardized test scores Important
    Application essay Important
    Extracurricular activities Considered
  `;
  const parsed = parseCdsText(text);
  assert.equal(parsed.admitRatePercent, 9.1);
  assert.equal(parsed.yieldRatePercent, 82.4);
  assert.equal(parsed.gpaAverage, 3.93);
  assert.deepEqual(parsed.satComposite, { low: 740, high: 790 });
  assert.deepEqual(parsed.actComposite, { low: 34, high: 35 });
  assert.equal(parsed.classRankTop10Percent, 94);
  assert.equal(parsed.c7.rigor, 1);
  assert.equal(parsed.c7.standardizedTests, 0.7);
  assert.equal(parsed.c7.extracurriculars, 0.35);
});

function c7Line(label, ratingColumn) {
  const cols = [52, 74, 96, 121];
  const chars = Array(140).fill(" ");
  for (let i = 0; i < label.length; i += 1) chars[i] = label[i];
  chars[cols[ratingColumn]] = "X";
  return chars.join("").trimEnd();
}

test("extractC7TableRowsFromText normalizes OCR table rows into numeric C7 weights", () => {
  const text = [
    "Academic                                            Very Important       Important        Considered        Not Considered",
    c7Line("Rigor of secondary school record", 0),
    c7Line("Class rank", 2),
    c7Line("Academic GPA", 2),
    c7Line("Standardized test scores", 2),
    c7Line("Application Essay", 0),
    c7Line("Recommendation(s)", 0),
    "Nonacademic                                         Very Important       Important        Considered        Not Considered",
    c7Line("Interview", 3),
    c7Line("Extracurricular activities", 0),
    c7Line("Talent/ability", 0),
    c7Line("Character/personal qualities", 0),
    c7Line("First generation", 2),
    c7Line("Level of applicant’s interest", 3),
  ].join("\n");

  const result = extractC7TableRowsFromText(text);
  assert.equal(result.c7.rigor, 1);
  assert.equal(result.c7.classRank, 0.35);
  assert.equal(result.c7.academicGpa, 0.35);
  assert.equal(result.c7.standardizedTests, 0.35);
  assert.equal(result.c7.essay, 1);
  assert.equal(result.c7.recommendation, 1);
  assert.equal(result.c7.interview, 0);
  assert.equal(result.c7.extracurriculars, 1);
  assert.equal(result.c7.talentAbility, 1);
  assert.equal(result.c7.character, 1);
  assert.equal(result.c7.firstGeneration, 0.35);
  assert.equal(result.c7.levelOfInterest, 0);
  assert.ok(result.rows.every((row) => typeof row.numericWeight === "number"));
});

test("normalizeC7TableRows accepts spreadsheet-shaped rows and noisy labels", () => {
  const result = normalizeC7TableRows([
    { factorLabel: "Recommendation(s)", veryImportant: "X" },
    { factorLabel: "Talent/ability", selectedRating: "Very Important" },
    { factorLabel: "Character/personal qualities", considered: true },
    { factorLabel: "Level of applicant’s interest", notConsidered: "x" },
  ]);
  assert.equal(result.c7.recommendation, 1);
  assert.equal(result.c7.talentAbility, 1);
  assert.equal(result.c7.character, 0.35);
  assert.equal(result.c7.levelOfInterest, 0);
});

test("normalizeC7Object converts legacy CDS string ratings to positioning numeric keys", () => {
  const c7 = normalizeC7Object({
    class_rank: "considered",
    gpa: "very_important",
    test_scores: "not_considered",
    ec: "important",
  });
  assert.deepEqual(c7, {
    classRank: 0.35,
    academicGpa: 1,
    standardizedTests: 0,
    extracurriculars: 0.7,
  });
});

test("parseCdsText uses OCR-style C7 table fallback when prose ratings are absent", () => {
  const text = [
    "Common Data Set 2024-2025",
    "Academic                                            Very Important       Important        Considered        Not Considered",
    c7Line("Rigor of secondary school record", 0),
    c7Line("Academic GPA", 2),
    c7Line("Standardized test scores", 3),
    "Overall admission rate 11.4%",
  ].join("\n");
  const parsed = parseCdsText(text);
  assert.equal(parsed.admitRatePercent, 11.4);
  assert.equal(parsed.c7.rigor, 1);
  assert.equal(parsed.c7.academicGpa, 0.35);
  assert.equal(parsed.c7.standardizedTests, 0);
  assert.ok(parsed.c7TableRows.length >= 3);
});

test("parseCdsText lets OCR table rows override misleading flattened header text", () => {
  const text = [
    "Common Data Set 2024-2025",
    "Academic                                            Very Important       Important        Considered        Not Considered",
    c7Line("Rigor of secondary school record", 0),
    c7Line("Class rank", 2),
    c7Line("Academic GPA", 2),
    c7Line("Standardized test scores", 2),
    c7Line("Application Essay", 0),
    c7Line("Recommendation(s)", 0),
  ].join("\n");
  const parsed = parseCdsText(text);
  assert.equal(parsed.c7.rigor, 1);
  assert.equal(parsed.c7.classRank, 0.35);
  assert.equal(parsed.c7.academicGpa, 0.35);
  assert.equal(parsed.c7.standardizedTests, 0.35);
});

test("parseCdsDocument extracts text first, then parses CDS fields", async () => {
  const doc = Buffer.from(`
    <html><body>
    Common Data Set 2024-2025
    Overall admission rate 7.5%
    Percent who actually enrolled 71.2%
    Average high school GPA of all degree-seeking, first-time, first-year 3.91
    SAT Evidence-Based Reading and Writing 730 SAT Math 780
    ACT Composite 33 ACT Composite 35
    Rigor of secondary school record Very Important
    Academic GPA Very Important
    </body></html>
  `);

  const result = await parseCdsDocument(doc, { contentType: "text/html" });
  assert.equal(result.extraction.method, "html_text");
  assert.equal(result.parsed.admitRatePercent, 7.5);
  assert.equal(result.parsed.gpaAverage, 3.91);
  assert.deepEqual(result.parsed.satComposite, { low: 730, high: 780 });
});

test("extractCdsDocumentText falls back to injected PDF OCR when PDF text is low signal", async () => {
  let ocrCalled = false;
  const result = await extractCdsDocumentText(Buffer.from("%PDF-1.7 fake"), {
    contentType: "application/pdf",
    pdfTextExtractor: async () => ({
      text: "tiny",
      pageCount: 2,
      warning: null,
    }),
    ocrPdfExtractor: async (_buf, context) => {
      ocrCalled = true;
      assert.equal(context.pageCount, 2);
      return {
        text: "Common Data Set 2024-2025 Overall admission rate 8.2%",
        pageCount: 2,
        warning: "ocr_low_confidence",
      };
    },
  });

  assert.equal(ocrCalled, true);
  assert.equal(result.extractionMethod, "pdf_ocr");
  assert.match(result.warning, /pdf_text_low_signal/);
  assert.match(result.warning, /ocr_low_confidence/);
  assert.match(result.text, /Overall admission rate 8\.2%/);
});

test("resolveAndParseCdsTargets records OCR extraction metadata for scanned PDFs", async () => {
  const repositoryHtml = `
    <table>
      <tr><th>Institution</th><th>2024-25</th></tr>
      <tr><td>Scanned College</td><td><a href="https://school.edu/cds.pdf">CDS</a></td></tr>
    </table>
  `;
  const fetchImpl = async (url) => {
    assert.equal(url, "https://school.edu/cds.pdf");
    return {
      ok: true,
      headers: { get: () => "application/pdf" },
      arrayBuffer: async () => Buffer.from("%PDF-1.7 fake"),
    };
  };

  const [result] = await resolveAndParseCdsTargets(
    [{ schoolName: "Scanned College" }],
    {
      repositoryHtml,
      fetchImpl,
      assertTarget: async () => {}, // the stub host does not resolve; the guard has its own tests below
      pdfTextExtractor: async () => ({ text: "", pageCount: 4 }),
      ocrPdfExtractor: async () => ({
        text: "Common Data Set Overall admission rate 12.3% ACT Composite 31 ACT Composite 34",
        pageCount: 4,
      }),
    },
  );

  assert.equal(result.fetchStatus, "ok");
  assert.equal(result.sourceExtraction.method, "pdf_ocr");
  assert.equal(result.sourceExtraction.pageCount, 4);
  assert.equal(result.parsed.admitRatePercent, 12.3);
  assert.deepEqual(result.parsed.actComposite, { low: 31, high: 34 });
});

// The repository link is a third party's URL. Before 2026-09-22 it was
// fetched plainly, redirects followed; now every hop goes through the same
// guard as the CDS download, and a link or a redirect into a non-public
// address is refused before the request is made.
test("resolveAndParseCdsTargets refuses a repository link into a non-public address before any fetch", async () => {
  const repositoryHtml = `
    <table>
      <tr><th>Institution</th><th>2024-25</th></tr>
      <tr><td>Inside College</td><td><a href="http://127.0.0.1:8080/cds.pdf">CDS</a></td></tr>
    </table>
  `;
  let fetched = 0;
  const [result] = await resolveAndParseCdsTargets([{ schoolName: "Inside College" }], {
    repositoryHtml,
    fetchImpl: async () => {
      fetched += 1;
      return { ok: true, headers: { get: () => "application/pdf" }, arrayBuffer: async () => Buffer.from("%PDF-1.7 fake") };
    },
  });
  assert.equal(fetched, 0, "nothing is requested");
  assert.match(result.fetchStatus, /^error:Refusing to fetch a URL that resolves to a non-public address/);
  assert.equal(result.parsed, null);
});

test("resolveAndParseCdsTargets checks every redirect hop", async () => {
  const repositoryHtml = `
    <table>
      <tr><th>Institution</th><th>2024-25</th></tr>
      <tr><td>Bouncing College</td><td><a href="https://school.edu/cds.pdf">CDS</a></td></tr>
    </table>
  `;
  const requested = [];
  const fetchImpl = async (url, options) => {
    requested.push(url);
    assert.equal(options.redirect, "manual", "redirects are followed by hand so each hop is checked");
    return { ok: false, status: 302, headers: { get: (name) => (name === "location" ? "http://169.254.169.254/latest/meta-data/" : null) } };
  };
  const [result] = await resolveAndParseCdsTargets([{ schoolName: "Bouncing College" }], {
    repositoryHtml,
    fetchImpl,
    assertTarget: async (url) => {
      if (new URL(url).hostname.startsWith("169.254.")) throw new Error("Refusing to fetch a URL that resolves to a non-public address: 169.254.169.254");
    },
  });
  assert.deepEqual(requested, ["https://school.edu/cds.pdf"], "the redirect target is never requested");
  assert.match(result.fetchStatus, /^error:Refusing to fetch a URL that resolves to a non-public address/);
});

test("extractTargetSchoolNames resolves names from strings, objects, and fallback rows", () => {
  const results = extractTargetSchoolNames(
    [
      "Harvard University",
      { unitId: "166683" },
      { unitId: "166683", schoolName: "Harvard University" },
      { name: "Stanford University" },
    ],
    [{ unit_id: "166683", name: "Massachusetts Institute of Technology" }],
  );
  assert.deepEqual(results, [
    { unitId: null, schoolName: "Harvard University" },
    { unitId: "166683", schoolName: "Massachusetts Institute of Technology" },
    { unitId: "166683", schoolName: "Harvard University" },
    { unitId: null, schoolName: "Stanford University" },
  ]);
});

test("computeCdsQueryCacheKey is stable for equivalent targets", () => {
  const a = computeCdsQueryCacheKey([
    { unitId: "1", schoolName: "Stanford University" },
    { unitId: "2", schoolName: "Harvard University" },
  ]);
  const b = computeCdsQueryCacheKey([
    { unitId: "2", schoolName: " Harvard University " },
    { unitId: "1", schoolName: "stanford university" },
  ]);
  assert.equal(a, b);
});

// ─── 2026-11-03: the repository index is read by its header, and the
// live repository is optional ──────────────────────────────────────────

// The index used to label the i-th cell from a year list starting at
// "2024-25", skipping the header: a 2025-26 column in front would have
// filed every document one cycle older (time-7, debt-6).
test("parseCdsRepositoryIndex labels each column from the table's own header", () => {
  const newestFirst = parseCdsRepositoryIndex(`
    <table>
      <tr><th>Institution</th><th>2025-26</th><th>2024-25</th><th>2023-24</th></tr>
      <tr><td>Example University</td><td><a href="https://example.edu/cds-2025-26.pdf">CDS</a></td><td><a href="https://example.edu/cds-2024-25.pdf">CDS</a></td><td>CDS</td></tr>
    </table>
  `);
  assert.deepEqual(newestFirst[0].years.map((y) => y.year), ["2025-26", "2024-25", "2023-24"]);
  assert.equal(newestFirst[0].years[0].links[0].url, "https://example.edu/cds-2025-26.pdf");
  assert.equal(newestFirst[0].years[1].links[0].url, "https://example.edu/cds-2024-25.pdf");
  assert.equal(selectPreferredCdsLink(newestFirst[0]).url, "https://example.edu/cds-2025-26.pdf");

  // Oldest first, with a column that is not a cycle: each link keeps its
  // own year, the non-cycle column labels nothing, and the newest comes first.
  const oldestFirst = parseCdsRepositoryIndex(`
    <table>
      <tr><th>Institution</th><th>2023-2024</th><th>Notes</th><th>2025–26</th></tr>
      <tr><td>Example University</td><td><a href="https://example.edu/old.pdf">CDS</a></td><td><a href="https://example.edu/notes.html">see note</a></td><td><a href="https://example.edu/new.pdf">CDS</a></td></tr>
    </table>
  `);
  assert.deepEqual(oldestFirst[0].years.map((y) => [y.year, y.links[0]?.url]), [["2025-26", "https://example.edu/new.pdf"], ["2023-24", "https://example.edu/old.pdf"]]);
});

test("a table with no year header labels nothing and says so", () => {
  const warnings = [];
  const entries = parseCdsRepositoryIndex(`
    <table>
      <tr><td>Example University</td><td><a href="https://example.edu/cds.pdf">CDS</a></td></tr>
    </table>
  `, { warn: (message) => warnings.push(message) });
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].years, []);
  assert.equal(selectPreferredCdsLink(entries[0]), null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no year header/);
});

// A refused or unreachable index used to reject the whole call, and College
// Fit answered 500 for every uncached school though the store held most of
// them (fit-3).
test("resolveAndParseCdsTargets answers index_unavailable rows when the index cannot be read", async () => {
  for (const fetchImpl of [
    async () => ({ ok: false, status: 403, text: async () => "blocked" }),
    async () => { throw new Error("getaddrinfo ENOTFOUND www.collegetransitions.com"); },
  ]) {
    const results = await resolveAndParseCdsTargets([{ schoolName: "Columbia University" }, { schoolName: "Example College", unitId: "123" }], { fetchImpl });
    assert.equal(results.length, 2);
    for (const row of results) {
      assert.equal(row.fetchStatus, "index_unavailable");
      assert.equal(row.transientFailure, true);
      assert.equal(row.parsed, null);
    }
    assert.equal(results[1].unitId, "123");
  }
});

test("the index is retried with browser headers, and a stored school's document is not downloaded again", async () => {
  const requested = [];
  const fetchImpl = async (url, options) => {
    requested.push({ url, agent: options?.headers?.["user-agent"] || "" });
    if (url.includes("collegetransitions.com")) {
      if (/college-counselor-backend/.test(options.headers["user-agent"])) return { ok: false, status: 403, text: async () => "" };
      return { ok: true, status: 200, text: async () => `<table><tr><th>Institution</th><th>2025-26</th></tr><tr><td>Stored University</td><td><a href="https://stored.edu/cds.pdf">CDS</a></td></tr></table>` };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const [row] = await resolveAndParseCdsTargets([{ schoolName: "Stored University" }], { fetchImpl, hasStoredRecord: () => true });
  assert.equal(row.fetchStatus, "stored_record");
  assert.equal(row.repositoryMatch.latestAvailableYear, "2025-26");
  assert.deepEqual(requested.map((r) => r.url), [CDS_REPOSITORY_URL, CDS_REPOSITORY_URL], "the index twice (server agent, then browser), the document never");
  assert.match(requested[1].agent, /Mozilla/);
});

test("the default index loader remembers a success for a day and a failure briefly", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  let fail = true;
  globalThis.fetch = async () => {
    calls += 1;
    return fail ? { ok: false, status: 503, text: async () => "" } : { ok: true, status: 200, text: async () => "<table></table>" };
  };
  try {
    resetRepositoryIndexMemo();
    const t0 = Date.parse("2026-11-03T12:00:00Z");
    assert.ok((await loadRepositoryIndexHtml({ now: t0 })).error);
    assert.equal(calls, 2, "both header sets tried");
    assert.ok((await loadRepositoryIndexHtml({ now: t0 + 60_000 })).error, "a failure is remembered for a moment");
    assert.equal(calls, 2);
    fail = false;
    assert.equal((await loadRepositoryIndexHtml({ now: t0 + 3 * 60_000 })).html, "<table></table>", "and read again after it");
    assert.equal(calls, 3);
    await loadRepositoryIndexHtml({ now: t0 + 60 * 60_000 });
    assert.equal(calls, 3, "a success is kept");
  } finally {
    globalThis.fetch = realFetch;
    resetRepositoryIndexMemo();
  }
});

// Every CDS prints the "Required" column header, so the flattened text
// cannot say a school requires scores; it used to read every document
// without a test-optional phrase as required (fit-6).
test("parseCdsText reads no test policy it cannot see", () => {
  assert.equal(parseCdsText("Common Data Set 2025-2026 C8A SAT or ACT Require Recommend Not required for admission").testPolicy, null);
  assert.equal(parseCdsText("Common Data Set. Our admission is test-optional for first-year applicants.").testPolicy, "test_optional_or_deemphasized");
  assert.equal(parseCdsText("Standardized test scores Not Considered").testPolicy, "test_optional_or_deemphasized", "C7 rating tests not considered");
  assert.equal(parseCdsText("Standardized test scores Important. Very Important Important Considered Not Considered").testPolicy, null, "the C7 header is not a rating");
});
test("a header cell that names its cycle among other words still labels the column", () => {
  const entries = parseCdsRepositoryIndex(`
    <table>
      <tr><th>School</th><th>CDS 2025-2026</th><th>CDS 2024-25</th></tr>
      <tr><td>Example University</td><td><a href="https://example.edu/new.pdf">CDS</a></td><td><a href="https://example.edu/old.pdf">CDS</a></td></tr>
    </table>
  `);
  assert.deepEqual(entries[0].years.map((y) => [y.year, y.links[0].url]), [["2025-26", "https://example.edu/new.pdf"], ["2024-25", "https://example.edu/old.pdf"]]);
});
