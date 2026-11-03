// chat-11's last piece: a chat turn whose student cancelled or timed out
// used to keep waiting up to 15 s on an on-demand read of a school's own
// pages (and on the College Scorecard), and the page reads went on for
// nobody. The turn's signal now reaches both reads. Every host resolves to a
// public address through a stubbed DNS lookup (the scout also tries the
// admission. and admissions. subdomains, which a real lookup would send
// out), and fetch is a stub that answers only by being aborted: nothing
// leaves the machine.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { bindVerifiedData, scorecardStatsOnDemand, scoutSchoolOnDemand } from "../server/verified-data.js";
import { readServerSource } from "./helpers/server-source.mjs";

const realFetch = globalThis.fetch;
const realLookup = dns.lookup;
let fetchSignals;

// Every request hangs until its signal aborts, then rejects as fetch does.
function hangingFetch() {
  fetchSignals = [];
  globalThis.fetch = (url, init = {}) => {
    const signal = init.signal;
    fetchSignals.push({ url: String(url), signal });
    return new Promise((_, reject) => {
      const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (signal?.aborted) return fail();
      signal?.addEventListener("abort", fail, { once: true });
    });
  };
}

function bind(overrides = {}) {
  const deps = {
    db: {},
    onDemandScouts: new Map(),
    resolveBaselineCollegeRow: () => ({ name: "Example University", unit_id: "999999", website: "http://93.184.216.34/" }),
    policyScoutStmts: { getSnapshot: { get: () => null }, upsertSnapshot: { run() {} }, insertChange: { run() {} } },
    factStmts: {},
    SCORECARD_API_KEY: null,
    ...overrides,
  };
  bindVerifiedData(deps);
  return deps;
}

async function until(check, label) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

beforeEach(() => {
  hangingFetch();
  dns.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
});
afterEach(() => {
  globalThis.fetch = realFetch;
  dns.lookup = realLookup;
});

test("a closed turn stops waiting on the school's pages, and the read stops with it", async () => {
  const deps = bind();
  const turn = new AbortController();
  const started = Date.now();
  const pending = scoutSchoolOnDemand("Example University", { signal: turn.signal, timeoutMs: 10_000 });
  await until(() => fetchSignals.length > 0, "the first page request");
  turn.abort();
  assert.equal(await pending, "aborted");
  assert.ok(Date.now() - started < 5_000, "the turn did not wait out the read");
  assert.equal(fetchSignals[0].signal.aborted, true, "the page request in flight was stopped");
  await until(() => deps.onDemandScouts.size === 0, "the shared read to end");
});

// backend-1: the fetcher swallows each page's error, so a read stopped
// part-way still came back with the pages it had, and scoutSchool stored
// that partial reading as the school's current snapshot. A student who
// pressed Stop on a deadline question could leave Regular Decision missing
// for every student until the cycle turned. A stopped read now writes
// nothing, and a turn after it starts a fresh read. Fetch answers the
// landing page from a table and hangs on everything after it.
test("a read stopped part-way stores no snapshot, and the next turn starts a fresh read", async () => {
  const filler = "First-year applicants choose one round. ".repeat(6);
  const landing = `<html><body><p>${filler}Early Decision deadline: November 1.</p><a href="/apply/deadlines">Application deadlines</a></body></html>`;
  const requested = [];
  globalThis.fetch = (url, init = {}) => {
    const href = String(url);
    requested.push(href);
    if (href.endsWith("/robots.txt") && href.startsWith("https://admission.example.edu")) return Promise.resolve(new Response("", { status: 404 }));
    if (href === "https://admission.example.edu/") return Promise.resolve(new Response(landing, { status: 200, headers: { "content-type": "text/html" } }));
    // Every later page hangs until the read is stopped.
    return new Promise((_, reject) => {
      const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (init.signal?.aborted) return fail();
      init.signal?.addEventListener("abort", fail, { once: true });
    });
  };
  let snapshotReads = 0;
  const writes = [];
  const deps = bind({
    resolveBaselineCollegeRow: () => ({ name: "Example University", unit_id: "999999", website: "https://www.example.edu/" }),
    policyScoutStmts: {
      getSnapshot: { get: () => { snapshotReads += 1; return null; } },
      upsertSnapshot: { run: (...args) => { writes.push(["snapshot", args[0]]); } },
      insertChange: { run: (...args) => { writes.push(["change", args[1]]); } },
    },
  });
  const turn = new AbortController();
  const pending = scoutSchoolOnDemand("Example University", { signal: turn.signal, timeoutMs: 10_000 });
  // The landing page has been read; the next host's request hangs.
  await until(() => requested.some((u) => u.startsWith("https://admissions.example.edu")), "the second host's request");
  turn.abort();
  assert.equal(await pending, "aborted");
  assert.equal(deps.onDemandScouts.size, 0, "a turn after the stop does not join the stopped read");

  // The stopped read ends with the one page it had, at the point where it
  // would have stored it.
  await until(() => snapshotReads > 0, "the stopped read to reach the store");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, [], "a partial reading is not stored as the school's snapshot");
});

test("a read another turn still waits on keeps going until that turn leaves too", async () => {
  bind();
  const first = new AbortController();
  const second = new AbortController();
  const a = scoutSchoolOnDemand("Example University", { signal: first.signal, timeoutMs: 10_000 });
  const b = scoutSchoolOnDemand("Example University", { signal: second.signal, timeoutMs: 10_000 });
  await until(() => fetchSignals.length > 0, "the first page request");
  first.abort();
  assert.equal(await a, "aborted");
  assert.equal(fetchSignals[0].signal.aborted, false, "the second turn still waits on this read");
  second.abort();
  assert.equal(await b, "aborted");
  await until(() => fetchSignals.every((f) => f.signal.aborted), "the read to stop");
});

test("a turn already closed starts no read at all", async () => {
  const deps = bind();
  const turn = new AbortController();
  turn.abort();
  assert.equal(await scoutSchoolOnDemand("Example University", { signal: turn.signal }), "aborted");
  assert.equal(deps.onDemandScouts.size, 0);
  assert.equal(fetchSignals.length, 0);
});

test("a closed turn stops waiting on the College Scorecard", async () => {
  bind({ SCORECARD_API_KEY: "test-scorecard-key" });
  const turn = new AbortController();
  const pending = scorecardStatsOnDemand("Example University", { signal: turn.signal });
  await until(() => fetchSignals.length > 0, "the Scorecard request");
  turn.abort();
  assert.equal(await pending, null);
  const closed = new AbortController();
  closed.abort();
  const before = fetchSignals.length;
  assert.equal(await scorecardStatsOnDemand("Example University", { signal: closed.signal }), null);
  assert.equal(fetchSignals.length, before, "no search for a turn already closed");
});

test("the chat route hands the turn's signal to both on-demand reads", () => {
  const source = readServerSource();
  assert.match(source, /scoutSchoolOnDemand\(namedSchools\[0\], \{ signal: turnAbort\.signal \}\)/);
  assert.match(source, /scorecardStatsOnDemand\(namedSchools\[0\], \{ signal: turnAbort\.signal \}\)/);
});
