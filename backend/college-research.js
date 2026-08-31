// ═══════════════════════════════════════════════════════════════════════
// COLLEGE RESEARCH — official-source web extraction (values + deadlines)
// ═══════════════════════════════════════════════════════════════════════
// Rebuilt at the owner's request after the earlier removal. The guardrails
// that motivated the removal are kept structural instead of absolute:
//   • Only pages on the school's OWN site are fetched. The site is resolved
//     through the College Scorecard API (school.school_url) or a caller hint
//     restricted to .edu / the resolved domain — never from model output.
//   • Every fetch passes the SSRF guard (assertSafeFetchTarget) and a
//     same-site check on the post-redirect URL.
//   • The model only ever summarizes FETCHED official text. Value quotes are
//     verified verbatim against the fetched page before being served.
//   • Results carry their source URLs and are cached with TTLs.
// The deterministic fit scorer (college-values.js) stays model- and
// network-free; this module supplies it with sourced value themes.

import { assertSafeFetchTarget } from "./cds-ingest-pipeline.js";
import { searchScorecard } from "./college-scorecard.js";

export const VALUES_TTL_DAYS = 90;
export const DEADLINES_TTL_DAYS = 30;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_PAGE_BYTES = 700_000;
const MAX_PAGE_TEXT_CHARS = 16_000;
const MAX_PAGES = 3;
const MAX_HARVESTED_LINKS = 6;

const VALUES_LINK_RE = /about|mission|values|vision|principle|purpose|admission|what-we-look-for/i;
const DEADLINES_LINK_RE = /deadline|apply|admission|dates|first-year|freshman|application/i;

// ─── Cache ──────────────────────────────────────────────────────────────
export function initCollegeResearch(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS college_research_cache (
      cache_key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      slug TEXT NOT NULL,
      display_name TEXT,
      payload_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_college_research_kind ON college_research_cache(kind);
  `);
  return {
    get: db.prepare("SELECT * FROM college_research_cache WHERE cache_key = ?"),
    put: db.prepare(`INSERT INTO college_research_cache (cache_key, kind, slug, display_name, payload_json, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        display_name = excluded.display_name,
        payload_json = excluded.payload_json,
        fetched_at = excluded.fetched_at`),
    clearKind: db.prepare("DELETE FROM college_research_cache WHERE kind = ?"),
  };
}

function cacheRead(stmts, cacheKey, ttlDays, now) {
  const row = stmts?.get?.get(cacheKey);
  if (!row) return null;
  const age = now.getTime() - Date.parse(row.fetched_at);
  if (!Number.isFinite(age) || age > ttlDays * 24 * 60 * 60 * 1000) return null;
  try { return JSON.parse(row.payload_json); } catch { return null; }
}

// ─── Small pure helpers ─────────────────────────────────────────────────
export function slugifyCollege(name) {
  return String(name || "").toLowerCase().normalize("NFKC")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

// Admissions cycle label for a date: Aug–Dec belong to the cycle that closes
// the FOLLOWING spring (e.g. Sep 2026 → "2026-27"), Jan–Jul to the one
// closing that spring (e.g. Feb 2027 → "2026-27").
export function currentAdmissionsCycle(now = new Date()) {
  const y = now.getUTCFullYear();
  const startYear = now.getUTCMonth() >= 7 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

export function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return n > 31 && n < 65536 ? String.fromCharCode(n) : " ";
    })
    .replace(/&(quot|#34);/gi, '"')
    .replace(/&(apos|#39|rsquo|lsquo);/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

export function sameSite(a, b) {
  const ha = hostOf(a); const hb = hostOf(b);
  if (!ha || !hb) return false;
  return ha === hb || ha.endsWith("." + hb) || hb.endsWith("." + ha);
}

export function harvestLinks(html, baseUrl, keywordRe, limit = MAX_HARVESTED_LINKS) {
  const links = [];
  const seen = new Set();
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#\s]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(String(html || ""))) !== null && links.length < limit) {
    const [, href, inner] = match;
    if (/^(mailto:|tel:|javascript:)/i.test(href)) continue;
    let resolved;
    try { resolved = new URL(href, baseUrl).toString(); } catch { continue; }
    if (!/^https?:/i.test(resolved)) continue;
    if (!sameSite(resolved, baseUrl)) continue;
    const anchorText = htmlToText(inner);
    if (!keywordRe.test(resolved) && !keywordRe.test(anchorText)) continue;
    const key = resolved.replace(/\/+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(resolved);
  }
  return links;
}

function normalizeQuoteText(s) {
  return String(s || "").toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

// A value quote counts as verified only when it appears verbatim (after
// whitespace/smart-quote normalization) in one of the fetched pages.
export function verifyQuote(quote, pages) {
  const needle = normalizeQuoteText(quote);
  if (!needle || needle.length < 8 || needle.length > 300) return null;
  for (const page of pages || []) {
    if (normalizeQuoteText(page.text).includes(needle)) return page.url;
  }
  return null;
}

export function sanitizeDeadlineDates(raw, now = new Date()) {
  const fields = ["ea", "ed", "rd", "financialAid", "commitBy", "decisionRelease"];
  const min = now.getTime() - 365 * 24 * 60 * 60 * 1000;
  const max = now.getTime() + 730 * 24 * 60 * 60 * 1000;
  const out = {};
  for (const field of fields) {
    const value = raw?.[field];
    const ts = typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? Date.parse(value) : NaN;
    out[field] = Number.isFinite(ts) && ts >= min && ts <= max ? value.slice(0, 10) : null;
  }
  return out;
}

// ─── Guarded page fetching ──────────────────────────────────────────────
function normalizeHomepage(url) {
  const value = String(url || "").trim();
  if (!value) return null;
  const withProto = /^https?:\/\//i.test(value) ? value : "https://" + value;
  try { return new URL(withProto).toString(); } catch { return null; }
}

async function fetchOfficialPage(url, { fetchImpl = fetch } = {}) {
  await assertSafeFetchTarget(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "CollegeCounselorBot/1.0 (educational; official-source research)",
        "Accept": "text/html,application/xhtml+xml,text/plain;q=0.8",
      },
      redirect: "follow",
    });
    if (!response.ok) return null;
    const finalUrl = response.url || url;
    // Redirects may hop subdomains but must stay on the school's site (or a
    // .edu host) — a redirect off-site is discarded, not followed blindly.
    if (!sameSite(finalUrl, url) && !hostOf(finalUrl).endsWith(".edu")) return null;
    const contentType = String(response.headers.get("content-type") || "");
    if (contentType && !/text\/html|application\/xhtml|text\/plain/i.test(contentType)) return null;
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_PAGE_BYTES) return null;
    const html = (await response.text()).slice(0, MAX_PAGE_BYTES);
    const text = htmlToText(html).slice(0, MAX_PAGE_TEXT_CHARS);
    if (!text || text.length < 200) return null;
    return { url: finalUrl, html, text };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Academic hosts a caller-provided hint URL may point at: US .edu plus
// international academic TLD families (ac.kr, ac.uk, edu.au, …).
const ACADEMIC_HOST_RE = /(\.edu|\.ac\.[a-z]{2,3}|\.edu\.[a-z]{2,3})$/i;

// Common abbreviations → the school's official Scorecard name. The Scorecard
// name filter is a tokenized keyword search, so "NYU" matches nothing at all
// while its official name resolves cleanly. (The chat-side COLLEGE_ALIASES
// map is unusable here — many of its values are themselves nicknames.)
const COLLEGE_NAME_ALIASES = {
  "nyu": "New York University",
  "mit": "Massachusetts Institute of Technology",
  "caltech": "California Institute of Technology",
  "usc": "University of Southern California",
  "ucla": "University of California-Los Angeles",
  "uc berkeley": "University of California-Berkeley",
  "berkeley": "University of California-Berkeley",
  "ucsd": "University of California-San Diego",
  "uc davis": "University of California-Davis",
  "uiuc": "University of Illinois Urbana-Champaign",
  "umich": "University of Michigan-Ann Arbor",
  "cmu": "Carnegie Mellon University",
  "uva": "University of Virginia-Main Campus",
  "unc": "University of North Carolina at Chapel Hill",
  "ut austin": "The University of Texas at Austin",
  "utexas": "The University of Texas at Austin",
  "uw": "University of Washington-Seattle Campus",
  "bu": "Boston University",
  "bc": "Boston College",
  "georgia tech": "Georgia Institute of Technology-Main Campus",
  "gatech": "Georgia Institute of Technology-Main Campus",
  "osu": "Ohio State University-Main Campus",
  "penn": "University of Pennsylvania",
  "upenn": "University of Pennsylvania",
  "penn state": "Pennsylvania State University-Main Campus",
  "sbu": "Stony Brook University",
  "suny stony brook": "Stony Brook University",
  "jhu": "Johns Hopkins University",
  "wustl": "Washington University in St Louis",
  "washu": "Washington University in St Louis",
  "uf": "University of Florida",
  "umd": "University of Maryland-College Park",
  "rutgers": "Rutgers University-New Brunswick",
  "asu": "Arizona State University",
  "msu": "Michigan State University",
  "fsu": "Florida State University",
  "ucf": "University of Central Florida",
  "rpi": "Rensselaer Polytechnic Institute",
  "wpi": "Worcester Polytechnic Institute",
  "njit": "New Jersey Institute of Technology",
  "virginia tech": "Virginia Tech",
};

export function expandCollegeAlias(name) {
  const key = String(name || "").toLowerCase()
    .replace(/[^a-z0-9&\s]/g, " ").replace(/\s+/g, " ").trim();
  return COLLEGE_NAME_ALIASES[key] || name;
}

// Choose the Scorecard result that actually matches what the student typed.
// The API's name filter is a TOKENIZED keyword search — "New York University"
// returns SUNY New Paltz and Dominican University New York before NYU — so a
// blind first-result fallback binds the wrong school. Prefer exact, then
// prefix/containment, then a strict token-overlap score; otherwise return
// null and let the caller report not-found rather than a wrong school.
export function pickScorecardHit(results, collegeName) {
  const list = (Array.isArray(results) ? results : []).filter((r) => r?.website);
  if (!list.length) return null;
  const wanted = String(collegeName || "").trim().toLowerCase();
  const nameOf = (r) => String(r.name || "").toLowerCase();
  const exact = list.find((r) => nameOf(r) === wanted);
  if (exact) return exact;
  const prefix = list.find((r) => nameOf(r).startsWith(wanted));
  if (prefix) return prefix;
  const contains = list.find((r) => nameOf(r).includes(wanted) || (nameOf(r) && wanted.includes(nameOf(r))));
  if (contains) return contains;

  const wantedTokens = new Set(wanted.split(/[^a-z0-9]+/).filter(Boolean));
  let best = null;
  let bestScore = 0;
  for (const r of list) {
    const tokens = nameOf(r).split(/[^a-z0-9]+/).filter(Boolean);
    const overlap = tokens.filter((t) => wantedTokens.has(t)).length;
    const score = overlap / Math.max(tokens.length, wantedTokens.size, 1);
    if (score > bestScore) { best = r; bestScore = score; }
  }
  return bestScore >= 0.8 ? best : null;
}

// Resolve the school's OFFICIAL site. The College Scorecard (U.S. Dept. of
// Education) is the authority; a caller-provided hint URL is honored only on
// academic hosts or the resolved domain.
async function resolveOfficialSite({ collegeName, hintUrl, scorecardKey, fetchImpl }) {
  let displayName = String(collegeName || "").trim();
  let homepage = null;
  let unitId = null;

  if (scorecardKey) {
    try {
      // limit 20: the tokenized name search can bury the real school deep in
      // the result list ("New York University" ranks 8th for its own name).
      let search = await searchScorecard(scorecardKey, { name: displayName, limit: 20 });
      let hit = pickScorecardHit(search?.results, displayName);
      if (!hit) {
        // Graduate-predominant institutions fall outside the default
        // bachelor's-only search — retry without the level filter.
        search = await searchScorecard(scorecardKey, { name: displayName, limit: 20, anyLevel: true });
        hit = pickScorecardHit(search?.results, displayName);
      }
      if (hit) {
        homepage = normalizeHomepage(hit.website);
        displayName = hit.name || displayName;
        unitId = hit.unitId ?? hit.id ?? null;
      }
    } catch { /* fall through to hint */ }
  }

  let safeHint = null;
  const normalizedHint = normalizeHomepage(hintUrl);
  if (normalizedHint && (ACADEMIC_HOST_RE.test(hostOf(normalizedHint)) || (homepage && sameSite(normalizedHint, homepage)))) {
    safeHint = normalizedHint;
  }
  if (!homepage && safeHint) {
    try { homepage = new URL(safeHint).origin + "/"; } catch { /* ignore */ }
  }

  return { displayName, homepage, hintUrl: safeHint, unitId, fetchImpl };
}

async function gatherPages({ homepage, hintUrl, keywordRe, fetchImpl }) {
  const pages = [];
  const tried = new Set();
  const tryFetch = async (url) => {
    const key = String(url || "").replace(/\/+$/, "");
    if (!key || tried.has(key) || pages.length >= MAX_PAGES) return;
    tried.add(key);
    const page = await fetchOfficialPage(url, { fetchImpl });
    if (page) pages.push(page);
  };

  if (hintUrl) await tryFetch(hintUrl);
  let homepageHtml = null;
  if (homepage && pages.length < MAX_PAGES) {
    const page = await fetchOfficialPage(homepage, { fetchImpl });
    if (page) { pages.push(page); homepageHtml = page.html; }
  }
  if (homepageHtml) {
    for (const link of harvestLinks(homepageHtml, homepage, keywordRe)) {
      if (pages.length >= MAX_PAGES) break;
      await tryFetch(link);
    }
  }
  return pages;
}

// ─── Model plumbing ─────────────────────────────────────────────────────
function parseModelJson(replyText) {
  const cleaned = String(replyText || "").replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Model reply contained no JSON object");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function replyText(result) {
  return (result?.content || [])
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text).join("");
}

function serializePages(pages) {
  return pages.map((page, index) => `PAGE ${index + 1} — ${page.url}\n${page.text}`).join("\n\n────────\n\n");
}

function researchError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 404;
  return error;
}

// ─── Values research ────────────────────────────────────────────────────
export async function researchCollegeValues({
  collegeName, hintUrl = null, scorecardKey = null,
  callLLM, model, stmts, now = new Date(), force = false, fetchImpl = fetch,
}) {
  collegeName = expandCollegeAlias(collegeName);
  const slug = slugifyCollege(collegeName);
  if (!slug) throw researchError("bad_name", "A college name is required.");
  const cacheKey = "values:" + slug;
  if (!force) {
    const cached = cacheRead(stmts, cacheKey, VALUES_TTL_DAYS, now);
    if (cached) return { ...cached, cached: true };
  }

  const site = await resolveOfficialSite({ collegeName, hintUrl, scorecardKey, fetchImpl });
  if (!site.homepage && !site.hintUrl) {
    throw researchError("school_site_not_found", `Couldn't find "${collegeName}" in the US College Scorecard. Try the exact official name (e.g. "Stony Brook University", not "SBU") — or, for non-US universities, paste an official page URL (.edu, .ac.xx, or .edu.xx) in the URL field.`);
  }
  const pages = await gatherPages({ homepage: site.homepage, hintUrl: site.hintUrl, keywordRe: VALUES_LINK_RE, fetchImpl });
  if (pages.length === 0) {
    throw researchError("no_official_pages", `Couldn't read any pages from ${site.homepage || site.hintUrl}. The site may block automated access — paste a specific page URL as a hint.`);
  }

  const system = [
    "You extract a university's EXPLICITLY STATED institutional values from official pages of its own website. Reply with ONLY valid JSON, no markdown fences.",
    'Schema: {"values": [{"theme": "<2-5 word value theme in title case>", "summary": "<one sentence in your own words>", "evidence": "<EXACT quote of at most 25 words copied verbatim from the page text>", "sourceUrl": "<the PAGE url the quote came from>"}]}',
    "Rules:",
    "- 3 to 6 distinct VALUE themes (what the school says it cares about: e.g. service, intellectual curiosity, civic engagement).",
    "- Values are NOT features: student-faculty ratios, rankings, campus amenities, and statistics are not values.",
    "- \"evidence\" must be copied character-for-character from the provided page text. Never paraphrase inside evidence.",
    "- \"sourceUrl\" must be one of the provided PAGE urls.",
    "- If the pages contain no stated values, return {\"values\": []}.",
  ].join("\n");

  const result = await callLLM({
    model,
    max_tokens: 1600,
    temperature: 0,
    system,
    messages: [{ role: "user", content: serializePages(pages) }],
  });
  const parsed = parseModelJson(replyText(result));
  const values = [];
  for (const item of Array.isArray(parsed?.values) ? parsed.values : []) {
    const theme = String(item?.theme || "").trim().slice(0, 80);
    const summary = String(item?.summary || "").trim().slice(0, 300);
    if (!theme || !summary) continue;
    const verifiedUrl = verifyQuote(item?.evidence, pages);
    values.push({
      theme,
      summary,
      // Only serve quotes that verifiably appear in the fetched official text.
      evidence: verifiedUrl ? String(item.evidence).trim().slice(0, 300) : null,
      sourceUrl: verifiedUrl || (pages.some((p) => p.url === item?.sourceUrl) ? item.sourceUrl : pages[0].url),
      quoteVerified: Boolean(verifiedUrl),
    });
    if (values.length >= 6) break;
  }
  if (values.length < 2) {
    throw researchError("values_not_found", `The fetched pages from ${hostOf(pages[0].url)} didn't state institutional values clearly enough to extract. Try hinting a mission/about page URL.`);
  }

  const payload = {
    displayName: site.displayName,
    slug,
    unitId: site.unitId,
    values,
    sources: pages.map((p) => p.url),
    sourceUrl: values.find((v) => v.quoteVerified)?.sourceUrl || pages[0].url,
    extractedAt: now.toISOString(),
  };
  stmts?.put?.run(cacheKey, "values", slug, payload.displayName, JSON.stringify(payload), now.toISOString());
  return { ...payload, cached: false };
}

// ─── Deadline research ──────────────────────────────────────────────────
export async function researchCollegeDeadlines({
  collegeName, hintUrl = null, scorecardKey = null,
  callLLM, model, stmts, now = new Date(), force = false, fetchImpl = fetch,
}) {
  collegeName = expandCollegeAlias(collegeName);
  const slug = slugifyCollege(collegeName);
  if (!slug) throw researchError("bad_name", "A college name is required.");
  const cycle = currentAdmissionsCycle(now);
  const cacheKey = `deadlines:${slug}:${cycle}`;
  if (!force) {
    const cached = cacheRead(stmts, cacheKey, DEADLINES_TTL_DAYS, now);
    if (cached) return { ...cached, cached: true };
  }

  const site = await resolveOfficialSite({ collegeName, hintUrl, scorecardKey, fetchImpl });
  if (!site.homepage && !site.hintUrl) {
    throw researchError("school_site_not_found", `Couldn't resolve an official site for "${collegeName}".`);
  }
  const pages = await gatherPages({ homepage: site.homepage, hintUrl: site.hintUrl, keywordRe: DEADLINES_LINK_RE, fetchImpl });
  if (pages.length === 0) {
    throw researchError("no_official_pages", `Couldn't read any pages from ${site.homepage || site.hintUrl}.`);
  }

  const system = [
    "You extract first-year admissions deadline DATES from official pages of a university's own website. Reply with ONLY valid JSON, no markdown fences.",
    'Schema: {"ea": "YYYY-MM-DD"|null, "ed": "YYYY-MM-DD"|null, "rd": "YYYY-MM-DD"|null, "financialAid": "YYYY-MM-DD"|null, "commitBy": "YYYY-MM-DD"|null, "decisionRelease": "YYYY-MM-DD"|null, "sourceUrl": "<page url>"}',
    "Rules:",
    `- Report dates for the ${cycle} first-year application cycle (applications submitted in fall ${cycle.slice(0, 4)} for entry the following fall). When a page gives a month and day without a year, infer the year from that cycle.`,
    "- ea = Early Action, ed = Early Decision (use ED I if multiple rounds), rd = Regular Decision, financialAid = the aid/CSS/FAFSA priority date, commitBy = the enrollment deposit date, decisionRelease = when RD decisions come out.",
    "- Use ONLY dates explicitly stated in the page text. A field the pages don't state is null. NEVER guess or use typical dates.",
    "- \"sourceUrl\" must be the provided PAGE url the dates came from.",
  ].join("\n");

  const result = await callLLM({
    model,
    max_tokens: 400,
    temperature: 0,
    system,
    messages: [{ role: "user", content: serializePages(pages) }],
  });
  const parsed = parseModelJson(replyText(result));
  const deadlines = sanitizeDeadlineDates(parsed, now);
  if (!Object.values(deadlines).some(Boolean)) {
    throw researchError("deadlines_not_found", `The fetched pages from ${hostOf(pages[0].url)} didn't state ${cycle} deadlines. Try hinting the admissions deadlines page URL.`);
  }

  const payload = {
    displayName: site.displayName,
    slug,
    cycle,
    deadlines,
    sourceUrl: pages.some((p) => p.url === parsed?.sourceUrl) ? parsed.sourceUrl : pages[0].url,
    extractedAt: now.toISOString(),
  };
  stmts?.put?.run(cacheKey, "deadlines", slug, payload.displayName, JSON.stringify(payload), now.toISOString());
  return { ...payload, cached: false };
}

// Cache-only read for callers that must never trigger live research (e.g.
// the periodic calendar-context refresh with many target schools).
export function readCachedDeadlines(stmts, collegeName, now = new Date()) {
  const slug = slugifyCollege(expandCollegeAlias(collegeName));
  if (!slug) return null;
  return cacheRead(stmts, `deadlines:${slug}:${currentAdmissionsCycle(now)}`, DEADLINES_TTL_DAYS, now);
}
