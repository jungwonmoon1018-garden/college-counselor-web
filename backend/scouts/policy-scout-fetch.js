// policy-scout-fetch.js — how the scout reaches a school's own pages: the
// robots.txt rules it honors, the guarded fetcher (SSRF checks, size and time
// limits, per-host delay), the official-site resolution and the discovery of
// policy pages. Moved out of admissions-policy-scout.js on 2026-09-20, which
// re-exports what it exported.
import { assertSafeFetchTarget } from "../security/safe-fetch.js";
import { htmlToText, sameSite, pickScorecardHit, expandCollegeAlias } from "../colleges/college-research.js";
import { searchScorecard } from "../colleges/college-scorecard.js";

export const SCOUT_USER_AGENT = "CollegeCounselorBot/1.0 (educational; admissions-policy watch)";

const FETCH_TIMEOUT_MS = 10_000;

const MAX_PAGE_BYTES = 700_000;

const MAX_PAGE_TEXT_CHARS = 20_000;

const MAX_FETCHES_PER_SCHOOL = 12;

const MAX_PAGES_PER_SCHOOL = 7;

const PER_HOST_DELAY_MS = 1_000;

const PROBE_PATHS = [
  "/admission", "/admissions", "/apply",
  "/admission/first-year", "/admissions/first-year", "/apply/first-year", "/apply/firstyear",
  "/admission/deadlines", "/admissions/deadlines", "/apply/deadlines",
  "/admission/testing", "/admissions/testing", "/apply/first-year/testing",
  "/admission/standardized-testing", "/admissions/standardized-testing",
];

// ─── robots.txt ────────────────────────────────────────────────────────
export function parseRobots(text) {
  const groups = [];
  let current = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      // Consecutive User-agent lines share one group; a User-agent after
      // rules starts a new group.
      if (!current || current.rules.length) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((key === "disallow" || key === "allow") && current) {
      current.rules.push({ allow: key === "allow", path: value });
    }
  }
  return groups;
}

function robotsPatternToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped.endsWith("$") ? escaped.slice(0, -1) + "$" : escaped}`);
}

export function robotsAllows(groups, pathname, agent = "collegecounselorbot") {
  const wanted = agent.toLowerCase();
  const group = groups.find((g) => g.agents.some((a) => a === wanted || (a !== "*" && wanted.includes(a))))
    || groups.find((g) => g.agents.includes("*"));
  if (!group) return true;
  let verdict = true;
  let longest = -1;
  for (const rule of group.rules) {
    if (!rule.path) continue; // "Disallow:" (empty) allows everything
    if (!robotsPatternToRegExp(rule.path).test(pathname)) continue;
    if (rule.path.length > longest) { longest = rule.path.length; verdict = rule.allow; }
  }
  return verdict;
}

// ─── Guarded fetching ──────────────────────────────────────────────────
export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

export function makeFetcher({ fetchImpl = fetch, assertTarget = assertSafeFetchTarget, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const lastHit = new Map();
  const robotsCache = new Map();

  async function throttle(url) {
    const host = hostOf(url);
    const wait = (lastHit.get(host) || 0) + PER_HOST_DELAY_MS - now();
    if (wait > 0) await sleep(wait);
    lastHit.set(host, now());
  }

  // The timeout covers the whole exchange, body included — clearing it once
  // the headers arrive would let a slow body hang a run indefinitely.
  const debug = process.env.POLICY_SCOUT_DEBUG === "1";
  async function rawGet(url, accept, readBody) {
    const started = Date.now();
    await assertTarget(url);
    await throttle(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { "User-Agent": SCOUT_USER_AGENT, "Accept": accept },
        redirect: "follow",
      });
      const result = await readBody(response);
      if (debug) console.log(`[policy-scout] GET ${url} → ${response.status} ${response.url && response.url !== url ? `(→ ${response.url}) ` : ""}${Date.now() - started}ms${result ? "" : " (discarded)"}`);
      return result;
    } catch (err) {
      if (debug) console.log(`[policy-scout] GET ${url} failed after ${Date.now() - started}ms: ${err?.name || err?.message}`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function allowed(url) {
    let origin;
    try { origin = new URL(url).origin; } catch { return false; }
    if (!robotsCache.has(origin)) {
      let groups = [];
      try {
        groups = await rawGet(`${origin}/robots.txt`, "text/plain", async (response) => (
          response.ok ? parseRobots((await response.text()).slice(0, 200_000)) : []
        ));
      } catch { groups = []; }
      robotsCache.set(origin, groups);
    }
    return robotsAllows(robotsCache.get(origin), new URL(url).pathname);
  }

  async function page(url, { acceptFinalUrl = null } = {}) {
    try {
      if (!(await allowed(url))) return { url, blocked: "robots" };
      return await rawGet(url, "text/html,application/xhtml+xml,text/plain;q=0.8", async (response) => {
        if (!response.ok) return null;
        const finalUrl = response.url || url;
        // Redirects must land on the school's site — or on a host the
        // caller vouches for (its off-site admissions domain).
        if (!sameSite(finalUrl, url) && !hostOf(finalUrl).endsWith(".edu") && !(acceptFinalUrl && acceptFinalUrl(finalUrl))) return null;
        // Soft 404s: a 200 that redirected to the site's error page.
        if (/404|not-?found|\/errors?\//i.test(pathAndQuery(finalUrl))) return null;
        const contentType = String(response.headers?.get?.("content-type") || "");
        if (contentType && !/text\/html|application\/xhtml|text\/plain/i.test(contentType)) return null;
        const html = (await response.text()).slice(0, MAX_PAGE_BYTES);
        const text = htmlToText(html).slice(0, MAX_PAGE_TEXT_CHARS);
        if (!text || text.length < 120) return null;
        return { url: finalUrl, html, text };
      });
    } catch {
      return null;
    }
  }

  return { page };
}

// ─── Official site resolution ──────────────────────────────────────────
function normalizeHomepage(url) {
  const value = String(url || "").trim();
  if (!value) return null;
  const withProto = /^https?:\/\//i.test(value) ? value : "https://" + value;
  try { return new URL(withProto).origin + "/"; } catch { return null; }
}

export async function resolveSchoolSite({ name, unitId = null, website = null, scorecardKey = null }) {
  let displayName = expandCollegeAlias(String(name || "").trim());
  let homepage = normalizeHomepage(website);
  let resolvedUnitId = unitId ? String(unitId) : null;
  if (!homepage && scorecardKey) {
    try {
      let search = await searchScorecard(scorecardKey, { name: displayName, limit: 20 });
      let hit = pickScorecardHit(search?.results, displayName);
      if (!hit) {
        search = await searchScorecard(scorecardKey, { name: displayName, limit: 20, anyLevel: true });
        hit = pickScorecardHit(search?.results, displayName);
      }
      if (hit) {
        homepage = normalizeHomepage(hit.website);
        displayName = hit.name || displayName;
        resolvedUnitId = resolvedUnitId || (hit.unitId ?? hit.id ? String(hit.unitId ?? hit.id) : null);
      }
    } catch { /* unresolved → skipped below */ }
  }
  return { displayName, homepage, unitId: resolvedUnitId };
}

// ─── Page discovery ────────────────────────────────────────────────────
// Links are ranked by how specifically their PATH or anchor text points at
// policy content. Matching the whole URL would score every link on
// admission.<school>.edu equally (the hostname itself matches "admission"),
// which let a landing page's nav crowd out the deadlines and testing pages.
// Word-bounded on purpose: "Updates" must not count as "dates", and
// "Admission Volunteers" is not a policy page.
const LINK_SCORES = [
  [/\bdeadlines?\b|\bdates\b|dates-and-deadlines/i, 5],
  [/\btesting\b|\btests?\b|test-optional|test-policy|standardized|test-scores|tests-scores/i, 5],
  [/first-year|firstyear|\bfreshman\b|first-time/i, 4],
  [/\brequirements?\b|how-to-apply|\bapply\b|\bapplication\b/i, 3],
  [/\badmissions?\b/i, 1],
];

// Application portals, logins, and news feeds never carry policy text.
const LINK_EXCLUDE_RE = /\/portal\/|\blogin\b|\bsign-?in\b|\bstatus\b|\bnews\b|\bblog|\bevents?\b|\bvisit\b|\btour\b|announcement/i;

const MIN_LANDING_LINK_SCORE = 3;

const MIN_DEEP_LINK_SCORE = 4;

function pathAndQuery(url) {
  try { const u = new URL(url); return u.pathname + u.search; } catch { return ""; }
}

function scoreLink(url, anchorText) {
  const path = pathAndQuery(url);
  if (/\.(pdf|jpe?g|png|gif|zip|docx?)$/i.test(path)) return 0;
  if (LINK_EXCLUDE_RE.test(`${hostOf(url)}${path}`)) return 0;
  const text = `${path} ${anchorText}`;
  let score = 0;
  for (const [re, points] of LINK_SCORES) if (re.test(text)) score += points;
  return score;
}

// The school's registrable domain ("mit.edu" for web.mit.edu) and its
// distinctive token ("mit"). Scorecard often reports a deep homepage host,
// and "web" or "home" would match nothing.
export function schoolRootHost(host) {
  const labels = String(host || "").toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  return labels.length > 2 ? labels.slice(-2).join(".") : labels.join(".");
}

export function schoolDomainToken(host) {
  return schoolRootHost(host).split(".")[0] || "";
}

// A host that carries the school's own domain token and says "admission"
// or "apply" (mit.edu → mitadmissions.org) is the school's admissions site.
function isSchoolAdmissionsHost(host, domainToken) {
  return domainToken.length >= 3 && host.includes(domainToken) && /admission|apply/i.test(host);
}

// Same-site links, plus — bounded — an off-site admissions host that carries
// the school's own domain token (mit.edu → mitadmissions.org): several
// schools run admissions on a separate domain, and refusing it means never
// seeing their policy pages at all.
export function rankedPolicyLinks(html, baseUrl, { allowedHosts = [], domainToken = "" } = {}) {
  const out = new Map();
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#\s]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(String(html || "")))) {
    const [, href, inner] = match;
    if (/^(mailto:|tel:|javascript:)/i.test(href)) continue;
    let resolved;
    try { resolved = new URL(href, baseUrl).toString(); } catch { continue; }
    if (!/^https?:/i.test(resolved)) continue;
    const anchor = htmlToText(inner).slice(0, 120);
    const onSite = sameSite(resolved, baseUrl) || allowedHosts.some((h) => sameSite(resolved, `https://${h}/`));
    let score = scoreLink(resolved, anchor);
    if (!onSite) {
      const host = hostOf(resolved);
      const admissionsHost = isSchoolAdmissionsHost(host, domainToken)
        || (domainToken.length >= 3 && host.includes(domainToken) && /admission|apply/i.test(anchor));
      if (!admissionsHost) continue;
      score += 2;
    }
    if (score <= 0) continue;
    const key = resolved.replace(/\/+$/, "");
    if (!out.has(key) || out.get(key).score < score) out.set(key, { url: resolved, score, offSite: !onSite });
  }
  return [...out.values()].sort((a, b) => b.score - a.score);
}

export async function gatherPolicyPages(homepage, fetcher) {
  const pages = [];
  const tried = new Set();
  const seenFinal = new Set();
  let fetches = 0;
  let blocked = 0;
  const origin = new URL(homepage).origin;
  const host = schoolRootHost(hostOf(homepage));
  const domainToken = schoolDomainToken(host);
  const allowedHosts = [];
  const linkOptions = () => ({ allowedHosts, domainToken });
  const acceptFinalUrl = (finalUrl) => {
    const finalHost = hostOf(finalUrl);
    return allowedHosts.some((h) => sameSite(finalUrl, `https://${h}/`)) || isSchoolAdmissionsHost(finalHost, domainToken);
  };

  const visit = async (url) => {
    const key = String(url || "").replace(/\/+$/, "");
    if (!key || tried.has(key) || pages.length >= MAX_PAGES_PER_SCHOOL || fetches >= MAX_FETCHES_PER_SCHOOL) return null;
    tried.add(key);
    fetches += 1;
    const page = await fetcher.page(url, { acceptFinalUrl });
    if (page?.blocked) { blocked += 1; return null; }
    if (!page) return null;
    // admission.<host> and admissions.<host> usually redirect to one place.
    const finalKey = String(page.url).replace(/\/+$/, "");
    if (seenFinal.has(finalKey)) return null;
    seenFinal.add(finalKey);
    const finalHost = hostOf(page.url);
    if (!sameSite(page.url, `https://${host}/`) && !allowedHosts.includes(finalHost)) allowedHosts.push(finalHost);
    pages.push(page);
    return page;
  };

  // The admissions office usually lives on its own subdomain; those landing
  // pages are the richest single source, so try them first.
  const landing = [];
  for (const sub of [`https://admission.${host}/`, `https://admissions.${host}/`]) {
    const page = await visit(sub);
    if (page) landing.push(page);
  }
  const home = await visit(homepage);
  if (home) landing.push(home);

  const ranked = [];
  for (const page of landing) ranked.push(...rankedPolicyLinks(page.html, page.url, linkOptions()));
  ranked.sort((a, b) => b.score - a.score);
  for (const link of ranked) {
    if (link.score < MIN_LANDING_LINK_SCORE) break;
    if (pages.length >= MAX_PAGES_PER_SCHOOL - 2 || fetches >= MAX_FETCHES_PER_SCHOOL - 3) break;
    if (link.offSite && !allowedHosts.includes(hostOf(link.url))) allowedHosts.push(hostOf(link.url));
    await visit(link.url);
  }
  if (pages.length < 3) {
    const origins = [origin, ...allowedHosts.map((h) => `https://${h}`)];
    for (const base of origins) {
      for (const path of PROBE_PATHS) {
        if (pages.length >= 3 || fetches >= MAX_FETCHES_PER_SCHOOL - 2) break;
        await visit(base + path);
      }
    }
  }
  // Deeper from the admissions pages: the testing and deadline pages are
  // usually one or two clicks below the landing page (home → admissions site
  // → first-year → tests & deadlines), so expand twice within the budget.
  const expanded = new Set();
  for (let round = 0; round < 2; round += 1) {
    const deeper = [];
    for (const page of pages.slice()) {
      if (expanded.has(page.url)) continue;
      expanded.add(page.url);
      deeper.push(...rankedPolicyLinks(page.html, page.url, linkOptions()).filter((l) => l.score >= MIN_DEEP_LINK_SCORE));
    }
    deeper.sort((a, b) => b.score - a.score);
    for (const link of deeper) {
      if (pages.length >= MAX_PAGES_PER_SCHOOL || fetches >= MAX_FETCHES_PER_SCHOOL) break;
      await visit(link.url);
    }
  }
  return { pages, fetches, blocked };
}
