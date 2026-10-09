# Session handoff

One current document for whoever picks this repository up next, written for
a reader with no access to the conversation that produced it. Read
`CLAUDE.md` first (the edit-time harness); `RUNBOOK.md` is the operator
sheet. Long forms of older entries: `git show 7df4c1a:SESSION-HANDOFF.md`
(2026-10-08), `6d9bac1` (2026-09-20 to 24), `812cdeb` (2026-09-16 and
earlier).

## Where things stand (2026-10-09)

- **Deployed:** production runs `52e9fb7` (2026-09-23). `main` is at
  `6d9bac1`, a handoff commit after it (fetched 2026-10-09). Nothing was
  deployed on 2026-10-08 or 10-09, and production was not looked at on
  10-09.
- **Two pull requests are open, stacked, and not merged; merge #4 first.**
  - [#4](https://github.com/jungwonmoon1018-garden/college-counselor-web/pull/4)
    (`ops/data-input-2026-10-08`): CI run 37785860340 green.
  - [#5](https://github.com/jungwonmoon1018-garden/college-counselor-web/pull/5)
    (`ops/chancing-ap-2026-10-09`, base `main`, built on #4's head): seven
    commits `c4d0a59`..`324851a` plus this file. CI run 37915818864 green
    on `324851a` (Node 22.22). Merging #5 alone would land both.
  - Neither was merged because the `collegeapp-ops` skill opens a pull
    request unless the user asks for a deploy in that session.
- **CI on `main` fails until #4 merges** (inferred from local runs on
  2026-10-08): a calendar-bound test (from about 2026-10-04) and `npm audit
  --audit-level=high`.
- **Tests on #5's head, run after the last edit on 2026-10-09:**
  - backend: 817 tests, 813 pass, 4 skipped, 0 fail; lint 0 errors, 38
    warnings; `node --check` clean;
  - frontend: 26 files, 82 tests; build clean.
- **Working tree:** clean. `AGENTS.md` and `*.traineddata` are gitignored;
  `backend/data/` (real student data) and `graphify-out/` are local only.
- **New modules on #5:** `backend/academics/ap-exams.js` and
  `frontend/src/profile/ap-entry.js`.
- **The CDS cache** seeds 299 records (parser version 7). 112 carry Early
  Decision counts, and 90 of them yield a consistent admit rate outside ED
  (counted 2026-10-09).
- **Knowledge graph and Obsidian vault (local):** last rebuilt 2026-09-22,
  without the new modules.
- **Standing authorizations from the user:** push straight to `main`;
  create and delete throwaway `probe-*@example.test` accounts on
  production. Never ask for or use the counselor's or a real student's
  credentials.
- **Deferred by the user (2026-09-07):** the University of Wyoming College
  Fit data-source precedence. In the user's words: "Wait, the wyoming is
  not answering. I think that it would be ok for that to be dealt with that
  later." Do not pursue until asked.
- **This machine** runs Node 25.9 (CI and Render run 22.22).

## What changed, newest first

The user's ask on 2026-10-09, verbatim: "Also, college chancing algorithms
not reflecting the reality of college admissions? /collegeapp-ops and
solve the two low-priority things. Also, check for AP data entry formats".
All of it is on #5. Evidence is cited in the commit messages and in
`backend/docs/METHODOLOGY.md`; the ranked findings are in the skill's run
log, outside the repository.

**Strong academics lift the odds less at selective schools** — `c4d0a59`.
The readiness shift on the admit rate's log-odds was capped at ±2.4 at
every school, so readiness 90 read 25% "Reach" at a 4%-admit school and 42%
"Competitive" at 8%. Harvard's SFFA-litigation data put its top academic
decile near 13–15% against about 5% overall, an odds lift near 1.1.
`maxReadinessLift` now caps the upward shift at 1.1 at a 5% admit rate,
rising linearly to 2.4 at 45%. Readiness 90 now reads 11% at 4%, 22% at 8%
and 55% at 20%. Readiness 75 and below is unchanged, and so is the
downward cap (`colleges/positioning-engine.js`).

**The read starts from the admit rate outside Early Decision** —
`e8203f9`. The headline rate counts ED admits, admitted at two to three
times the regular rate. Columbia 2024-25: 3.9% overall, 13.2% of 6,007 ED
applicants, 2.8% of everyone else.
- `admitRatePools` derives the outside-ED rate from a stored record's B1
  and ED counts. It returns null when they are missing, disagree with the
  record's rate by more than a point, or would make the regular pool
  easier than the whole.
- The payload's `admitRate` (`used`, `basis`, `overall`, `earlyDecision`)
  appears on the card (English and Korean) and in the chat's College Fit
  line.
- `POSITIONING_MODEL_VERSION` (`positioning_v2`) is in the seven-day
  College Fit cache key. Bump it whenever the read changes.

**College Fit reads the test policy a school states this cycle** —
`fbcbf58`. The policy came from the Common Data Set, which describes a
class a year or two old. The store's Dartmouth 2025-26 set reads
test-optional although Dartmouth has required scores since 2024-25.
- `statedTestPolicy` takes the policy scout's snapshot when it names a
  policy, quotes its sentence, and is under a year old; it outranks the CDS
  (`server/positioning.js`).
- A missing SAT/ACT at a school whose pages require one becomes a red flag
  dated by the check. Under test-flexible, AP results meet it.
- `testPolicyBucket` maps test-flexible to "required" in both the read and
  the double-check; `fit-verifier.js` had read it as optional.
- `dataProvenance.testPolicy` names the source.

**AP exams under every name, a retake counted once** — `12278ad`.
- *Catalog:* `academics/ap-exams.js` holds each exam's stored (picker)
  name, its College Board full name, common abbreviations ("APUSH", "AP
  Calc BC", "APES") and the newest exams' first years. Course rigor,
  College Fit's AP summary and the chat's fidelity check read names
  through it.
- *Names:* "AP United States History" plus the exam "US History" counted
  as two APs, and "APES" was not AP.
- *Retakes:* a retake now counts once at its better score. The fidelity
  retry used to "correct" a true score for a retaken exam.
- *Entry:* the survey accepted any year (default a fixed 2025) and
  duplicates. It now shares `profile/ap-entry.js` with the sidebar: scores
  out (July), not before the exam first ran, no duplicate exam and year.
- *Sync:* drops nameless entries and impossible years.
- *New courses:* AP Business with Personal Finance and AP Cybersecurity
  (first exams May 4–5, 2027) are listed in the pickers from July 2027.
  `tests/ap-exams.test.js` keeps the app's list in step with the catalog.

**Deadline limits** — `e985339`. Titles ≤ 200 characters and dates
2000-01-01 to six years out, on create, bulk and edit (`routes/students.js`),
with an English and Korean `friendlyMessage`. A PATCH with a non-string
title answered 500 and now answers 400; an unknown category keeps the
stored one. The Deadlines form carries the same limits.

**Origin allowlist** — `0ed2194`. With `ALLOWED_ORIGINS` unset, production
admitted `localhost:3000/5173/5180`. `resolveAllowedOrigins` keeps them for
development only; the website answers its own origin and `PUBLIC_APP_URL`.

**Test timeouts** — `324851a`. Two UI flow tests got the 20 s whole-suite
timeout (vitest queueing).

**Earlier sessions:**
- 2026-10-08 (#4): the scout test's time bomb and the advisories (`ee48d80`,
  `95edb9e`); sync field checks with `setAside` (`5a0fdfc`); save failures
  shown and GPA-only fields (`f57e88f`); the story delete (`d958c62`).
- 2026-09-23: every tracked school read each sweep (`52e9fb7`).
- 2026-09-22: the likelihood label (`ad13a62`, `6a5caa6`), OCR fallback
  and the C1 residency table (`03ed23f`), memory and body caps.
- 2026-09-20/21: the reorganization into folders by function.

## Verified, and not

- **2026-10-09, on a local production-parity copy**
  (`prod-parity.mjs --students-open`, a throwaway data directory, removed
  afterwards; one throwaway student, deleted with 200):
  - `Allowed origins:` printed empty; `Origin: http://localhost:5173` got
    403 and the same origin 200.
  - Columbia read under `positioning_v2` from 2.82% outside ED. "AP
    Calculus BC" and "APUSH", each with its exam, counted as 2 APs.
  - Dartmouth, with an official-site snapshot seeded in the throwaway DB:
    required, source `official_site`, red flag present.
  - Sync: a nameless AP entry was set aside and a 2099 year dropped.
  - Deadlines: a 201-character title and the year 0202 got 400; a valid
    one got 201.
- **2026-10-09, CI:** run 37915818864, all three jobs green.
- **2026-10-09, not verified:**
  - production (neither PR is merged; no probe account used);
  - how production's policy snapshots read test policies, and whether any
    misreads an optional school as required;
  - the new labels on real profiles.
- **Earlier:** the 2026-10-08 sync and story-delete checks ran on parity.
  On 2026-09-23 the production policy sweep ran, and eight of 24 sampled
  schools were unreadable.
- **Not verified, standing:** no browser look at production; the
  administrator routes are never probed; Render's dashboard has not been
  opened.

## Open items and things to watch

- **Merge #4, then #5,** then run the live probe below. The student bundle
  hash in `/` changes.
- **Watch the stated test policies once #5 is live.** Look at a few
  test-required schools on `GET /api/admin/policy-scout/status`. A misread
  "required" adds a wrong red flag; a misread "optional" hides one.
- **Residency, deferred with a plan.** In-state and out-of-state rates are
  not modeled. No record carries C1 counts by residency (C7's
  state-residency rating is in 194, the out-of-state share in 228), and
  registration stores no home state. The plan:
  1. a residency profile field;
  2. the C1 resident counts parsed, with a parser-version bump;
  3. `admitRatePools` picks the matching pool.
- **Labels moved down at selective schools** (readiness 90 at 8% is now
  "Reach"). The chat relays labels verbatim, so look at real reads after
  the deploy.
- **The AP catalog** needs each future course (AP Networking: 2027 pilot,
  national 2027-28 planned) and any new abbreviation. An alias must never
  be shared by two exams.
- **Carried:**
  - set-aside entries are not replaced by their stored versions;
  - 100-point GPAs are not converted (a product decision);
  - two 2026-09-07 probe accounts remain on production (removing them
    needs a counselor-side control);
  - unreadable tracked schools (`scouts/policy-scout-fetch.js`);
  - the Render dashboard checks are left to the owner;
  - the document lane's queue is unbounded;
  - five CDS records lack C1 and 104 lack C7, and JHU is fetched by hand;
  - the new CDS sections have no UI;
  - locale comes from Accept-Language;
  - prestige rationales are English-only;
  - the small tier sometimes returns an empty reply.
- **Graph and vault refresh:**
  1. Run `/graphify . --update`, then `graphify export obsidian` into
     `graphify-out/obsidian`.
  2. Archive the vault's generated notes to a dated folder under `Obsidian
     Vault archive/`, then copy the export in.
  3. Never touch the six hand-written notes (`index.md`,
     `strategy-council.md`, `embedded-llm-stack.md`,
     `seasonal-retrieval-first.md`, `logseq-pii-vault.md`,
     `chat-graph-vault-context.md`).

## Quick verification recipes

**Gates:**
- `cd backend && npm test && npm run lint && node --check server.js`
- `cd frontend && npx vitest run && npm run build`
- CI adds `npm audit --audit-level=high` and the web-launcher build.

**Live probe** (Node 22+, a scratch `.mjs`, `BASE` the site, requests about
2.6 s apart):
1. Register `probe-…@example.test` (grade 11) and grant the three consents
   (`POST /api/consent/grant`).
2. `POST /api/students/sync` with no test scores and AP entries
   `{exam:"Calculus BC",score:5,year:2026}`, `{score:4}` and
   `{exam:"US History",score:5,year:2099}`. Expect `setAside` apScores 1,
   and the 2099 year gone on `GET /api/students/profile`.
3. `POST /api/positioning/targets` for Columbia University with
   `searchCds: false`. Expect `positioning_v2`, `outside_early_decision`
   and `admitRateUsed` ≈ 0.0282. Then try a test-required school the scout
   has read (Dartmouth, MIT) and expect `profileComparison.tests.stated`
   plus the red flag.
4. `POST /api/students/deadlines` with a 201-character title (400) and the
   year 0202 (400).
5. `DELETE /api/students`, then confirm the token answers 401.

**Origin check:** `curl -H "Origin: http://localhost:5173"
$BASE/api/health` answers 403 on the website.

**Deploy markers:** `/` carries `assets/main-*.js` and `/admin.html`
carries `assets/admin-*.js`. A backend-only deploy shows only as a brief
`/api/health` outage. For the CDS cache refresh, see RUNBOOK.md.

## Tooling notes

- **Bash quoting:** the Bash tool mangles backslashes and apostrophes in
  heredocs and `node -e`. Write scripts and commit messages with the Write
  tool, and an unterminated heredoc swallows the rest of the command.
- **`until grep` waits:** `rror` also matches lint's "0 errors", so wait on
  an exact marker (`built in`, `Test Files`).
- **Parallel calls** share one working directory: use absolute `cd`s, and
  one `npm audit` per call. Prefer `npm update <pkg>` to `npm audit fix`.
- **Commits:** stage explicit paths, and end messages with `Co-Authored-By:
  Claude Fable 5.1 <noreply@anthropic.com>` (repo `CLAUDE.md`).
- **Frontend tests:** `npx vitest run` works from `frontend/` only. A UI
  test that passes alone but times out in the full run is queueing: give it
  20 s with a note, as `AdminApp.test.jsx` does.
- **BOMs:** some backend files start with one, so insert imports after line
  1.
- **CI:** read a PR's CI through the app's PR status, without polling; for
  a push to `main`, `gh run watch <id> --exit-status`.
- **Parity:** `prod-parity.mjs --students-open` serves port 3101 from a
  throwaway data directory (`counselor.db`), removed with `--clean`. Its
  run logs live outside the repository.
