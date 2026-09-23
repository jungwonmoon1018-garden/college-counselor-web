# Session handoff

One current document for whoever picks this repository up next — a person
or a fresh Claude session with no access to the conversation that produced
it. Read `CLAUDE.md` first: it is the edit-time harness (invariants, how to
prove a change, how to land it); `RUNBOOK.md` is the operator sheet. This
file says where things stand, what changed recently and why, what was
verified live, and what is open. It was compressed on 2026-09-22; the long
form of the 2026-09-20 to 22 entries is in git (`git show
cb499e8:SESSION-HANDOFF.md`) and of everything dated 2026-09-16 or earlier
in `git show 812cdeb:SESSION-HANDOFF.md`.

## Where things stand (2026-09-24, early morning KST)

- **Deployed:** `main` at `52e9fb7` is the last code commit live at
  https://college-counselor-web.onrender.com (CI run 35875601027, health
  blip 14:39:35–14:40:07 UTC 2026-09-23, probed — *Verified live*). This
  file's commit after it changes no code and redeploys the same server
  once its CI run is green. A finished sweep is not repeated (its run is
  under the current sweep rules); one the restart cuts short resumes at
  the next boot and skips what it read in the last day.
- **Tests (run 2026-09-23 after the last edit):** backend `npm test` 792
  tests, 788 pass, 4 skipped, 0 fail; `npm run lint` 0 errors, 38 warnings
  (CI cap 500); `node --check server.js` clean; frontend `npx vitest run`
  20 files, 64 tests (no frontend change since 2026-09-21; CI's build
  green on every run).
- **Working tree:** clean. `AGENTS.md` (an older copy of `CLAUDE.md` kept
  for another coding agent) is gitignored since `2842f58`;
  `backend/data/` (real student data, the OCR language cache under
  `tessdata/`, the daily `backups/`) and `graphify-out/` are gitignored
  local artefacts.
- **Shape of the code.** Backend entry points stay at the top of
  `backend/` (`server.js` about 1,090 lines: configuration, the databases
  and their statements, middleware, `routeDeps`, one-line calls in boot
  order; `web-launcher.mjs`; `simulation-sidecar.js`). `routes/` holds the
  26 route files; `server/` the helpers bound to `routeDeps` and the
  boot-time work (`schedulers.js`, `jobs.js`, `pillars.js`, `boot.js`,
  `shutdown.js`, `memory-watch.js`); the domain modules sit in `chat/`,
  `cds/`, `colleges/`, `academics/`, `activities/`, `scouts/`, `storage/`,
  `security/`, `simulation/`, `shared/`, beside `council/`,
  `llm-adapters/`, `knowledge-graph/`. `frontend/src/App.jsx` (746 lines)
  holds the core state and calls the nine hooks in `src/hooks/`;
  `screens/`, `handlers/`, `chat/`, `session/`, `profile/` and
  `components/` hold the rest. Largest hand-written files:
  `activities/ec-strength-vectorizer.js` 1,145 (one 459-line function),
  `colleges/positioning-engine.js` about 1,100, `server.js`,
  `storage/rag-engine.js` 990.
- **The CDS cache covers 298 schools** (parser version 7; 118 on 2025-26
  documents, 141 on 2024-25); the server re-ingests the seed at boot in
  about two seconds.
- **Knowledge graph and Obsidian vault (local, not in git).** graphify
  0.8.43 builds `graphify-out/` from the code and the docs (the parsed CDS
  records and other data are excluded by `.graphifyignore`): 3,051 nodes,
  6,952 edges and 130 labelled communities at the rebuild of 2026-09-22
  (113 community names carried over from the 2026-09-21 build by member
  overlap, 17 named anew), with `graph.html` and `GRAPH_REPORT.md`. The export is copied into the
  owner's vault folder `Obsidian Vault/Collegeapp-AI` (under the OneDrive
  documents folder) beside six hand-written notes that are never touched;
  each export it replaces is moved, not deleted, to a dated folder under
  `Obsidian Vault archive/` beside the vault. Not rebuilt after
  `52e9fb7` (three files edited, nothing moved).
- **Standing authorizations from the user:** push straight to `main`;
  create and delete throwaway `probe-*@example.test` accounts on
  production for live checks. Never ask for or use the counselor's
  password or a real student's, and record nothing from the owner's own
  account here.
- **Deferred by the user (2026-09-07):** the University of Wyoming College
  Fit data-source precedence — "Do not pursue until asked."
- **Node on this machine** is 25.9 with no version manager; the packages
  declare `>=22.13 <23` (CI and Render run 22.22), so every local `npm
  install` warns `EBADENGINE`.

## What changed, newest first

The user's ask on 2026-09-23, verbatim: "ok, start doing these things",
in reply to the three open items of the 2026-09-07 report: two throwaway
probe accounts whose deletes were lost to a restart and a connection
timeout, the sixty-school cap on the policy sweep, and `AGENTS.md` /
`backend/kor.traineddata`. The third had been settled on 2026-09-22
(`2842f58`: both gitignored, `AGENTS.md` kept on purpose). The first is
left to the owner (*Open items*). The second is `52e9fb7`.

**A policy sweep reads every tracked school, not sixty (2026-09-23)** —
`52e9fb7`. The tracked list (students' goal schools, every school with a
stored CDS, the research cache) is about three hundred schools, so sixty a
fortnight left most of them unread for months (*Verified live*,
baseline). In `scouts/admissions-policy-scout.js`: `policyScoutRunLimits`
sizes a run (every tracked school up to `SWEEP_CEILING`, 1,000, a runaway
guard; `POLICY_SCOUT_MAX_SCHOOLS` and `POLICY_SCOUT_CONCURRENCY` still
apply); a school a sweep has read keeps its stored homepage, name and
unit id for 45 days instead of a new College Scorecard search (the IPEDS
seed carries no websites, and the Scorecard quota is College Fit's too);
an automatic sweep skips what the running scout version read in the last
20 hours (`SWEEP_FRESH_MS`), so a sweep cut short by a deploy resumes
where it stopped; a counselor's manual run skips nothing. Each run
records `sweepRules` (`SWEEP_RULES_VERSION`, now 2) and `recentlyRead`,
and `policyScoutDue` makes a sweep due at once after a sweep under older
rules — how the first full sweep ran at the first boot rather than around
2026-10-05, without a `SCOUT_VERSION` bump that would have marked every
stored reading stale. `CLAUDE.md` and `RUNBOOK.md` describe the sweep.
Found on the way: no administrator route lists or removes a student
account (the 2026-09-07 advice to delete the probes "from the admin
roster" was wrong), and the scout's manual run is an API route with no
control on the admin page.

The user's asks on 2026-09-21/22, verbatim: "/code-review check for
reasons of memory overflow", "/deploy-checklist render against security
vulnurabilities commonly made by vibecoders", "init all the fixes", "fix
the bradley parse and then finish the checklist made earlier", "Fix these
too" / "Also these" (the checklist's dashboard-side items), "fix the
College Fit label calibration too", "fix the thin profile High reach at
50% schools too", and "Fix these things please" (the open items of the
last report: the graph, `AGENTS.md`, this file's length, the Render-side
checks).

**The open items closed (2026-09-22, night)** — `2842f58` and the
handoff commit after it. `AGENTS.md` is gitignored (`/AGENTS.md`) and
`CLAUDE.md`'s *Landing a change* names it as one of the two gitignored
local files; the knowledge graph and the vault were rebuilt from the
current tree; this file was compressed from 656 lines. Two of the
Render-side checks are settled by the platform's documented rules rather
than by a look at the dashboard: a service with a persistent disk cannot
be scaled to more than one instance ("a persistent disk is accessible by
only a single service instance"), and Render snapshots every disk once
every 24 hours and keeps each snapshot at least seven days. So
`numInstances: 1` holds with or without the `render.yaml` key, and the
disk has snapshots beside the daily copies the server writes. What only
the dashboard can show is listed under *Verified live, and not*.

**College Fit's label is an admission likelihood, and a thin record is
not a weak one (2026-09-22)** — `ad13a62`, `6a5caa6`, `9e275cb`. A strong
probe profile (3.95 GPA, 1520 SAT, six APs, three activities, no
narrative) read "Reach" at Bradley (75% admit) and Indiana (82%). In
`colleges/positioning-engine.js` the label came from a composite with
fixed cutoffs that the admit rate could only lower; missing evidence read
as weak evidence (no narrative was a coherence of 25, no strength rows an
EC strength of 25, no awards 25, a constant "trend" of 60); a school
without averages on file was judged against a selective school's numbers;
and calculus did not count as computer-science preparation. Now
`admissionLikelihood({ readiness, admitRate })`: the admit rate is the
base rate (50% when unknown), the readiness composite shifts the log-odds
by 0.07 per point around 60, capped at ±2.4; the likelihood is
`finalPositioningScore` and `classifyPositioningLabel` cuts at 70/40/15.
Components with nothing on file drop out of the readiness blend, the
no-narrative and no-rows cases are neutral (50),
`defaultAverageGpaFor(admitRate)` stands in for a missing average, and
calculus, linear algebra and discrete count for CS. Then the thin record
(3.7 / 1420, one AP entered): its one course had been read as a light
transcript. `courseEvidence` (courses on file / 8, capped at 1) scales
the rigor weight and half of the major-preparation weight, the two
coursework red flags wait for four courses or more, and the GPA reads as
the share of the enrolled class (spread 0.25 around its average) at or
below it — 56 at the average, 77 at 0.2 above, 35 at 0.2 below. Local
scenarios: the strong profile "Highly competitive" at 75%, 82% and 50%
schools, "Reach" at 18%, "High reach" at 4%; the thin one "Highly
competitive" at 75–82%, "Reach" at 50% (36), "High reach" at 18% and
below; a 3.4 / 1280 record "Competitive" at 75–82%, "Reach" at 50%; a
student at a school's own averages comes to a readiness of 54–63, the
likelihood's centre. The result carries `readinessScore` and
`admitRateUsed`. Found by the probe: "Purdue University" resolved to
Purdue University Northwest, because IPEDS names the flagship "Purdue
University-Main Campus" and `resolveBaselineCollegeRow`'s prefix rule
scored one extra word above two; the "Main Campus" suffix now counts as
no extension, and `runPositioning` asks the CDS store for the typed name
before the index's name. Tests: the likelihood's anchors, strong and thin
students at open and lottery schools, neutral evidence, course evidence,
the GPA percentile, `baseline-resolver.test.js`.

**Unreadable text layers go to OCR, the C1 reader falls back to the
residency table, and the checklist's dashboard-side items are in code
(2026-09-22)** — `03ed23f`. Bradley University's 2025-26 document has
fonts without a Unicode map, so pdf.js yielded 93,000 items of glyph
codes and the live search stored an empty record. `textLayerLooksReadable`
(`shared/file-extractors.js`: letters and digits at least half of the
non-space characters) sends such a document to OCR in the CDS parser and
makes the upload extractor report it as empty; none of the 42 cached
documents trips it; parser version 7 re-reads every stored row once.
`cds/cds-pdf-c1.js` lets the residency table's Total column win when the
gender rows lack men or women, recognises a Total column with a dropped
cell, ignores a punctuation token after the label, and refuses an OCR
read under 100 applicants (the first read had kept only the "unknown sex"
rows: 19 applied, 1 admitted). Bradley reads 8,539 applied, 6,369
admitted (74.6%), test policy unknown (an OCR read that finds no policy
keeps null); the version-7 seed is in `tools/cds-cache/parsed/`. Then the
checklist's items: `RATE_LIMIT_RELAXED` works under `NODE_ENV=test` only
and the launcher strips it; a rotated `WEB_CONFIG_KEY` is re-wrapped from
`WEB_CONFIG_KEY_PREVIOUS` (`openWebSecretConfig`), and without it the
launcher keeps running, `GET /api/admin/secrets/status` says why
(`configReadable`, `configProblem`) and saving a secret starts the store
again instead of crash-looping; `storage/db-backup.js` copies the three
databases into `DATA_DIR/backups/<name>.<date>.db` daily and at boot,
keeping seven, and the counselor lists and downloads them at `GET
/api/admin/backups[/<file>]`; `render.yaml` pins `numInstances: 1` and
`autoDeployTrigger: checksPass`; the boot log has a `[DISK]` line.
RUNBOOK.md gained the rotation procedure, *Backups*, the one-instance and
CI-gated-deploy notes and the unreadable-text-layer symptom.

**Memory has a ceiling on every heavy path; the deploy checklist's three
fixes (2026-09-22)** — `9dc008a`, `5acd16b` (a test timer), `db40b80` (a
413 says "Request body too large."). The instance has 512 MB for the
launcher, the server (130 MB idle) and the sidecar (60 MB); measured in a
bare process, one scanned CDS ingest peaked at 321 MB and three at once
at 620 MB. Now one document lane per process (`runDocumentJob` in
`shared/file-extractors.js`: PDF text, DOCX, each rasterized page; a
student's job ahead of background work; a stuck job given up after 150
s), the ingest's OCR on the shared worker through that lane, a
4-million-pixel ceiling per page, the refresh skipping a cached document
whose row already carries its cycle and parser version
(`cachedParseIsCurrent`), documents parsed one at a time, downloads under
a 40 MB cap and a 90 s timeout, the launcher's heap budgets (server
192/8 MB, sidecar 96/4), `[MEM]` log lines (`server/memory-watch.js`),
and College Fit waiting at most 20 s for a live read. Three OCR ingests
620 → 261 MB one at a time through the lane; ten parses 414 → 163 MB.
Found on the way: five lazy `import()` paths still named files the
folder move relocated, so the CDS read routes answered 500 and the live
CDS search failed silently from 2026-09-20 — repaired and pinned by
`tests/dynamic-imports.test.js`. The checklist's fixes: JSON bodies 1 MB
everywhere and 10 MB after the session check on the three base64 routes
(`parseLargeJsonBody`); the repository fetches go through the SSRF guard
in `security/safe-fetch.js` with each redirect hop checked; tesseract's
language data is cached under `DATA_DIR/tessdata`; the CDS read routes
log exception text instead of sending it. `CLAUDE.md` gained *Memory and
outbound requests*; `RUNBOOK.md` the memory notes.

**The reorganization (2026-09-20/21), compressed** (long form: `git show
cb499e8:SESSION-HANDOFF.md`) — `deb7baf`, `470cd2a`, `9c15000`,
`234c107`, `8b5110a`, `7fedcf1`, `1c0d96c`: App.jsx and server.js split
into hooks, screens and `server/<area>.js` modules, 108 files moved into
folders by function with the AST tools in `backend/scripts/refactor/`,
and the logout race fixed (`endSessionReauth()` in `chat/chat-client.js`).
The user chose "Both" further splits and, for Obsidian, "Leave settings
alone".

**Earlier sessions, compressed** (long form: `git show
812cdeb:SESSION-HANDOFF.md`). 2026-09-16, the tech-debt plan: CI job
timeouts and SIGKILL teardown (`957205c`), CRLF renormalized (`d120ab5`),
the refresh hold-back guard (`db883b0`), CDS PDFs out of git (`c08c12c`),
RUNBOOK and `.nvmrc` (`3e9f57f`), Express 5 / React 19 / better-sqlite3
13 / pdf-parse 2 / tesseract.js 7 / eslint 10 (`bd5650e`, `6a276b9`,
`50f5d8a`), the route families out of server.js (`5ce0056`), Sidebar,
Survey, Login and CreateAccount out of App.jsx (`697a7c0`, `dbdc6b8`),
the section reader's missed layouts (`b0c035b`). 2026-09-15/16, CDS:
College Fit reads the 2025-26 documents (`72f2509`), the workbook C7 read
and the newer-cycle guard (`ef1d56e`), the remaining CDS sections reach
the model (`40b1ee6`, `2f287de`), × close controls (`0af239e`), chat
attachments filed under Documents and the collapsible sidebar
(`dacc220`). 2026-09-13: single fetches for Course plan, calendar and
Spike Finder (`3a8fdc3`, `9ec5edc`), research output as achievement
(`0caa68e`), chat PDF uploads and four UI defects (`58b28fb`).
2026-09-11: course rigor in College Fit (`fa6c5b1`, `6a29565`,
`651f7ac`, `95f5116`). 2026-09-09: chat files read into the activities
they name (`b734c6c`), the priorities matrix reads the whole record
(`4eae5cc`), audits clean (`cd15135`, `ba07b4e`). Before that: the CDS
parser's ACT bands and GPA tables (`c33004f`), policy scout deadline
tables and the official-source gate (`c4c5bb0` and earlier).

## Verified live, and not

- **The full policy sweep after `52e9fb7` (CI run 35875601027, swap
  14:39:35–14:40:07 UTC 2026-09-23),** read through `POST
  /api/calendar/context` from throwaway accounts, all deleted (200).
  *Baseline at 14:35*, twelve tracked schools (every 25th of the seed):
  Florida State answered from the 2026-09-21 sweep's reading in 108 ms;
  Adelphi held an unstamped 2026-09-07 reading, stale, so the request
  read it live; six had no current reading and were read live by the
  request (8–15 s: Bryant, Colorado College, Illinois Wesleyan,
  Princeton, Tufts, Vermont); Miami University, Delaware and New Hampshire
  fell back to the typical dates and St. John's College - Maryland to its
  CDS. *After*: the sweep started at the first boot (earliest reading seen
  14:49:25) and reached Florida State, near the end of its order, at
  15:16:07. Of twelve schools the baseline had not touched, seven were
  read by the sweep between 14:49 and 15:13 (Bates, Lawrence,
  Northeastern, SUNY Geneseo, Maine, Rhode Island, Washington and Lee);
  Centre, Drew, Gonzaga, San Diego State and UCLA have no reading, and a
  live read failed again. The eight baseline schools read in the hour
  before the deploy kept those readings (the one-day skip), including
  Adelphi and Delaware, whose live reads finished in the background
  after the request had given up at 15 s. Not seen from outside: the
  `[policy-scout] boot: …` totals, and the Scorecard searches saved (the
  homepage reuse is pinned by tests only).
- **College Fit after `9e275cb` (and `6a5caa6`, `ad13a62`; CI runs
  35733188488, 35732317885, 35731065695; 2026-09-22):** throwaway
  accounts, deleted afterwards. The strong profile: Bradley "Highly
  competitive" 90, Indiana 93, Purdue University-Main Campus (50%) 77,
  Harvard "High reach" 6.3. The thin profile: Bradley "Highly competitive"
  75, Indiana 77, Purdue main campus "Competitive" 42.1 (admit rate used
  0.5, readiness 55.5), Harvard "High reach" 0.8, no coursework flags.
  Before `ad13a62` the strong profile read "Reach" at Bradley and Indiana;
  before `9e275cb` the 50% school was named Purdue University Northwest
  with the main campus's numbers. A 4-second Cloudflare 520 at 13:24:08
  UTC fooled the first health poll into probing before the swap; the poll
  now counts an outage of twelve seconds or more only.
- **Hardening after `03ed23f`, `5acd16b`, `db40b80` (2026-09-22):** `GET
  /api/cds/school/harvard-university` 401 without a token and 200 with one
  (it had answered 500 since 2026-09-20), `/api/cds/validation/…`
  `consistent`; a 1.1 MB JSON body to `/api/students/register` 413
  `{"error":"Request body too large."}`; a 2 MB body to
  `/api/files/extract-text` without a token 401; register, consents, sync;
  `POST /api/positioning/targets` with Indiana and Bradley (the live
  search parsed Bradley's document within the request); `POST /api/chat`
  200 with the Indiana tuition figures and a source line; a 266 KB PDF
  through `/api/files/extract-text` 200 in 1.5 s (the document lane);
  delete 200, token 401 afterwards; Bradley's re-ingested seed served with
  admit 0.7459, `consistent`.
- **2026-09-20/21 (`9c15000`, `8b5110a`, `7fedcf1`, `1c0d96c`):** the
  full probe passed after each deploy (register, consents, sync,
  positioning with Indiana and Middlebury, chat "10,622 USD; 40,369 USD;
  7,524" with `verifiedData: true`, the `/api/ec` GETs, export, delete,
  token 401); the hooks bundle `main-C4F9IWW6.js` was byte-identical to
  the local build. Chat answered 429 for a while on 2026-09-21 — OpenRouter
  passing on its upstream provider's limit, not a server fault; check the
  key's limits and credit first if students report chat failing.
- **Not verified, and why:** nothing was looked at in a browser (the
  sidebar exists only after sign-in, which a session may not do; the
  owner reported the drawer problem from a phone and should confirm the
  fix there). The administrator routes are never probed (the counselor's
  session is never used), so the backups list and download, the secrets
  status fields and the `[DISK]`/`[BOOT]`/`[MEM]` lines are covered by
  tests and CI only. Render's dashboard was not opened: the log lines
  above, the disk's *Snapshots* tab, and whether this service is linked
  to the Blueprint so the two `render.yaml` keys apply — the CI-gated
  deploy was observed in effect regardless (the red run 35722320740 for
  `9dc008a` did not reach production), and the one-instance rule follows
  from the disk (*What changed*). Production's health answer hides
  `uptime`, so the instance count cannot be read from outside either.

## Open items and things to watch

- **Two throwaway probe accounts from 2026-09-07 remain on production**
  (`probe-…@example.test`, grade 11, CA, registered around 10:29 and 10:44
  UTC that day; their deletes were lost to a restart and a connection
  timeout). Only an account's own session can delete it and no
  administrator route lists or removes student accounts, so this session
  left them; they hold a synthetic profile with no goals, so nothing
  (the scout's target list included) reads them. Removing them needs a
  counselor-side account control, which does not exist yet — the owner's
  call.
- **Tracked schools the scout cannot read.** Eight of the twenty-four
  sampled on 2026-09-23 have no reading after the full sweep and a live
  read of each failed too: Centre, Drew, Gonzaga, Miami University, San
  Diego State, St. John's College - Maryland, UCLA, New Hampshire. If that
  third holds across the list, the reason (the site not resolved from the
  name, pages the fetcher cannot use, the fetch budget) is the next thing
  to look at in `scouts/policy-scout-fetch.js`; such schools fall back to
  their CDS dates or the typical cycle, and without a snapshot each costs
  a Scorecard search every sweep. The run summary's `failures` names up to
  forty, with reasons, on `GET /api/admin/policy-scout/status`.
- **Lawrence University's reading** cites the conservatory's audition
  page (`…/conservatory/audition-requirements/`, Regular Decision
  2027-02-05); check whether the college's own deadline differs.
- Readings written on 2026-09-07 between `81e400b` and `f9a8346` carry no
  version stamp and count as stale (Adelphi at the baseline); the first
  request or sweep that reaches one re-reads it.
- **The dashboard checks left to the owner:** read the boot log for
  `[MEM] rss … (high …)` at once and hourly after, `[DISK] data … MB` and
  the first `[BATCH] cds_daily_refresh` under parser version 7 (it
  re-reads every cached document once, the scanned ones by OCR at minutes
  each, one at a time in the lane); glance at the disk's *Snapshots* tab;
  confirm the service shows *Auto-Deploy: After CI Checks Pass* and one
  instance. The server alone above about 380 MB, or a restart for memory,
  is the rollback trigger (RUNBOOK.md, *When something is wrong*).
- **Thin records at 50%-and-below schools read "Reach" or "High reach"**
  by design now (a one-course record at a 50% school with a 3.85 average:
  36). Whether that is the right verdict for a student who simply has not
  entered courses yet is a product judgment; the label is relayed
  verbatim by chat (`chat-grounding.js`).
- **Refreshing the graph and the vault:** `/graphify . --update` from the
  repository root (the AST pass takes about 20 seconds; the docs are
  cached by content hash, so only edited ones need a subagent; carry the
  community labels over from `.graphify_labels.json` by member overlap,
  name the rest), `graphify export obsidian` into `graphify-out/obsidian`,
  then move the vault's graphify-generated files (graphify frontmatter, a
  `_COMMUNITY_` prefix, `graph.canvas`, `.obsidian/graph.json`) to a dated
  folder under `Obsidian Vault archive/` and copy the new export in; never
  the six hand-written notes (`index.md`, `strategy-council.md`,
  `embedded-llm-stack.md`, `seasonal-retrieval-first.md`,
  `logseq-pii-vault.md`, `chat-graph-vault-context.md`). graphify never
  caches a JavaScript parse per file; what persists is `graph.json` +
  `manifest.json` (which `--update` builds on) and `cache/semantic/` for
  the docs. The Obsidian MCP connector on the owner's sessions is for
  reading and spot checks, not for writing thousands of notes.
- **The document lane's queue is unbounded:** a flood of scanned uploads
  waits in line instead of overflowing memory, bounded per IP by the
  30-a-minute limiters. If latency complaints appear, refuse when more
  than a few jobs are waiting.
- **The live CDS search is back on** (it had failed silently since
  2026-09-20): College Fit for a school the store lacks downloads and
  parses its document within 20 s and stores a `consistent` or `no_truth`
  record, tagged unvalidated; `[cds/live-search] ingested …` in the log;
  the store grows with what students look up. Bradley's record carries
  counts and an admit rate but no score bands, GPA or C7.
- **CDS data:** five records carry no C1 counts, 104 no C7 weights;
  Columbia, Caltech, Northwestern and UChicago are on older cycles; JHU's
  document must be fetched by hand each cycle (Cloudflare);
  `scripts/refresh-cds.mjs` fails against this machine's old local
  database, so refreshes run against a scratch database (RUNBOOK.md).
- **Next splits, if wanted:** the survey branch of App() (about 170 lines
  of step logic) needs a variant of `extract-hook.mjs` that works inside
  a block and writes `.jsx`; `server.js` still holds 250 lines of table
  setup and prepared statements that could become `server/statements.js`;
  `vectorizeECStrength` is one 459-line function and
  `orchestrateStages` in `chat-orchestrator.js` is 383; `routeDeps` is a
  flat bag of about 130 getters.
- **Cosmetic:** garbled banner comments (an old encoding accident) and a
  BOM at the top of `storage/rag-engine.js` and `storage/rag-schema.js`;
  `extract-routes.mjs` re-indented the route handlers on 2026-09-16, so a
  multi-line template literal inside a route gained two spaces per line
  (tests and live probes have passed since; `extract-helpers.mjs` does not
  re-indent).
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

## Quick verification recipes

Gates: `cd backend && npm test && npm run lint && node --check server.js`;
`cd frontend && npx vitest run && npm run build`. CI adds `npm audit
--audit-level=high` and the web-launcher build. After any move of code
between files: `node backend/scripts/refactor/undef-check.mjs <files>`,
then the gates; after `move-modules.mjs`, read its `--log` output, diff a
few moved files against `git show HEAD:<old path>`, and compare the
`assets/main-*.js` hash of `npm run build` before and after (a pure move
leaves it identical).

Live probe (Node 22+, a `.mjs` in a scratch folder, `BASE` the site): print
the account name first; register `probe-…@example.test` with grade 11, CA,
`example.edu`, `ageAttestation: true`; grant `data_processing`,
`ai_interaction`, `cross_border_transfer` through `POST /api/consent/grant`
(`grantedBy: "student"`); `POST /api/students/sync` a small profile; `POST
/api/positioning/targets` with two school names and read `yearLabel`,
`overallPositioningLabel`, `finalPositioningScore`, `readinessScore`,
`admitRateUsed`; `POST /api/chat` with a `request_id` (a UUID — the route
answers 400 without one) and a numbers-only question about a school in
the store; a GET from each `/api/ec` module; `DELETE /api/students` with
retries, then confirm the token answers 401. Since `9dc008a` also: `GET
/api/cds/school/harvard-university` with the token (200), `POST
/api/files/extract-text` with a small PDF as base64 (200, through the
document lane), a 1.1 MB JSON body to `/api/students/register` (413) and
a 2 MB body to `/api/files/extract-text` without a token (401, the body
never parsed), and a positioning request naming a school the store lacks
(the live search; read `dataProvenance`). The fuller recipe for the
chat-evidence and values paths is in the 812cdeb handoff.

Policy sweep, live: `POST /api/calendar/context` with `{ targetSchools:
[<one school>], research: false }` from a probe account. A current reading
answers in about 100 ms (an `extractedAt` newer than the boot means the
sweep read it); 10–15 s is a live read made by the request itself, which
the sweep then skips as read in the last day.

Memory scenarios, local: a `.mjs` that imports `cds/cds-pdf-parser.js` or
`shared/file-extractors.js`, samples `process.memoryUsage.rss()` from a
worker thread every 20 ms, and parses the largest documents in
`backend/tools/cds-cache/pdfs` (one, three at once, twenty-four in a row)
or runs `extractItems(path, { method: "ocr", ocrMaxPages: 4 })`; run it
with `--expose-gc`, then with the launcher's heap flags. The figures are
in `9dc008a`'s commit message.

Deploy markers: `/` carries `assets/main-*.js`; `/admin.html` carries
`assets/admin-*.js`; a backend-only deploy shows only as a brief
`/api/health` outage two to eight minutes after CI succeeds — count an
outage of twelve seconds or more as the swap, not a single failed request
(Cloudflare 520s of a few seconds happen). Refreshing the CDS cache:
RUNBOOK.md.

## Tooling notes

- The Bash tool mangles backslashes and apostrophes inside heredocs and
  `node -e` / `python -c` strings, and `cat > file <<'EOF'` heredocs lose
  a regex's `\(`; write scripts, patches and commit messages with the
  Write tool and run or `-F` them. In the PowerShell tool a here-string
  after `git commit -F -` is passed as a pathspec, not stdin: use several
  `-m` paragraphs or a message file.
- `git add -p` is unavailable, so a change set whose files overlap lands
  as one commit. Stage explicit paths; commit messages end with
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Parallel Bash calls share one working directory and a `cd` in one moves
  the others — use absolute paths. `npx vitest run` from the repository
  root finds no jsdom config and fails every test; run it from `frontend/`.
- A test that fails one run in three is a finding, not noise (the logout
  flake of 2026-09-21 was a real race). A UI test that passes alone but
  times out in the full run is queueing behind other files. jsdom has no
  `scrollIntoView` (`frontend/src/test-setup.js` shims it) and evaluates
  no media queries. `useCallback` dependency arrays evaluate at render, so
  a state variable must be declared above the callback that lists it.
  Some backend files start with a UTF-8 BOM; insert imports after line 1.
- CI watch: `gh run watch <id> --exit-status` (the backend job normally
  finishes in about 40 s; past three minutes it is hanging — cancel and
  read the partial log). A background loop on `/api/health` with the
  twelve-second rule above notifies when a deploy lands.
- graphify: the AST pass takes about 20 seconds; a subagent extracting a
  chunk of 24 files took 10–19 minutes. Its Obsidian export writes one note
  per node (about 3,000 here), so export to `graphify-out/obsidian` first
  and copy; a directory listing of the export or the vault is 370 KB —
  count, do not list. `graphify.extract.extract()` runs a process pool, so
  a script file that calls it needs an `if __name__ == "__main__":` guard
  on Windows; without one every worker dies and the serial fallback
  returned 190 nodes for files that hold 460.
