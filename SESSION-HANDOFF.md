# Session handoff

One current document for whoever picks this repository up next — a person
or a fresh Claude session with no access to the conversation that produced
it. Read `CLAUDE.md` first: it is the edit-time harness (invariants, how to
prove a change, how to land it). This file says where things stand, what
changed recently and why, what was verified live, and what is open.

## Where things stand (2026-09-07)

- **Deployed:** `main` at `f9a8346`, live at
  https://college-counselor-web.onrender.com. Five backend-only commits
  went out on 2026-09-07 (`81e400b`, `3185827`, `f51e9ef`, `be12040`,
  `f9a8346`), each after CI passed; the student bundle is still
  `main-C3Z-asGA.js` from `cb73dd8`. Render redeploys on every push to
  `main`, including a handoff-only commit, and each deploy restarts the
  process (a few seconds of 502s).
- **Tests:** backend `npm test` 658 tests, 653 pass, 5 skipped, 0 fail;
  `npm run lint` 0 errors, 70 warnings (CI cap 500); frontend untouched
  this session (25 vitest tests passed in CI).
- **Working tree:** clean apart from the repository's phantom CRLF-only
  diffs (never stage them; two of them, `backend/tools/cds-validator.js`
  and `backend/tools/cds-cache/_corrections.json`, got normalized to LF in
  `3185827` because they had to change) and two untracked files:
  `backend/kor.traineddata` (a Tesseract Korean model left by the OCR work)
  and `AGENTS.md` at the root, a copy of `CLAUDE.md` with "Claude" changed
  to "Codex" in two places. Neither was made by this session; neither is
  committed. Delete or keep as you see fit.
- **Standing authorizations from the user:** push straight to `main`; create
  and delete throwaway student accounts on production for live checks.
  Never ask for or use the counselor's password or a real student's. The
  user also approved, on 2026-09-07, downloading Columbia's official CDS
  PDF into the cache ("Yes, go ahead and replace the Columbia PDF").
- **Deferred by the user:** the University of Wyoming College Fit data-source
  precedence ("Wait, the wyoming is not answering. I think that it would be
  ok for that to be dealt with that later"). Do not pursue until asked.

## What changed, newest first

Each item names the commit that carries it. Earlier sessions' work is
summarized at the end.

**Older snapshots are re-read on demand; sweeps read stale schools first
(2026-09-07)** — `f9a8346`. The version-4 sweep refreshed Brown and
Carnegie Mellon in its first minute and then spent its sixty-school cap
(`POLICY_SCOUT_MAX_SCHOOLS`, students' target lists come first) without
reaching the Common Data Set schools it was bumped for; Johns Hopkins kept
its version-3 reading and nothing would have touched it before the next
fortnightly cadence, because an on-demand read only happened when no
snapshot existed. Every reading now records `policy.scoutVersion`;
`snapshotIsCurrent` in `backend/admissions-policy-scout.js` says whether
a snapshot was made by the running version; the chat's deadline lookup
(`deadlinesFromResearchCache(text, { current: true })`) and the calendar
context treat an older snapshot like a missing one for the bounded
on-demand read and keep answering from it if the read fails; and
`runPolicyScout` orders targets before the cap — no snapshot, then older
version, then longest-unread. Pinned in the scout tests and
`council-naming-deadlines-routes.test.js`. Side effect to expect: the
first on-demand re-read of a school logs its changed readings (Hopkins' ED
II from November 15 to January 2) in the counselor's change list.

**Applicant counts on the CDS line (2026-09-07)** — `be12040`. The VERIFIED
DATA line for a stored Common Data Set rendered the admit rate but not the
B1 counts behind it, so a chat turn asking how many students applied to
Columbia answered that it had no verified total while quoting the ED
volume from the same record. `cdsLine` in `backend/chat-grounding.js` now
reads "admit rate 3.9% (60,247 applied, 2,325 admitted, 1,483 enrolled)".

**Interrupted scout runs resume at the next boot (2026-09-07)** — `f51e9ef`.
Each scout inserts a run row at the start and fills in the finish time at
the end; `scoutRunDue` treated a row without a finish time as in progress
until it was six hours old. A deploy that lands mid-sweep (a version bump
re-reads sixty schools and takes half an hour or more) therefore stalled
the rest of the sweep for six hours. The schema init of both scouts now
marks unfinished rows abandoned (`summary_json.abandoned`), run summaries
expose the flag, and an abandoned run is due at once. Pinned in
`scout-cadence.test.js` and `admissions-policy-scout.test.js`.

**Columbia's CDS is the Columbia College and Engineering document
(2026-09-07)** — `3185827`. The cached "Columbia University" PDF (a
College Transitions Drive link) was the School of General Studies CDS:
509 applicants, 30% admitted, interviews and work experience rated very
important, closing dates in May. The registry override hid the admit rate
but the counts, yield, C7 factors, submit rates and closing dates reached
the VERIFIED DATA block as Columbia's. The cache now holds the official
2024-25 Columbia College and Columbia Engineering CDS from
opir.columbia.edu (60,247 applied, 2,325 admitted, SAT 1510–1560, fee 85
USD, RD January 1, ED November 1), parsed clean with parser version 3 and
`yearLabel: "2024-25"`; the General Studies PDF and Columbia's Drive links
are gone from the cache and `index.json`. Two fixes rode along: the
validator's document-scope extractor had never matched anything (its name
patterns required the name's last word to follow the previous one without
a space), so every `scopeFromPDF` was null; it now returns the cover text
plus A1's institution name, and Columbia's `expectedScope` insists on
"Columbia College" or "Columbia Engineering" because A1 reads the same on
both documents. And `ensureCdsStoreSeeded` in `backend/cds-store.js` now
re-ingests a record whose year label on disk differs from the stored one,
which is how the replacement reached the populated production database.
New `tests/cds-validator.test.js`; the store test covers the re-ingest.

**Column-aware deadline tables in the policy scout (2026-09-07)** —
`81e400b`. Johns Hopkins' deadlines page is a header-row table (Early
Decision I / Early Decision II / Regular Decision / Transfer across the
top; Application Deadline, Financial Aid Deadline, Decision Release,
Reply-By Date rows beneath). Its source breaks lines between cells, so
`htmlToText` yields one cell per line, and the section logic in
`extractDeadlines` paired the last header with the first date below it;
the ED II value production held (November 15, dropped by the 30-day guard)
came from a plan-change sentence on the Early Decision page. Now
`tableCandidates` in `backend/admissions-policy-scout.js` runs before the
line pass and recognizes the table in both text layouts (one cell per
line, or one line per row after a line naming two or more plans separated
only by punctuation), zips plan columns with date columns, ignores
non-plan columns, skips rows about aid, decision release, reply-by or
deposits, outranks same-line statements with a deadline-labeled row, and
keeps the line pass off the lines it used. Plan-change ("can change to ED
II until …") and reply-by wording hedge a same-line candidate; decision
release is not hedged because MIT's deadline sentence mentions it.
Replayed against the live pages, Hopkins reads ED 2026-11-01, ED II
2027-01-02, RD 2027-01-02; Brown, Emory, NJIT and Northeastern read as
before. `SCOUT_VERSION` is 4, which forced a full re-scout at the next
boot. Pinned in `tests/admissions-policy-scout.test.js`.

**Catalog outage and ED II guard (2026-09-07)** — `9f75ddb`. The
OpenRouter catalog is now cached in `DATA_DIR/openrouter-catalog.json` and
served from there when a refresh fails, an empty response is a failure
rather than a wipe, a 5-minute timer retries while empty, and the chat
route calls `ensureOpenRouterCatalog()` when it finds the catalog empty
(a failed boot fetch had turned every chat turn into a 402). Also the
30-day ED II guard in `snapshotAsDeadlineRecord`.

**ED II, SAT sections, wider CDS read (2026-09-07)** — `cb73dd8`. ED II
through the scout, the deadline answer, the research schema and the
client's deadline creation; `POST /api/calendar/context` falls back
snapshot → on-demand page read → model research → CDS closing dates rolled
onto this cycle → typical dates; SAT `sections` end to end;
`cds-pdf-parser.js extractExtras` reads C9 sections, submit rates, C10,
C13, C14/C21/C22 dates, H2 and I2 into `cds_records.extras_json`.

**2026-09-06** — `0cf696c` (seven review fixes: on-demand page read before
model research for calendar deadlines, "(approximate — verify)" titles,
privacy footer, the ghostwriting 400 shown as the reply, activity category
default, endpoint-free i18n strings and drift refresh, relevant follow-up
actions, bounded EC re-rank); `d292cb4`, `5fb313e`, `15a2643`, `6e4a4ec`
(per-turn timings, the orchestrate pre-flight removed and the validator
run only on risky drafts, prompt ordered most-static first, the thread
graph in `backend/chat-graph.js` with THREAD MEMORY recall).

**Earlier (2026-09-03 to 2026-09-05)** — official-source gate sensitivity
(`e737f62`, `a02ff77`, `3b833b8`); `CLAUDE.md` as the edit harness; admin
model picker and the two-week scout cadence (`64c6520`, `4f993d3`); the
model-catalog scout (`34e366f`, `f985290`); crisis gate on first-person
statements only (`209335b`); untruncated uploads with OCR and transcript
import (`fdfb517`, `aca3525`); the College Fit double-check (`02c5256`,
`1a4c823`); profile grounding, the CDS source label and the
admissions-policy scout itself.

## Verified live, and not

All checks used throwaway student accounts on production, deleted
afterwards except two whose deletes were lost to a restart and a
connection timeout (see *Open items*).

- **Columbia (after `3185827`, 2026-09-07 10:44 UTC):** `GET
  /api/cds/school/columbia-university` returned the new record —
  `yearLabel 2024-25`, 60,247 applied / 2,325 admitted / 1,483 enrolled,
  admit rate 3.86%, SAT 1510–1560, interview not considered, RD January 1,
  fee 85 USD, source opir.columbia.edu — so the boot re-ingest worked on the
  populated database. A chat turn asking for Columbia's applicant numbers
  and SAT range cited "Columbia CDS 2024-25" for the ED volume (6,007
  applied, 795 admitted) and the 1510–1560 band; it said it had no verified
  total applicant count, which `be12040` addresses. After `be12040`
  (11:02 UTC) the same question answered "Applied: 60,247 · Admitted: 2,325
  (3.9%) · Enrolled: 1,483 (yield 63.8%) · SAT 1510–1560" with the
  opir.columbia.edu source, 14 s on the small tier.
- **Johns Hopkins ED II (after `81e400b` and `f9a8346`):** before the
  deploys, the calendar entry came from the scout snapshot of
  2026-09-06T10:08:51Z with `edII: null`, and the deterministic deadline
  answer said the pages read do not state an ED II deadline (so the "asked
  plan" detection for ED II works). At 11:20:51 UTC, minutes after
  `f9a8346` went live, a calendar request took 13.5 s — the on-demand
  re-read of the older snapshot — and returned ED 2026-11-01, ED II
  2027-01-02, RD 2027-01-02 with the deadlines page as source and a fresh
  `extractedAt`; the chat turn "When is Johns Hopkins University's Early
  Decision II deadline?" then answered deterministically "Early Decision:
  2026-11-01 · Early Decision II: 2027-01-02 · Regular Decision:
  2027-01-02" with `onDemandRead: null` (the snapshot was current by
  then). That is the table fix, the version stamp and the on-demand refresh
  working together on production.
- **Sweep progress:** Brown's snapshot refreshed at 2026-09-07T10:15:48Z
  and Carnegie Mellon's at 10:16:51Z, proving the version-4 boot sweep ran
  on the new build. Stanford (still 2026-09-03), Cornell and Emory (still
  2026-09-06) and Johns Hopkins were never reached, and Yale, Duke,
  Harvard, Dartmouth and Princeton had no snapshot at all until probes read
  them on demand — the sixty-school cap filled before the Common Data Set
  schools. No sweep resumed after the later boots (Brown's time did not
  change), consistent with that sweep having completed within its cap
  rather than being cut short, so the abandoned-run path in `f51e9ef` was
  not exercised live.
- **Incidental on-demand reads:** probing Northeastern, Yale, Duke and
  Harvard created snapshots for them (10–12 s each); Harvard's pages
  yielded no dates and the calendar entry fell back to its Common Data Set
  (`source: "cds"`, RD 2027-01-01) — the first time the CDS fallback was
  seen live.
- One chat turn about Columbia returned the composer's "There is not enough
  information to produce a specific suggestion." with `verifiedData: true`
  on the small tier, right before a 502 during the `f51e9ef` deploy; the
  same question answered fully a minute later. Not reproduced; if it
  recurs, capture `_meta` and the model's raw reply.

Verified on 2026-09-06 and earlier (throwaways deleted): the catalog
recovery and SAT-section fit read after `9f75ddb`; the ghostwriting 400;
Johns Hopkins and Emory calendar context from official pages; EC ranking
timing; the thread graph writing and recalling facts; the gate cases; the
crisis probes; the admin picker on a local copy.

Not verified: anything that needs a browser session (the client `[chat
timing]` line, the validator skip rate, the ghostwriting reply rendering,
the approximate deadline titles, the ranker's elapsed counter and Retry,
the drift banner refresh); the production admin page (needs the counselor
password); Render's boot log; the next automatic scout dates — read `GET
/api/admin/policy-scout/status` and `GET /api/admin/models` as the
counselor.

## Open items and things to watch

- **Two throwaway accounts may remain on production.** A Columbia probe at
  2026-09-07 10:44:53 UTC registered `probe-<id>@example.test` (the id is
  the registration time in base-36, between `mtr467pk` and `mtr46993`) and
  its `DELETE /api/students` got a 502 during the `f51e9ef` deploy; a
  Johns Hopkins probe registered at about 10:29 UTC (id between
  `mtr3lsdc` and `mtr3nptc`) crashed on a connection timeout before its
  delete. Whether either delete landed is unknown. If they show in the
  admin roster (email domain `example.test`, grade 11, CA), delete them.
  Probes now print their account, survive connection errors and retry
  deletion.
- The automatic sweep is capped at sixty schools per run
  (`POLICY_SCOUT_MAX_SCHOOLS`) and the target list is students' goal
  schools, then every school with a stored CDS, then the research cache.
  With the stale-first ordering every school is reached within a few
  sweeps, but a fortnight apart; if the counselor wants the whole list
  every time, raise the cap on Render or run the scout from the admin page.
  The next automatic run's date is on `GET /api/admin/policy-scout/status`.
- The table pass has known limits: a non-plan column before or between
  plan columns makes it stand down (the old section logic then applies); a
  heading like "Early Decision or Regular Decision" followed by a line
  with two dates reads as a one-line table (bounded by the 30-day guard and
  the evidence string). When a school misreads, add its text to
  `admissions-policy-scout.test.js` first.
- The new document-scope extractor has only been exercised on the two
  Columbia PDFs; running `tools/cds-validator.js`'s `validateAll` would
  compute scopes for all 35 cached PDFs and could flag mismatches the
  registry's `expectedScope` patterns did not anticipate (Caltech's
  pattern wants "California Institute of Technology"). Run it deliberately
  and review before committing what it rewrites.
- `index.json` is a cache of College Transitions' index; `fetchIndex({force:
  true})` would restore Columbia's Drive (General Studies) links. The
  registry's scope pattern and admit-rate drift would flag a re-parse, but
  keep the 2024-25 official link preferred.
- The scout spent one of its seven page slots on Johns Hopkins' Spanish
  duplicate (`/es/how-to-apply/…`). Excluding locale-prefixed paths in
  `LINK_EXCLUDE_RE` is cheap; not done to avoid yet another deploy.
- The deterministic deadline answer says "a Early Decision II deadline"
  (article). Cosmetic, in `deadlinesFromResearchCache` in `server.js`.
- CDS extras are parsed, never validated against ground truth; Cornell,
  Washington and Wisconsin yielded no extras (layout/OCR).
- SAT sections are not yet read from an uploaded score report
  (`transcript-import.js` parses courses only).
- The on-demand page read adds up to 15 s to a calendar request or a pure
  deadline lookup for a school with no snapshot; the snapshot is reused
  afterwards and the first read logs a "change"; expected.
- The model call is ~99% of server turn time. Streaming the final answer
  conflicts with the post-hoc fidelity check, PII restore and validator
  ("stream, then patch the footnote"). Not started.
- The thread graph links a school only when `detectSchoolMentions` does;
  bare "Brown" or "Cornell" is not an alias. Adding bare names to
  `SCHOOL_ALIASES` would also change the VERIFIED DATA block; decide
  deliberately. Facts accumulate one per assistant turn with no cap.
- If a bad answer slips past the narrower validator, add the pattern to
  `RISKY_OUTPUT_TOKENS` / `OVERCLAIM_OUTPUT_TOKENS` / `CONDUCT_OUTPUT_TOKENS`
  in `orchestrateStages` rather than restoring the length rule.
- `LOOKUP_ASK_RE` / `GUIDANCE_RE` in `policy-router.js` are word lists; when
  a phrasing misroutes, pin it in `policy-router.test.js` and extend them.
- If the StudentAid.gov follow-up footer reappears on an unrelated
  question, capture the question text and add it to
  `answer-composer.test.js`.

## Quick verification recipes

Scout extraction, cadence, CDS store and validator:

```bash
cd backend && node --test tests/admissions-policy-scout.test.js tests/scout-cadence.test.js tests/cds-store.test.js tests/cds-validator.test.js tests/chat-grounding.test.js
```

Replay the scout's read of one school offline (network, no database):
from `backend/`, run a `.mjs` script in a scratch folder that imports
`readSchoolPolicyLive` from `./admissions-policy-scout.js`, calls it with
`{ name, website }` (the website is needed without a Scorecard key) and
prints `live.policy.deadlines` and each `live.pages[i].text`. Set
`POLICY_SCOUT_DEBUG=1` to see every fetch, and run it from the scratch
folder: anything it writes lands in the current directory.

Re-parse one cached CDS PDF the way the cache was built: from `backend/`,
a script that imports `parseCDSPositional` from `./cds-pdf-parser.js` and
`extractDocumentScope`, `validateRecord`, `loadCorrections` from
`./tools/cds-validator.js`; parse the PDF, detect its scope, validate
against `loadCorrections()[slug]`, and write the record with the
`validation` block to `tools/cds-cache/parsed/<slug>.json` (keep
`yearLabel`, `sourceUrl`, `tier`). `loadCorrections()` also rewrites
`_corrections.json` from the in-code table.

Live probe with a throwaway account (Node 22, `BASE` is the site):

```js
const base = process.env.BASE, t = Date.now().toString(36); let token = "";
console.log("account", `probe-${t}@example.test`);
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: b && JSON.stringify(b) }); return { status: r.status, data: await r.json().catch(() => null) }; };
token = (await call("POST", "/api/students/register", { email: `probe-${t}@example.test`, password: `probe-${t}-correct-horse`, grade: 11, state: "CA", schoolDomain: "example.edu", majorInterest: "Computer Science" })).data.token;
for (const consentType of ["data_processing", "ai_interaction", "cross_border_transfer"]) await call("POST", "/api/consent/grant", { consentType, grantedBy: "student" });
await call("POST", "/api/students/sync", { profile: { gpa: { unweighted: 3.7 }, courses: [], testScores: [{ test: "sat", totalScore: 1380 }], apScores: [] }, activities: [], majorInterest: "Computer Science", goals: [] });
const cal = await call("POST", "/api/calendar/context", { targetSchools: ["Johns Hopkins University"], research: false });
console.log(cal.data.schools[0].deadlines, cal.data.schools[0].extractedAt);
console.log((await call("GET", "/api/cds/school/columbia-university")).data?.b1);
const turn = await call("POST", "/api/chat", { system: "You are the COLLEGE FIT specialist for students ages 14-18.", messages: [{ role: "user", content: "When is Johns Hopkins University's Early Decision II deadline?" }], request_id: `probe-${t}-1` });
console.log(turn.data._meta, turn.data.answer);
let del; for (let i = 0; i < 6 && del?.status !== 200; i += 1) { del = await call("DELETE", "/api/students"); if (del.status !== 200) await new Promise((r) => setTimeout(r, 10000)); }
console.log(del);
```

Deploy markers: `/` carries `assets/main-*.js` (changes only with
`App.jsx`), `/admin.html` carries `assets/admin-*.js`; a backend-only
deploy shows only as a brief `/api/health` blip (and 502s for a few
seconds) after CI succeeds, and `/api/health` reports nothing but
`status` in production. A scout version bump or a resumed sweep shows up
as fresh `extractedAt` values on calendar entries, school by school, five
minutes after boot and over the following half hour or more.

Admin page on a scratch database (never production): build the frontend,
then from `backend/` run `web-launcher.mjs` with `PORT`, `SIM_PORT`,
`HOST=127.0.0.1`, a scratch `DATA_DIR`, `PUBLIC_DIR=../frontend/dist`,
`WEB_CONFIG_KEY` (32+ chars), `WEB_ADMIN_BOOTSTRAP_TOKEN` (24+ chars),
`WEB_COOKIE_SECURE=0`, `CDS_DAILY_REFRESH=0`, `POLICY_SCOUT=0`; the first
visit to `/admin.html` bootstraps a throwaway counselor with that token.
Delete the scratch `DATA_DIR` afterwards.

## Tooling notes for a Claude session on this machine

- Bash heredocs containing single quotes fail here; write node scripts and
  commit messages with the Write tool and run or `-F` them. The working
  directory drifts between calls (it sat in `backend/` for most of this
  session) — use absolute paths, especially for `git add`.
- Stage explicit paths only; commit messages end with
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Foreground `sleep` is blocked; a background Bash loop with `sleep` (CI
  watch over `gh run list`, a delayed probe) works, as does the Monitor
  tool tailing a background task's output file.
- A probe that spans a deploy can lose its final request to a 502; print
  the account first and retry the delete. Student session tokens are
  SQLite-backed and survive the restart.
- The in-app Browser pane can fill forms but screenshots are correct only
  at scroll position 0; for anything below the fold use headless Chrome
  (`npm i playwright-core` in a scratch folder,
  `chromium.launch({ channel: "chrome" })`, clip with page coordinates).
