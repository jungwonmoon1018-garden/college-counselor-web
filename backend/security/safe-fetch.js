// security/safe-fetch.js — the SSRF guard every outbound fetch of a URL
// that is not a constant goes through: the destination is resolved and
// checked against private ranges before the request and again on every
// redirect hop. Moved out of cds/cds-ingest-pipeline.js on 2026-09-22 so
// cds-search.js could use it without importing the pipeline back.
import net from "node:net";
import dns from "node:dns/promises";

// SSRF guard for downloadCDS: link targets originate from a scraped
// third-party repository index (cds-search.js) merged with the operator
// index, not from any student/attacker-reachable input — but a compromised
// or careless upstream source could still point at an internal address, so
// resolve-and-check the actual destination IP (not just the hostname string,
// which DNS could rebind) before every fetch AND every redirect hop.
const BLOCKED_IPV4_RANGES = [
  [/^0\./, "unspecified"],
  [/^10\./, "private"],
  [/^127\./, "loopback"],
  [/^169\.254\./, "link-local"],
  [/^172\.(1[6-9]|2\d|3[01])\./, "private"],
  [/^192\.168\./, "private"],
  [/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, "carrier-grade-nat"],
];

export function isBlockedIp(address, family) {
  if (family === 6 || net.isIPv6(address)) {
    const a = address.toLowerCase();
    if (a === "::1" || a === "::") return true;
    if (a.startsWith("::ffff:")) return isBlockedIp(a.slice(7), 4);
    if (/^fe80:/.test(a)) return true; // link-local
    if (/^f[cd][0-9a-f]{2}:/.test(a)) return true; // unique local (fc00::/7)
    return false;
  }
  return BLOCKED_IPV4_RANGES.some(([re]) => re.test(address));
}

export async function assertSafeFetchTarget(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Refusing to fetch a malformed URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Refusing to fetch a non-http(s) URL: ${rawUrl}`);
  }
  let addresses;
  try {
    addresses = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
  } catch {
    throw new Error(`Refusing to fetch an unresolvable host: ${parsed.hostname}`);
  }
  if (addresses.length === 0 || addresses.some((a) => isBlockedIp(a.address, a.family))) {
    throw new Error(`Refusing to fetch a URL that resolves to a non-public address: ${parsed.hostname}`);
  }
  return parsed;
}

// fetch() with redirect:"follow" would otherwise let a validated first hop
// redirect straight to an internal address. Follow manually and re-validate
// every Location header the same way as the initial URL. `fetchImpl` and
// `assertTarget` are for tests, which stand in a fake site for both.
export async function safeFetch(rawUrl, options, { maxRedirects = 5, fetchImpl = fetch, assertTarget = assertSafeFetchTarget } = {}) {
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertTarget(current);
    const res = await fetchImpl(current, { ...options, redirect: "manual" });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location"), current).toString();
      continue;
    }
    return res;
  }
  throw new Error(`Too many redirects fetching ${rawUrl}`);
}
