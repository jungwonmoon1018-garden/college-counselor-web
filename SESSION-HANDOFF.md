# Session handoff

One current document for whoever picks this repository up next — a person
or a fresh Claude session with no access to the conversation that produced
it. Read `CLAUDE.md` first: it is the edit-time harness (invariants, how to
prove a change, how to land it); `RUNBOOK.md` is the operator sheet. This
file says where things stand, what changed recently and why, what was
verified, and what is open. Long forms of older entries: `git show
6d9bac1:SESSION-HANDOFF.md` (2026-09-20 to 24), `git show
812cdeb:SESSION-HANDOFF.md` (2026-09-16 and earlier).

## Where things stand (2026-10-08)

- **Deployed:** production runs `52e9fb7` (deployed 2026-09-23, CI run
  35875601027); `main` is at `6d9bac1`, a handoff commit after it. Nothing
  was deployed on 2026-10-08.
- **Pull request #4 is open and not merged:**
  https://github.com/jungwonmoon1018-garden/college-counselor-web/pull/4,
  branch `ops/data-input-2026-10-08`, five commits plus this file. Its CI
  run 37785860340 passed all three jobs (backend, frontend, web build) on
  Node 22.22. Merging it deploys it after CI. The `collegeapp-ops` skill
  opens a pull request instead of pushing unless the user asks for a
  deploy in that session, which is why this one waits.
- **CI on `main` fails until #4 merges** (inferred from local runs on
  2026-10-08; no CI has run on `main` since 2026-09-24). A test tied to the
  calendar fails from about 2026-10-04, and `npm audit --audit-level=high`
  fails in both packages. Any other push to `main` first would fail CI and
  not deploy.
- **Tests on the branch (run 2026-10-08 after the last edit):** backend
  `npm test` 801 tests, 797 pass, 4 skipped, 0 fail; `npm run lint` 0
  errors, 38 warnings; `node --check` clean; frontend `npx vitest run` 24
  files, 77 tests; `npm run build` clean; `npm audit --audit-level=high`
  passes in both (backend keeps 3 moderates, all in mammoth's chain). On
  `main` the same day: backend 792 tests, 787 pass, 1 fail, 4 skipped;
  frontend 20 files, 64 tests.
- **Working tree:** clean. `AGENTS.md` (a copy of `CLAUDE.md` for another
  coding agent) and the tesseract `*.traineddata` cache are gitignored;
  `backend/data/` (real student data, backups, the OCR language cache) and
  `graphify-out/` are local only.
- **Shape of the code.** See `CLAUDE.md` and `RUNBOOK.md` (*Runtime*):
  `backend/server.js` holds setup and `routeDeps`; `routes/` the route
  families; `server/` the helpers and boot-time work; the domain modules
  sit in folders by function. `frontend/src/App.jsx` holds the core state
  and the hooks in `src/hooks/`. New on #4: `backend/academics/profile-input.js`,
  `frontend/src/profile/gpa.js`, `frontend/src/profile/sync-result.js`.
- **The CDS cache** seeds 299 records (parser version 7) at boot in about
  two seconds.
- **Knowledge graph and Obsidian vault (local):** last rebuilt 2026-09-22;
  not refreshed since (recipe under *Open items*).
- **Standing authorizations from the user:** push straight to `main`;
  create and delete throwaway `probe-*@example.test` accounts on
  production. Never ask for or use the counselor's password or a real
  student's, and record nothing from the owner's own account here.
- **Deferred by the user (2026-09-07):** the University of Wyoming College
  Fit data-source precedence — "Wait, the wyoming is not answering. I
  think that it would be ok for that to be dealt with that later." Do not
  pursue until asked.
- **This machine** runs Node 25.9 with no version manager (CI and Render
  run 22.22), so every local `npm install` warns `EBADENGINE`.

## What changed, newest first

The user's ask on 2026-10-08, verbatim: "/collegeapp-ops maintain please
on data input and more." All five changes are on pull request #4.

**CI unblocked (2026-10-08)** — `ee48d80`, `95edb9e`. The policy scout's
run test read its September changes back through `listRecentChanges`,
whose 30-day window counted from the wall clock. The fixture is dated
2026-09-04, so the test began failing about 2026-10-04 and took CI with
it. The function now takes `now`, and the test passes its own clock.
Moving the clock 60 and 200 days ahead found no other such test; five
more failures it showed come from the method (SQLite's real clock against
a moved JavaScript clock). New advisories also failed the audit gate. The
lockfiles now carry proxy-addr 2.0.8 (critical; production was not
exposed, since it trusts one proxy hop and the flaw is in IPv6 trust
subnets), multer 2.4.0 (moderate; it applied: an aborted evidence upload
left a partial file on the persistent disk), brace-expansion 1.1.21 and
2.1.7 (high), and source-map-js 1.2.2 (high, build tooling only). `npm
audit fix` also moved mammoth to 1.13.0 for nothing, so the updates were
made package by package. sprintf-js (moderate, under mammoth's
command-line parser) is left: its only fix is a breaking mammoth
downgrade.

**A profile sync checks each field before it is stored (2026-10-08)** —
`5a0fdfc`. `POST /api/students/sync` stored the body as sent. On a local
copy, GPA 39 and 95, SAT 1700 and AP score 9 were all stored and reached
the STUDENT PROFILE block and College Fit. A GPA sent as text, or a
course list that was not a list, crashed the save with a 500.
`academics/profile-input.js` (`normalizeSyncInput`) now runs first:
- a GPA part out of range (unweighted 0–5, weighted 0–6) or not a number
  keeps the stored value, and numeric text is read as the number;
- a list field that is not a list keeps the stored list;
- invalid entries are dropped: test scores through `normalizeTestScores`
  (written 2026-09-09, never wired in), AP scores not a whole number 1–5,
  non-objects;
- absent fields mean what they did.
The response carries `setAside` (`{ field, reason, count }`), and the log
names fields only. Pinned in `tests/profile-input.test.js` and a route
test in `tests/endpoints.test.js`.

**The app says when a save didn't land; the GPA fields take only a GPA
(2026-10-08)** — `f57e88f`. `authedFetch` resolves on every HTTP status,
so the survey and the auto-save took a 413, 429, 500 or 503 as saved. The
survey said "your profile is saved and synced", and the auto-save
refreshed College Fit against the old record. Now:
- the survey stays put with the reason (`profile/sync-result.js`) and
  names anything set aside in the welcome message;
- the auto-save shows the reason in the status toast, or a `partial` note
  naming what was set aside;
- the survey's GPA step and the profile's new `GpaEditor` (in
  `screens/Sidebar.jsx`) refuse a GPA outside the server's range, from
  `profile/gpa.js`, which the backend test pins to the server's limits.
Vitest covers both modules, the survey handler, the survey flow and the
dashboard.

**The story editor's Delete deletes the story (2026-10-08)** — `d958c62`.
It called `DELETE /api/ec/narrative/<id>`, which never existed, so the
student saw "Not found" and the story stayed active. It now calls `DELETE
/api/ec/narrative`. Pinned in `components/NarrativeEditor.test.jsx`,
which fails on the old helper.

**A policy sweep reads every tracked school (2026-09-23)** — `52e9fb7`.
Sixty schools a fortnight left most of the roughly three hundred tracked
schools unread for months. Each sweep now reads every tracked school
(`SWEEP_CEILING` 1,000; `POLICY_SCOUT_MAX_SCHOOLS` still caps). A school
already read keeps its stored homepage for 45 days instead of a new
College Scorecard search, and an automatic sweep skips what was read in
the last 20 hours, so a sweep cut short by a deploy resumes. Runs record
`sweepRules` (`SWEEP_RULES_VERSION` 2), which made the first full sweep
run at the next boot without marking readings stale.

**2026-09-22, compressed** (long form in `6d9bac1`'s handoff).
- College Fit's label is an admission likelihood, not fixed composite
  cutoffs (`ad13a62`). Missing evidence is neutral, and a thin record is
  read by how much of the transcript is on file (`6a5caa6`). "Purdue
  University" resolves to the main campus (`9e275cb`).
- Unreadable PDF text layers go to OCR, the C1 reader falls back to the
  residency table (parser version 7, Bradley University), and the deploy
  checklist's items are in code: key rotation, daily database backups,
  `numInstances: 1`, CI-gated deploys (`03ed23f`).
- One document lane and heap caps bound memory on every heavy path, and
  JSON bodies are capped at 1 MB with 10 MB on the three file routes
  (`9dc008a`, `5acd16b`, `db40b80`).
- `AGENTS.md` is gitignored and the graph was rebuilt (`2842f58`).

**2026-09-20/21, the reorganization** (long form: `git show
cb499e8:SESSION-HANDOFF.md`) — `deb7baf`, `470cd2a`, `9c15000`,
`234c107`, `8b5110a`, `7fedcf1`, `1c0d96c`: hooks, screens and
`server/<area>.js` modules; 108 files into folders by function with the
AST tools in `backend/scripts/refactor/`; the logout race fixed.

**Earlier** (long form: `git show 812cdeb:SESSION-HANDOFF.md`): the
2026-09-16 tech-debt plan and dependency upgrades; the CDS work of
2026-09-09 to 16; course rigor in College Fit (2026-09-11); the policy
scout's deadline tables and the official-source gate (2026-09-07 and
before).

## Verified, and not

- **2026-10-08, on a local copy run the way production runs**
  (`prod-parity.mjs --students-open`, a throwaway data directory, deleted
  afterwards).
  - Before the fixes: the GPA-as-text and non-list-courses saves answered
    500; GPA 39 and 95, SAT 1700 and AP 9 were stored; a 1.1 MB body got
    413; rapid saves hit the 30-a-minute limiter (429).
  - After: each save answered 200 with its `setAside` and the stored
    record kept its last good values (GPA 3.7, SAT 1500, AP 5, one
    course). The ACT 34 beside the SAT 1700 was kept. The story delete
    answered 204, the active story read back `null`, and the old per-id
    path answered 404.
  - The server log named fields only. No console errors on `/`,
    `/admin.html` or `/methodology.html`.
- **2026-10-08, not verified:** anything on production (#4 is not merged,
  and no production account was created this run). After the merge: the
  student bundle hash in `/` changes (`App.jsx` changed), then run the
  sync and story-delete checks under *Quick verification recipes*.
- **2026-09-23, production:** the first full sweep ran at the first boot
  after `52e9fb7` (readings from 14:49 UTC; Florida State, near the end of
  the order, at 15:16). Of twelve tracked schools sampled before the
  deploy, one had a current reading. Eight of twenty-four sampled schools
  could not be read at all (*Open items*).
- **2026-09-22, production:**
  - College Fit labels: Bradley 90, Indiana 93, Harvard 6.3 for a strong
    profile.
  - The hardening checks: 413 on 1.1 MB, 401 before parsing a large body,
    the document lane.
  - Chat with verified figures.
- **Not verified, standing:**
  - nothing on production has been looked at in a browser;
  - the administrator routes are never probed (backups list,
    secrets-status fields, the `[DISK]`/`[BOOT]`/`[MEM]` lines are covered
    by tests only);
  - Render's dashboard has not been opened (boot log, disk *Snapshots*,
    Blueprint link).

## Open items and things to watch

- **Merge pull request #4.** Until then CI on `main` is red, and a push
  that lacks its first two commits cannot deploy. After the merge, probe
  production (recipe below).
- **Deferred from 2026-10-08, low:** deadline titles have no length cap
  and `dueAt` takes any parseable date (`routes/students.js`, single and
  bulk create). Production's origin allowlist still holds the localhost
  dev ports (`server.js`, `ALLOWED_ORIGINS` default; seen in the boot
  log). Students use bearer tokens and the admin cookie is SameSite=Strict,
  so a cross-origin page cannot ride a session.
- **How set-aside entries behave:** a test or AP entry set aside is not
  replaced by its stored version. The list stores its valid entries only,
  and the student is told which part was set aside.
- **100-point GPAs:** the app has no conversion. A student whose school
  grades out of 100 is told to use a 4.0-scale GPA from the transcript, or
  "I don't have a GPA yet". Whether to convert is a product decision.
- **Two throwaway probe accounts from 2026-09-07 remain on production**
  (`probe-…@example.test`, grade 11, CA). No administrator route lists or
  removes student accounts; they hold synthetic profiles with no goals.
  Removing them needs a counselor-side control — the owner's call.
- **Tracked schools the scout cannot read:** eight of twenty-four sampled
  on 2026-09-23 (Centre, Drew, Gonzaga, Miami University, San Diego State,
  St. John's College - Maryland, UCLA, New Hampshire). If a third of the
  list holds, look at `scouts/policy-scout-fetch.js`. The run summary's
  `failures` is on `GET /api/admin/policy-scout/status`. Lawrence
  University's reading cites the conservatory's audition page.
- **The dashboard checks left to the owner:** the boot log's `[MEM]`,
  `[DISK]` and first `[BATCH] cds_daily_refresh` lines, the disk's
  *Snapshots* tab, *Auto-Deploy: After CI Checks Pass*, one instance. The
  server above about 380 MB is the rollback trigger (RUNBOOK.md).
- **Product judgment pending:** thin records at 50%-and-below schools read
  "Reach" or "High reach" by design; chat relays the label verbatim.
- **Refreshing the graph and the vault:** `/graphify . --update`, then
  `graphify export obsidian` into `graphify-out/obsidian`. Move the
  vault's graphify-generated notes to a dated folder under `Obsidian Vault
  archive/` and copy the export in. Never touch the six hand-written notes
  (`index.md`, `strategy-council.md`, `embedded-llm-stack.md`,
  `seasonal-retrieval-first.md`, `logseq-pii-vault.md`,
  `chat-graph-vault-context.md`).
- **Carried, one line each** (details in `6d9bac1`'s handoff):
  - the document lane's queue is unbounded;
  - the live CDS search grows the store with what students look up;
  - five CDS records carry no C1 counts and 104 no C7, and JHU's document
    must be fetched by hand;
  - next splits are possible (the survey branch of App(),
    `server/statements.js`, `vectorizeECStrength`, `orchestrateStages`);
  - garbled banner comments and a BOM in `storage/rag-engine.js`;
  - the new CDS sections have no UI;
  - the server guesses locale from Accept-Language;
  - prestige rationales are English-only;
  - the small tier sometimes returns an empty reply.

## Quick verification recipes

Gates: `cd backend && npm test && npm run lint && node --check server.js`;
`cd frontend && npx vitest run && npm run build`. CI adds `npm audit
--audit-level=high` in both packages and the web-launcher build. After a
move of code between files, run `node
backend/scripts/refactor/undef-check.mjs <files>` and compare the
`assets/main-*.js` hash before and after.

Live probe (Node 22+, a `.mjs` in a scratch folder, `BASE` the site):
1. Print the account name first.
2. Register `probe-…@example.test` (grade 11, CA, `example.edu`,
   `ageAttestation: true`) and grant the three consents through `POST
   /api/consent/grant`.
3. `POST /api/students/sync` a small profile and read `setAside`. A GPA of
   39 should be set aside and the stored GPA unchanged on `GET
   /api/students/profile`.
4. `POST /api/positioning/targets` with two schools, and `POST /api/chat`
   with a UUID `request_id`.
5. Save a story (`POST /api/ec/narrative`, 100+ characters, 20+ words),
   `DELETE /api/ec/narrative` (204), then `GET /api/ec/narrative/active`
   (`null`).
6. `DELETE /api/students` with retries, then confirm the token answers 401.

Pace requests about 2.5 s apart: the student limiter allows 30 a minute.

Calendar time bombs: a preload module that replaces `globalThis.Date` with
a subclass whose no-argument constructor and `Date.now()` add `SHIFT_DAYS`
days. Run `SHIFT_DAYS=60 NODE_OPTIONS=--import=file:///<preload>.mjs node
--test tests/*.test.js` from `backend/`. A failure where a test compares
SQLite's `datetime('now')` with JavaScript time is an artifact of the
shift, not a bomb.

Policy sweep, live: `POST /api/calendar/context` with one school and
`research: false`. About 100 ms is a stored reading; 10–15 s is a live
read made by the request itself.

Deploy markers: `/` carries `assets/main-*.js` (changes with the student
app), `/admin.html` carries `assets/admin-*.js`. A backend-only deploy
shows only as an `/api/health` outage, two to eight minutes after CI;
count twelve seconds or more as the swap. Refreshing the CDS cache:
RUNBOOK.md.

## Tooling notes

- The Bash tool mangles backslashes and apostrophes in heredocs and `node
  -e` strings: write scripts and commit messages with the Write tool and
  run or `-F` them. In PowerShell, `git commit -F -` takes a here-string as
  a pathspec: use a message file.
- Parallel Bash calls share one working directory. On 2026-10-08 an `npm
  audit` in one call printed the other package's report, so run each
  package's audit in its own call with an absolute `cd`.
- `npm audit fix` bumps packages that fix nothing (mammoth 1.12 → 1.13 on
  2026-10-08). Prefer `npm update <pkg>` per advisory, then compare the
  lockfile's package versions before and after.
- Stage explicit paths (`git add -p` is unavailable). Commit messages end
  with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- `npx vitest run` works from `frontend/` only. A UI test that passes alone
  but times out in the full run is queueing. jsdom has no `scrollIntoView`
  (shimmed in `src/test-setup.js`).
- Some backend files start with a UTF-8 BOM, so insert imports after line
  1. A test that fails one run in three is a finding.
- CI watch: `gh run watch <id> --exit-status`, or the app's PR status for a
  pull request. The backend job takes about 40 s; past three minutes it is
  hanging.
- The `collegeapp-ops` skill runs a local stand-in for production with
  `prod-parity.mjs --students-open` on port 3101, against a throwaway data
  directory removed with `--clean`. Its run logs live outside the
  repository.
- graphify: the AST pass takes about 20 seconds. A script that calls
  `graphify.extract.extract()` needs an `if __name__ == "__main__":` guard
  on Windows. Count the Obsidian export's notes rather than listing them
  (about 3,000).
