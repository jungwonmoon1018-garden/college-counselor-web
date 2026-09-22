# Session handoff

One current document for whoever picks this repository up next — a person
or a fresh Claude session with no access to the conversation that produced
it. Read `CLAUDE.md` first: it is the edit-time harness (invariants, how to
prove a change, how to land it); `RUNBOOK.md` is the operator sheet. This
file says where things stand, what changed recently and why, what was
verified live, and what is open. It was compressed on 2026-09-21: the long
form of every entry dated 2026-09-16 or earlier is in git
(`git show 812cdeb:SESSION-HANDOFF.md`).

## Where things stand (2026-09-22, evening KST)

- **Deployed:** `main` at `ad13a62`, live at
  https://college-counselor-web.onrender.com: `9dc008a` (memory ceilings
  on every heavy path, the five repaired lazy imports, the deploy
  checklist's three fixes), `5acd16b` (one new test's timer), `db40b80`
  (a 413 says "Request body too large."), `03ed23f` (unreadable text
  layers to OCR, the C1 residency fallback, Bradley's seed, the daily
  backups and their download, the rotation of `WEB_CONFIG_KEY`, the
  test-only rate-limit switch, `render.yaml`'s instance and CI-gate keys,
  the `[DISK]` line), `1810920` (handoff) and `ad13a62` (College Fit's
  label is an admission likelihood; its CI run and probe are under
  *Verified live*). CI run 35722320740 for
  `9dc008a` failed on that test; no health blip was seen between 11:36 UTC
  and the green run's swap at 11:42, so the red run did not reach
  production (the three minutes before the poll began were not watched;
  the dashboard setting is in *Open items*). Run 35722799686 for
  `5acd16b` is green and its deploy was probed (*Verified live*);
  `db40b80` changes only the 413's text and was checked by one request
  after its swap. Before those, the 2026-09-20/21 session's commits
  newest first: `31cfa2f`, `eb4b2c8` (handoffs and docs), `1c0d96c` (App()
  into nine hooks; logging out ends silent re-authentication), `7fedcf1`
  (server.js gives up its schedulers, jobs, pillar mount, listen and
  shutdown), `64cdcaf`, `8b5110a` (modules into folders by function),
  `234c107` (the sidebar drawer closes on a phone), `9c15000`
  (refactoring tools, docs, `.graphifyignore`), `470cd2a` (server.js
  helpers to `server/`, the 1,300-line modules split), `deb7baf` (App.jsx
  split).
- **Tests (run after the last code edit, 2026-09-22 13:05 UTC):** backend
  `npm test` 786 tests, 782 pass, 4 skipped, 0 fail; `npm run lint` 0
  errors, 38 warnings (CI cap 500); frontend `npx vitest run` 20 files, 64
  tests (no frontend change this session; CI's build green).
- **Working tree:** clean apart from one untracked file no session made
  (`AGENTS.md`) and the gitignored local artefacts (`backend/data/`, which
  now also holds the OCR language cache under `tessdata/`, and
  `graphify-out/`).
- **Shape of the code now.** Backend entry points stay at the top of
  `backend/` (`server.js` 1,056 lines: configuration, the databases and
  their statements, middleware, `routeDeps`, and one-line calls in boot
  order; `web-launcher.mjs`; `simulation-sidecar.js`). Routes are in
  `routes/` (26 files; `/api/ec` in four); `server/` holds the helpers
  that read server state (nine modules bound to `routeDeps`) and the
  boot-time work (`schedulers.js`, `jobs.js`, `pillars.js`, `boot.js`,
  `shutdown.js`); the domain modules are in `chat/`, `cds/`, `colleges/`,
  `academics/`, `activities/`, `scouts/`, `storage/`, `security/`,
  `simulation/`, `shared/`, beside `council/`, `llm-adapters/`,
  `knowledge-graph/`. `frontend/src/App.jsx` is 746 lines: the core state
  (`user`, `data`, `messages`, `locale`, `authedFetch`), the calls of the
  nine hooks in `src/hooks/`, the survey branch and the props objects;
  `screens/`, `handlers/`, `chat/`, `session/`, `profile/` and
  `components/` hold the rest. Largest hand-written files now:
  `activities/ec-strength-vectorizer.js` 1,145 (one 459-line function),
  `server.js` about 1,090, `colleges/positioning-engine.js` 1,034,
  `storage/rag-engine.js` 990. New since 2026-09-21: `security/safe-fetch.js`
  (the SSRF guard), `server/memory-watch.js` (`[MEM]` and `[DISK]` lines),
  `storage/db-backup.js` (the daily copies).
- **The CDS cache covers 298 schools** (parser version 6; 118 on 2025-26
  documents, 141 on 2024-25). Unchanged this session; the server re-ingests
  the seed at boot in about two seconds.
- **Knowledge graph and Obsidian vault (local, not in git).** graphify
  0.8.43 builds `graphify-out/` from the code and the docs (the 300 parsed CDS
  records and other data are excluded by `.graphifyignore`): 2,994 nodes,
  6,663 edges and 133 labelled communities from 350 files at the last
  build, with `graph.html` and `GRAPH_REPORT.md`. It was rebuilt on 2026-09-21 from
  the final layout (folders, `server/`, `src/hooks/`). The owner's vault
  folder (`Obsidian Vault/Collegeapp-AI` under the OneDrive documents
  folder) holds that export beside six hand-written change summaries that
  are never touched; each export it replaced was moved, not deleted, to a
  dated folder under `Obsidian Vault archive/` beside the vault (the June
  one: `Collegeapp-AI graphify export 2026-06-19`, 1,737 files).
- **Standing authorizations from the user:** push straight to `main`;
  create and delete throwaway `probe-*@example.test` accounts on
  production for live checks. Never ask for or use the counselor's
  password or a real student's, and record nothing from the owner's own
  account here.
- **Deferred by the user (2026-09-07):** the University of Wyoming College
  Fit data-source precedence — "Do not pursue until asked."
- **Node on this machine** is 25.9 with no version manager; the packages
  declare `>=22.13 <23` (`.nvmrc`, `.node-version`, CI and Render run
  22.22), so every local `npm install` warns `EBADENGINE`.

## What changed, newest first

The user's asks on 2026-09-21/22, verbatim: "/code-review check for
reasons of memory overflow", "/deploy-checklist render against security
vulnurabilities commonly made by vibecoders", "init all the fixes", "fix
the bradley parse and then finish the checklist made earlier", "Fix these
too" / "Also these" (the checklist's dashboard-side items), "fix the
College Fit label calibration too".

**College Fit's label is an admission likelihood (2026-09-22)** — the
commit after `1810920`. With a strong probe profile (3.95 GPA, 1520 SAT,
six APs, three activities, no narrative) the card read "Reach" for
Bradley (75% admit) and Indiana (82%) and "High reach" for Harvard. Four
causes in `colleges/positioning-engine.js`, all fixed: the label came
from the composite with fixed cutoffs (85/70/52) and the admit rate could
only lower it (a devaluation of at most 35%), so no open school could
lift a student; missing evidence read as weak evidence — no narrative
was a coherence of 25, no strength rows an EC strength of 25, no class
rank a 50, no awards a 25, and a constant "trend" of 60 carried 7% of
the readiness weight, pulling every student toward the middle; a school
with no averages on file was judged against a 3.75 GPA and a six-course
load, a selective school's numbers, whatever its admit rate; and
calculus did not count as computer-science preparation, so AP CS A +
Calculus BC + Physics C read "without enough preparation". Now
`admissionLikelihood({ readiness, admitRate })`: the admit rate is the
base rate (50% when unknown, never the most selective), the composite
shifts the log-odds by 0.07 per point around 60 (about what a student at
the school's own averages comes to), capped at ±2.4; the likelihood is
`finalPositioningScore` and the label (`classifyPositioningLabel`:
70/40/15). Components with nothing on file drop out of the readiness
blend and the rest re-normalize; the no-narrative and no-rows cases are
neutral (50); `defaultAverageGpaFor(admitRate)` stands in for a missing
average (3.95 at 5% admit, 3.5 at 75%); calculus, linear algebra and
discrete count for CS. Results (local scenarios): the strong profile
reads "Highly competitive" at 75%, 82% and 50% schools (92 / 95 / 77),
"Reach" at an 18% one (35) and "High reach" at 4% (6); a thin 3.7 / 1420
record with one AP reads "Competitive" at 75% and 82% (52 / 47) and
"High reach" at 50% and below (its one course is read as its transcript);
a 3.4 / 1280 record reads "Reach" at 75–82% and "High reach" elsewhere.
The result carries `readinessScore` and `admitRateUsed` for transparency;
the selectivity adjustment is still reported but no longer multiplies the
score. Tests: the likelihood's anchors, the strong and thin students at
open and lottery schools, neutral missing evidence, the recalibrated
bands; two older pins updated (calculus is relevant; de-emphasized tests
weigh less than the GPA rather than under 0.15).

**Unreadable text layers go to OCR, the C1 reader falls back to the
residency table, and the databases are backed up daily (2026-09-22)** —
the commit after `e093abd`. Bradley University's 2025-26 document has
fonts without a Unicode map: pdf.js yields 93,000 items of glyph codes,
which no emptiness check caught, so the parser read nothing and the live
search stored an empty record. `textLayerLooksReadable` in
`shared/file-extractors.js` (letters and digits at least half of the
non-space characters) now sends such a document to OCR in the CDS parser
and makes the upload extractor report it as empty, so the routes' OCR
fallbacks run; none of the 42 cached documents trips it. Parser version 7,
so the daily refresh re-reads every stored row once. The first OCR read of
Bradley's C1 table kept only the "unknown sex" rows — 19 applied, 1
admitted, a 5.3% admit rate that passed the consistency check; that seed
file was thrown away. `cds/cds-pdf-c1.js` now lets the residency table's
Total column win when the gender rows lack men or women, recognises a
Total column with a dropped cell (three or more numbers whose last is at
least the sum of the others), ignores a punctuation token after the
label, and refuses an OCR read under 100 applicants. Bradley reads 8,539
applied and 6,369 admitted (74.6%), checked against the rendered page; no
score bands, GPA or C7 came out of OCR (its tables recognise poorly and
the school is test-optional). `tools/cds-cache/parsed/bradley-university.json`
(version 7) is in the seed so a deployment's older empty row is
re-ingested at boot. A test policy the reader did not find is null, and
an OCR record keeps it unknown (Bradley is test-optional; its first OCR
record said "required"). Then the user's "Fix these too" / "Also these"
on the checklist's dashboard-side items, all in code now:
`RATE_LIMIT_RELAXED` works under `NODE_ENV=test` only and the launcher
strips it; a rotated `WEB_CONFIG_KEY` is re-wrapped from
`WEB_CONFIG_KEY_PREVIOUS` for one deploy (`openWebSecretConfig`), and
without it the launcher keeps running, the site says setup is required,
`GET /api/admin/secrets/status` says why (`configReadable`,
`configProblem`) and saving a secret starts the store again (it used to
crash-loop); `storage/db-backup.js` copies the three databases into
`DATA_DIR/backups/<name>.<date>.db` daily and at boot, keeping seven
(`db_backup` in the job status), and the counselor lists and downloads
them at `GET /api/admin/backups[/<file>]` (exact names only);
`render.yaml` pins `numInstances: 1` and `autoDeployTrigger: checksPass`;
the boot log has a `[DISK]` line. RUNBOOK.md gained the rotation
procedure, the rule to keep the vault key and `WEB_CONFIG_KEY` outside
Render, *Backups*, one instance, CI-gated deploys, and the
unreadable-text-layer symptom. Tests: `cds-text-layer`, `db-backup`,
`web-config-rotation`, five C1 cases, the backups routes in
`admin-models-routes`, four more pins in `deploy-hardening`.

**Memory has a ceiling on every heavy path; the deploy checklist's three
fixes (2026-09-22)** — `9dc008a`. The instance has 512 MB for the launcher,
the server (130 MB idle) and the sidecar (60 MB), and nothing bounded what
a request or a job could add. Measured in a bare process on 2026-09-21:
one scanned CDS ingest (its own tesseract worker) peaked at 321 MB, three
at once — a College Fit request for three schools the store lacks, or the
daily refresh — at 620 MB; the text of three large PDFs at once 256 MB;
ten parses in a row left 414 MB resident with 17 MB live (V8 sizes its
heap from the machine). Now: one document lane for the process
(`runDocumentJob` in `shared/file-extractors.js` — PDF text, DOCX, each
rasterized page; a student's job ahead of background work; a stuck job
given up on after 150 s), the ingest's OCR pass on the shared worker
through that lane, a 4-million-pixel ceiling per rasterized page, the
refresh skipping a cached document whose stored row already carries its
cycle and parser version (`cachedParseIsCurrent`, status `unchanged`),
documents parsed one at a time (`parseInLane`), downloads read under a
40 MB cap with a 90 s timeout (`readBodyCapped`, in `cds-search.js`),
pdf.js documents destroyed in `finally`, the launcher's heap budgets
(server 192/8 MB, sidecar 96/4; `NODE_FLAGS_SERVER`, `NODE_FLAGS_SIDECAR`
override), `[MEM]` log lines (`server/memory-watch.js`: a new high by
32 MB, and hourly), and College Fit waiting at most 20 s for a live read.
After: three OCR ingests 620 → 407 MB with the pipeline lane bypassed
(one at a time through it: 261 MB), three PDFs' text 256 → 172 MB, ten
parses 414 → 163 MB. Found on the way: five lazy `import("./…")` paths
still named files the folder move relocated, so `GET
/api/cds/school/:slug` and `/validation/:slug` answered 500 from
2026-09-20 and the live CDS search, a context read and a calendar read
failed silently — repaired, pinned by `tests/dynamic-imports.test.js`
(every relative dynamic import must exist), and `extract-helpers.mjs`
rewrites them like static imports; the live search also dropped
`consistent` records (`liveIngestStored`). The checklist's fixes: JSON
bodies 1 MB everywhere and 10 MB on `/api/chat`,
`/api/files/extract-text`, `/api/students/transcript-import` parsed after
the session check (`parseLargeJsonBody`; it was one 20 MB parser for
every path before any check); the repository link `cds-search.js`
fetches goes through the SSRF guard with each redirect hop checked — the
guard moved to `security/safe-fetch.js` (`safeFetch(url, options, {
fetchImpl, assertTarget })`; the pipeline re-exports the old names);
tesseract.js's language data is cached under `DATA_DIR/tessdata` instead
of the working directory (`ocrCacheDir`; `TESSDATA_CACHE_DIR` overrides;
the two `.traineddata` files that sat beside `server.js` were that cache);
the CDS read routes log exception text instead of sending it. Tests:
`ocr-lane`, `memory-budget`, `dynamic-imports`, `deploy-hardening`, the
ingest and search files, two request-body cases in `endpoints.test.js`.
`CLAUDE.md` gained the *Memory and outbound requests* paragraph,
`RUNBOOK.md` the memory notes and two "when something is wrong" bullets.

The user's asks in the previous session, verbatim: "/graphify organize the current
repo state and make sure that the parsed cache goes to the SSD, not stay on
RAM" — "Also, use these to make my obsidian graph. Also, split monolithic
files" — (with a phone screenshot of the open sidebar) "This tab doesn't
close in the smartphone browser settings. Make a close button please over
here. Also, I want to split up files in the backend and frontend by general
function of the files making it easy to maintain and also, to easy to
reduce tech debt. Also, I got obsidian connected."

In plan mode the user then chose, from the options offered: further
splitting "Both" (App.jsx into hooks and server.js boot + schedulers), and
for Obsidian "Leave settings alone" (no colour groups written into the main
vault's graph settings).

**App() becomes nine hooks; logging out ends silent re-authentication
(2026-09-21)** — `1c0d96c`. `src/hooks/`: useCreateAccountForm,
useSurveyForm, useLoginForm, useChatThreads, useCollegeFit, useChatTools,
useChatFiles, useSessionLifecycle, useAuthHandlers. `extract-hook.mjs`
moves a contiguous run of App()'s statements into `useX(ctx)` and leaves
the call where the run was, so all 15 effects keep their order (the tool
re-derives the sequence and fails if it changed); `regroup-app.mjs` first
brings a concern's scattered declarations together, never moving an effect
and only when nothing can observe the move at render time. Tests came
first (`App.flows.test.jsx`: account creation into the survey, target
schools, threads, logout). The logout test failed one run in three with
`expected 'tok_test_1' to be null`, and the bug was older than the
refactor: `authedFetch` re-authenticates silently when it finds no token,
and after logout the passphrase provider was only cleared by an effect on
the next render, so a background request in that window — or a re-auth in
flight — signed the student back in behind the login screen.
`chat/chat-client.js` gains `endSessionReauth()` (clears the provider at
once, bumps an epoch so an in-flight re-auth drops its token);
`handleLogout` calls it first, `handleDeleteAccount` after the server
confirms. Pinned in `chat/chat-client.test.js`.

**server.js gives up its boot-time work (2026-09-21)** — `7fedcf1`.
`server/schedulers.js` (the two scouts' schedule, due-check and run;
`policyScoutRunning` moved with the only function that assigns it and
`routeDeps` still answers it, an ESM import being a live binding).
`wrap-statements.mjs` is new: a contiguous run of top-level statements
becomes `export function name(deps)` with `name(routeDeps);` left in the
same place, so boot order is unchanged; with it `server/jobs.js`
(registerServerJobs, startModelCatalogRefresh), `server/pillars.js`
(mountPillars) and `server/boot.js` (startListening). `shutdown` moved
verbatim to `server/shutdown.js`; the three `process.on` lines stay.

**Modules sit in folders by function (2026-09-21)** — `8b5110a`. 108 files
moved with `git mv` (the folder list is under *Where things stand*);
`scripts/refactor/move-modules.mjs` rewrote the 447 relative path literals
that named them in every tracked module (imports, dynamic imports,
re-exports, eight file reads in tests). Six data paths built from
`__dirname` in `cds/` gained a `".."` by hand. The tool's first version
also treated `"."` and `".."` as paths, so `host.split(".")` became
`split("..")` in every moved file; seven tests failed (registrable
domains, GPA parsing), the uncommitted move was discarded and redone, and
strings made only of dots and slashes are never touched now. Checked by
diffing every moved backend file against its old self (import paths, two
dynamic imports and the six fixes, nothing else) and by the student bundle
being byte-identical before and after (`main-C7fIM242.js`). Two tests that
pinned an import path by its text name the new folder.

**The sidebar drawer closes on a phone (2026-09-20)** — `234c107`. Under
768px the sidebar is a fixed drawer above everything and the only control
that closed it, the header toggle, sat underneath it. `screens/Sidebar.jsx`
carries the shared × ("Close sidebar") at every width, and under the phone
media query a dimmed backdrop (`.cc-sidebar-backdrop` in `app-shared.js`)
closes it on a tap. Pinned in `App.dashboard.test.jsx`.

**server.js helpers and the 1,300-line modules (2026-09-20)** — `470cd2a`.
1,840 lines of helper functions moved verbatim into nine `server/<area>.js`
modules (auth, model-calls, verified-data with `regulatedChatGate`,
narrative-calendar, chat-attachments, student-data, positioning with
`runPositioning`, ec-ranking, baseline-colleges). A reference to a server
binding became `deps.<name>`; each module keeps `deps` in one variable set
by `bind<Area>(routeDeps)`, and `routeDeps` with the bind calls now sits
right under the imports (getters are lazy; an imported helper is callable
from the first line like the hoisted function it replaces). Functions were
not re-indented, so prompt templates keep their text. `routes/ec.js` (24
routes) became four modules registered in the original order. Re-exporting
splits, importers unchanged: `rag-schema.js`, `directionality-vectorizer.js`
+ `vector-utils.js`, `ec-strength-schema.js`, `cds-pdf-text.js` /
`cds-pdf-c7.js` / `cds-pdf-c1.js`, `policy-scout-extract.js` (holds
`SCOUT_VERSION`, unchanged) / `policy-scout-fetch.js`.

**App.jsx splits into the modules it was made of (2026-09-20)** —
`deb7baf`. 5,078 → 1,266 lines. Module-level code moved as closed sets,
bottom layer first (vault-storage, server-session, profile-analysis,
agent-prompts, agent-tools, chat-files, chat-client, markdown,
chat-orchestrator); the chat `<main>` is `ChatScreen.jsx` (37 props);
App()'s large `useCallback` bodies are `name(ctx, ...params)` functions in
chat-send, auth-handlers, survey-handlers, school-handlers, with App
keeping each hook and dependency array. One default parameter read an App
binding before `ctx` was destructured (`base = data`); it reads `ctx.data`
and the tool makes that rewrite itself now. New test: a course question
goes through the keyword gate to the academics agent and the reply
renders (no frontend test sent a chat message before). Backend tests that
pinned App.jsx by its text read every frontend module through
`tests/helpers/frontend-source.mjs`.

**Tools and docs (2026-09-20)** — `9c15000`. `backend/scripts/refactor/`
gained module-graph, extract-module, extract-helpers, split-route-module,
extract-callback, prune-bare-imports (and move-modules in `8b5110a`); its
README says which to reach for and in what order. `CLAUDE.md` and
`RUNBOOK.md` describe the layout as it is. `.graphifyignore` keeps data
out of the knowledge graph.

**Earlier sessions, compressed** (long form: `git show 812cdeb:SESSION-HANDOFF.md`).
2026-09-16, the tech-debt plan: CI job timeouts and SIGKILL teardown
(`957205c`), CRLF renormalized (`d120ab5`), the refresh hold-back guard
(`db883b0`), CDS PDFs out of git (`c08c12c`), RUNBOOK and `.nvmrc`
(`3e9f57f`), Express 5 / React 19 / better-sqlite3 13 / pdf-parse 2 /
tesseract.js 7 / eslint 10 (`bd5650e`, `6a276b9`, `50f5d8a`), the route
families out of server.js (`5ce0056`), Sidebar, Survey, Login and
CreateAccount out of App.jsx (`697a7c0`, `dbdc6b8`), the section reader's
missed layouts and a whole-index re-parse (`b0c035b`). 2026-09-15/16, CDS:
College Fit reads the 2025-26 documents (`72f2509`), the workbook C7 read
and the newer-cycle guard (`ef1d56e`), the remaining CDS sections reach the
model (`40b1ee6`, `2f287de`), × close controls (`0af239e`), chat
attachments filed under Documents and the collapsible sidebar (`dacc220`).
2026-09-13: single fetches for Course plan, calendar and Spike Finder
(`3a8fdc3`, `9ec5edc`), research output as achievement (`0caa68e`), chat
PDF uploads and four UI defects (`58b28fb`). 2026-09-11: course rigor in
College Fit (`fa6c5b1`, `6a29565`, `651f7ac`, `95f5116`). 2026-09-09: chat
files read into the activities they name (`b734c6c`), the priorities matrix
reads the whole record (`4eae5cc`), audits clean (`cd15135`, `ba07b4e`).
Before that: the CDS parser's ACT bands and GPA tables (`c33004f`), policy
scout deadline tables and the official-source gate (`c4c5bb0` and earlier).

## Verified live, and not

- **After `5acd16b` (blip 11:42:09–11:42:49 UTC 2026-09-22; the bundle
  unchanged, `main-C4F9IWW6.js`):** `GET /api/cds/school/harvard-university`
  401 without a token and 200 with one (Harvard 2025-26, admit 0.0418 — it
  had answered 500 since 2026-09-20), `/api/cds/validation/…` 200
  `consistent`; a 1.1 MB JSON body to `/api/students/register` 413; a 2 MB
  body to `/api/files/extract-text` without a token 401; register 201,
  consents, sync 200; `POST /api/positioning/targets` 200 in 2.9 s with
  Indiana (2024-25, consistent) and Bradley University, which the store
  lacked: the live search downloaded and parsed its 2025-26 document
  within the request and `GET /api/cds/school/bradley-university` then
  returned it (no admit rate in the parse — *Open items*); `POST /api/chat`
  200 in 2.3 s on the medium tier, "In-state: $10,622 / Out-of-state:
  $40,369" for Indiana; `POST /api/files/extract-text` with a 266 KB PDF
  200 in 1.5 s, 45,257 characters (the document lane); `DELETE
  /api/students` 200 and the token 401 afterwards. Not checked: Render's
  log (`[MEM]` lines, `[cds/live-search]`), which needs the dashboard.
- **After `db40b80` (blip 11:47:13–11:47:47 UTC 2026-09-22):** a 1.1 MB
  JSON body to `/api/students/register` answered 413
  `{"error":"Request body too large."}`.
- **After `ad13a62` (CI run 35731065695; blip 13:05:39–13:06:05 UTC
  2026-09-22):** two throwaway accounts, deleted afterwards. The strong
  profile (3.95 GPA, 1520 SAT, six APs, three activities, no narrative):
  Bradley "Highly competitive" 92.1 (readiness 79.7, admit rate used
  0.75), Indiana "Highly competitive" 94.2 (readiness 81.5, 0.78),
  Harvard "High reach" 7.4 (readiness 68.6, 0.04; one flag, the transcript
  light against Harvard's range). The thin profile (3.7 / 1420, one AP,
  one activity): Bradley "Competitive" 52.4, Indiana "Competitive" 45.2,
  Harvard "High reach" 0.4, with the two coursework flags. Before this
  deploy the same strong profile read "Reach" at Bradley and Indiana.
- **After `03ed23f` (CI run 35727260532; blip 12:28:40–12:29:14 UTC
  2026-09-22):** the same probe as after `5acd16b` passed again (Harvard's
  CDS route 401/200, the 413 with its text, the stranger's 2 MB file 401,
  register, consents, sync, chat 200 with the Indiana tuition figures and
  a source line, the 266 KB PDF through the lane 200, delete 200, token
  401), and `GET /api/cds/school/bradley-university` returned the
  re-ingested seed: 2025-26, admit 0.7459, `consistent` — the boot
  re-ingest of a version-7 seed over the version-6 row works. Not probed:
  the administrator routes (the counselor's session is never used), so
  the backups list and download, the secrets status fields and the
  `[DISK]`/`[BOOT]` lines are covered by tests and CI only.
- **After `9c15000` (14:50 UTC 2026-09-20, bundle `main-BFi5gbxM.js`):** a
  throwaway account registered, granted the three consents and synced a
  small profile; `/api/positioning/targets` returned Indiana University
  Bloomington (2024-25) and Middlebury (2025-26) from the store;
  `POST /api/chat` answered the Indiana tuition and wait-list question
  "10,622 USD; 40,369 USD; 7,524" with `verifiedData: true`; the GETs
  `/api/ec/vectors`, `/api/ec/narrative/active`, `/api/ec/strength`,
  `/api/ec/spike`, `/api/students/profile`, `/export`, `/deadlines`,
  `/budget` and `/api/baselines/status` returned 200 (`/api/ec/cache-memory`
  410, the administrator-only answer it gave before); `DELETE
  /api/students` 200 and the token answered 401 afterwards.
- **After `8b5110a` (folders):** the restart blip was 15:09:40–15:10:08
  UTC 2026-09-20 and the full probe seventeen seconds later passed, chat
  included ("10,622 USD; 40,369 USD; 7,524", `verifiedData: true`).
- **After `7fedcf1` (boot split; blip 09:40:32–09:41:03 UTC 2026-09-21):**
  register 201, consents, sync 200, positioning 200, the `/api/ec` GETs and
  `/api/students/export` 200, delete 200, token 401 afterwards — the split
  server boots, registers its jobs, mounts the pillar routes and listens.
- **After `1c0d96c` (hooks):** the new student bundle `main-C4F9IWW6.js` (byte-identical
  to the local build) was live at 10:07:45 UTC 2026-09-21; the full probe
  passed, chat included: register 201, consents, sync 200, positioning 200
  (Indiana 2024-25, Middlebury 2025-26), `POST /api/chat` 200 with
  `verifiedData: true` and "In-state tuition: 10,622 USD …", the `/api/ec`
  GETs and export 200, delete 200, token 401 afterwards. Every backend
  change of the session is in that deploy.
- **Chat answered 429 for a while on 2026-09-21** (09:28 and 09:41 UTC, five
  tries across two deploys and two tiers): `{"error":"Provider returned
  error","code":"http_error"}`. That is OpenRouter passing on its upstream
  provider's rate limit (`llm-adapters/openai.js` forwards the provider's
  status and message), not a server fault; by 10:08 UTC the same question
  answered 200 again. If students report chat failing, check the OpenRouter
  key's limits and credit first.
- **Not verified:** nothing was looked at in a browser. The sidebar's close
  button and backdrop, ChatScreen and the moved handlers are covered by
  the dashboard tests (sign-in, in-place edits, a chat send, the drawer
  closing) and by the production bundle being served; the sidebar exists
  only after sign-in, which a session may not do. The owner reported the
  drawer problem from a phone and should confirm the fix there.

## Open items and things to watch

- **Refreshing the graph and the vault.** Run `/graphify` (or `/graphify
  . --update`) from the repository root: the AST pass over the code is free
  and takes about 20 seconds; the docs are cached by content hash, so only
  edited ones need a subagent. Then `graphify export obsidian` and copy into
  the vault folder the way this session did: move only files that carry
  graphify frontmatter or a `_COMMUNITY_` prefix (and `graph.canvas`) to a
  dated archive outside the vault, never the six hand-written notes
  (`index.md`, `strategy-council.md`, `embedded-llm-stack.md`,
  `seasonal-retrieval-first.md`, `logseq-pii-vault.md`,
  `chat-graph-vault-context.md`). Community colours are written to
  `Collegeapp-AI/.obsidian/graph.json`, read only when that folder is
  opened as its own vault; the owner chose to leave the main vault's graph
  settings alone. An Obsidian MCP connector is attached to the owner's
  sessions; it is fine for reading and spot checks, not for writing
  thousands of notes.
- **graphify never caches a JavaScript parse per file** (`.js`, `.jsx`,
  `.mjs` bypass its AST cache because their import resolution depends on
  other files). What persists on disk is `graph.json` + `manifest.json`
  (which `--update` builds on), `cache/semantic/` for the docs and
  `cache/ast/` for JSON; this session also kept the whole AST extraction
  as `graphify-out/cache/ast-extraction.json`. Everything is on the NVMe
  system drive; there is no RAM disk on this machine.
- **Next splits, if wanted:** the survey branch of App() (about 170 lines
  of step logic with small JSX helpers) needs a variant of
  `extract-hook.mjs` that works inside a block and writes `.jsx`;
  `server.js` still holds 250 lines of table setup and prepared statements
  that could become `server/statements.js`; `vectorizeECStrength` is one
  459-line function and `chat-orchestrator.js`'s `orchestrateStages` is
  383. `routeDeps` is a flat bag of about 130 getters.
- **Garbled banner comments in `storage/rag-engine.js` and
  `storage/rag-schema.js`** (an old encoding accident, present at
  `812cdeb` too; the file also starts with a BOM). Cosmetic.
- **`extract-routes.mjs` re-indented the route handlers on 2026-09-16**,
  so any multi-line template literal inside a route gained two spaces per
  line. Not checked this session; tests and live probes have passed since.
  `extract-helpers.mjs` does not re-indent.
- **CDS data:** five records carry no C1 counts, 104 no C7 weights;
  Columbia, Caltech, Northwestern and UChicago are on older cycles; JHU's
  document must be fetched by hand each cycle (Cloudflare);
  `scripts/refresh-cds.mjs` fails against this machine's old local
  database, so refreshes run against a scratch database (RUNBOOK.md).
- **Carried over, one line each** (details in the 812cdeb handoff): the
  new CDS sections reach the model but no UI renders them; tier floors
  still require leadership ≥ 0.2 for "Developing"; strength rows recompute
  only on sync or the recompute route; tool panels open inline in the chat
  column; "Suggest ECs for me" was reported blocked once and not
  reproduced; the rigor units figure is rendered nowhere; the fit refresh
  is wired but not tested end to end; the rigor expectation is a GPA proxy;
  the server guesses locale from Accept-Language when the app sends none;
  chat evidence is keyed by activity name; prestige rationales are
  English-only; parser extras are unvalidated; the small tier sometimes
  returns an empty reply.
- **Deploy checklist, what is still the dashboard's:** whether disk
  snapshots exist for `college-counselor-data` (the daily copies under
  `backend/data/backups/` are on the same disk; the counselor's download
  is the copy off the box), and a look at the boot log's `[DISK]` and
  `[MEM]` lines. Everything else the checklist left to the dashboard is
  pinned in code or `render.yaml` since the commit after `e093abd`.
  Whether Render honours the two new `render.yaml` keys for this service
  (created from the blueprint?) was not checked; the CI-gated deploy was
  observed to be in effect regardless.
- **`[MEM]` lines were not read this session.** After `9dc008a` the boot
  log should show `[MEM] rss … (high …)` at once and an hourly line after
  that; the server alone above about 380 MB, or a restart for memory, is
  the rollback trigger (RUNBOOK.md, *When something is wrong*).
- **The document lane's queue is unbounded:** a flood of scanned uploads
  waits in line instead of overflowing memory, bounded per IP by the
  30-a-minute limiters. If latency complaints appear, refuse when more
  than a few jobs are waiting.
- **The live CDS search is back on** (it had failed silently since
  2026-09-20): College Fit for a school the store lacks downloads and
  parses its document within 20 s and stores a `consistent` or
  `no_truth` record, tagged unvalidated. `[cds/live-search] ingested …`
  in the log; the store grows with what students look up. Bradley's
  record now carries its counts and admit rate (the change log above) but
  no score bands, GPA or C7. A school with no rate at all is labelled
  "High reach" by the engine's uncertainty penalty (positioning-engine.js
  line ~792), which reads as a verdict rather than "no data" — worth a
  neutral label — done in the recalibration (the change log above): an
  unknown admit rate is taken as 50%.
- **Parser version 7 re-reads the whole store once:** the next daily
  refresh (June to December, daily) parses every cached document again,
  one at a time in the lane — text layers in seconds, the unreadable or
  scanned ones by OCR at minutes each. Watch `[BATCH] cds_daily_refresh`
  and the `[MEM]` lines the first time it runs.
- **The knowledge graph was not rebuilt this session** (new modules:
  `security/safe-fetch.js`, `server/memory-watch.js`,
  `storage/db-backup.js`; the docs changed). `/graphify . --update` from
  the repository root, then the vault sync described above.
- **Untracked files to decide about:** `AGENTS.md` (a copy of an older
  CLAUDE.md). `backend/kor.traineddata` and `eng.traineddata` were
  tesseract.js's download cache and now live under
  `backend/data/tessdata/` (gitignored, `*.traineddata`).

## Quick verification recipes

Gates: `cd backend && npm test && npm run lint && node --check server.js`;
`cd frontend && npx vitest run && npm run build`. CI adds `npm audit
--audit-level=high` and the web-launcher build.

After any move of code between files: `node
backend/scripts/refactor/undef-check.mjs <files>` (unresolved identifiers),
then the gates. After `move-modules.mjs`: read its `--log` output, diff a
few moved files against `git show HEAD:<old path>`, and compare the
`assets/main-*.js` hash of `npm run build` before and after (a pure move
leaves it identical).

Live probe (Node 22+, a `.mjs` in a scratch folder, `BASE` the site): print
the account name first; register `probe-…@example.test` with grade 11, CA,
`example.edu`, `ageAttestation: true`; grant `data_processing`,
`ai_interaction`, `cross_border_transfer` through `POST /api/consent/grant`
(`grantedBy: "student"`); `POST /api/students/sync` a small profile; `POST
/api/positioning/targets` with two school names and read `yearLabel`;
`POST /api/chat` with a `request_id` (a UUID — the route answers 400
without one) and a numbers-only question about a school in the store; a GET
from each `/api/ec` module; `DELETE /api/students` with retries, then
confirm the token answers 401. The fuller recipe for the chat-evidence and
values paths is in the 812cdeb handoff. Since `9dc008a` also: `GET
/api/cds/school/harvard-university` with the token (200 with the record;
it answered 500 from 2026-09-20 until then), `POST
/api/files/extract-text` with a small PDF as base64 (200 with text, through
the document lane), a 1.1 MB JSON body to `/api/students/register` (413)
and a 2 MB body to `/api/files/extract-text` without a token (401, the
body never parsed), and a positioning request naming a school the store
lacks (the live search; read `dataProvenance`).

Memory scenarios, local: a `.mjs` in a scratch folder that imports
`cds/cds-pdf-parser.js` or `shared/file-extractors.js`, samples
`process.memoryUsage.rss()` from a worker thread every 20 ms, and parses
the largest documents in `backend/tools/cds-cache/pdfs` (one, three at
once, twenty-four in a row) or runs `extractItems(path, { method: "ocr",
ocrMaxPages: 4 })`; run it with `--expose-gc`, then again with the
launcher's heap flags. The figures of 2026-09-21/22 are in `9dc008a`'s
commit message.

Deploy markers: `/` carries `assets/main-*.js`; `/admin.html` carries
`assets/admin-*.js`; a backend-only deploy shows only as a brief
`/api/health` blip two to eight minutes after CI succeeds. Refreshing the
CDS cache: RUNBOOK.md.

## Tooling notes

- The Bash tool mangles backslashes and apostrophes inside heredocs and
  `node -e` / `python -c` strings (`"\n"` arrives as a real newline, and a
  file written that way does not parse). Write scripts, patches and commit
  messages with the Write tool and run or `-F` them. A `python - <<EOF`
  pipeline hung for its whole timeout; same remedy. The same mangling hits
  `cat > file <<'EOF'` heredocs (a regex `\(` arrived as `(` twice on
  2026-09-21/22) and `printf '\n'`; `sed` patterns without backslashes
  are safe.
- `git add -p` is unavailable, so a change set whose files overlap lands
  as one commit (`9dc008a` carries the memory work and the checklist fixes).
- Parallel Bash calls share one working directory and a `cd` in one moves
  the others — use absolute paths. `npx vitest run` from the repository
  root finds no jsdom config and fails every test in milliseconds; run it
  from `frontend/`.
- A test that fails one run in three is a finding, not noise: the logout
  flake of 2026-09-21 was a real race in production code.
- Stage explicit paths (or `git add -u` when every tracked change is
  yours); never the two untracked files. Commit messages end with
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- CI watch: `gh run watch <id> --exit-status`; a background `until` loop on
  the bundle hash or on `/api/health` notifies when a deploy lands.
- A UI test that passes alone but times out in the full `npx vitest run`
  is queueing behind other files: give it the time it takes.
- jsdom has no `scrollIntoView` (`frontend/src/test-setup.js` shims it) and
  evaluates no media queries, so a phone-only control must be testable
  without them.
- Some backend files start with a UTF-8 BOM; insert imports after line 1.
- `useCallback` dependency arrays evaluate at render, so a state variable
  must be declared above the callback that lists it.
- graphify: subagents extracting the docs took 10 and 19 minutes; the AST
  pass about 20 seconds. Its Obsidian export writes one note per node
  (about 2,900 here), so export to `graphify-out/obsidian` first and copy.
