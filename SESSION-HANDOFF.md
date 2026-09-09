# Session handoff

One current document for whoever picks this repository up next — a person
or a fresh Claude session with no access to the conversation that produced
it. Read `CLAUDE.md` first: it is the edit-time harness (invariants, how to
prove a change, how to land it). This file says where things stand, what
changed recently and why, what was verified live, and what is open.

## Where things stand (2026-09-09)

- **Deployed:** `main` at `55db04d` (the last code commit is `b734c6c`),
  live at https://college-counselor-web.onrender.com. Confirmed by CI run
  34345063086 (success) and, after the restart blip that follows every
  green run, `/api/health` 200 with `/` serving `assets/main-CvQF7dpb.js`
  at 11:23 UTC on 2026-09-09. CI runs backend lint, syntax, tests and
  `npm audit --audit-level=high`, then frontend tests and build; Render
  redeploys after it passes, with a few seconds of 502s.
- **Tests (run after the last code edit, 2026-09-09 ~11:10 UTC):** backend
  `npm test` 702 tests, 697 pass, 5 skipped, 0 fail (about 40 s on a
  healthy machine); `npm run lint` 0 errors, 70 warnings (CI cap 500);
  frontend `npx vitest run` 11 files, 38 tests; `npm run build` clean.
  `npm audit` reports 0 vulnerabilities in both packages.
- **Working tree:** 38 phantom CRLF-only diffs (never stage them; a file
  whose committed blob still carries CRLF shows a whole-file diff the first
  time it has to change — `git diff --cached --ignore-cr-at-eol --stat`
  shows the real change) and two untracked files not made by any session
  (`backend/kor.traineddata`, a Tesseract Korean model; `AGENTS.md`, a copy
  of `CLAUDE.md` with "Claude" changed to "Codex").
- **Standing authorizations from the user:** push straight to `main`;
  create and delete throwaway `probe-*@example.test` accounts on
  production for live checks. Never ask for or use the counselor's
  password or a real student's.
- **Deferred by the user (2026-09-07):** the University of Wyoming College
  Fit data-source precedence — "Do not pursue until asked."
- **Dependencies:** updates inside the declared ranges were deliberately
  not taken (backend dotenv 17.4.2, eslint 9.39.5, helmet 8.3.0, mammoth
  1.12.2, pdfjs-dist 6.3.289 — the CDS parser depends on pdfjs text
  positions, so re-run `tests/cds-extras.test.js` and a spot re-parse
  first; frontend @testing-library/react 16.3.3, user-event 14.6.7,
  @vitejs/plugin-react 6.1.1, vite 8.2.2). Major jumps available, not
  taken: express 5, better-sqlite3 13, eslint 10, express-rate-limit 8,
  pdf-parse 2, tesseract.js 7, @napi-rs/canvas 1, react 19, jsdom 29,
  jest-dom 7. `npm fund` lists 57 backend and 25 frontend packages seeking
  support (express and its middleware, eslint's tree, dotenv,
  @napi-rs/canvas, express-rate-limit, pdf-parse, uuid, vite's tooling,
  vitest, parse5/entities, csstools).
- **Node on this machine:** every `npm install` here warns `EBADENGINE`
  because the packages declare Node `>=22.13.0 <23` (what CI's
  `.node-version` 22.22.0 and Render's `NODE_VERSION` run) and this machine
  runs Node 25.9 with no version manager. The tests pass on 25; the
  declaration was kept because nothing tests the project on 25.

## What changed, newest first

The user's three asks this session, verbatim, in the order they came:
"can we update eval matrix in college fit section with things created in
this session and character profiles made through EC in the profiles?
Also, I think that prestige rationale must be fixed considering the 150
character description and other features added into the machinery." —
"Also, do a package fund and fixes using the npm logs" — "Also, update the
EC sections with the chat records that are only backed up with files."
The "eval matrix" was taken to be the list under the College Fit card
(each stated value or C7 admission factor with its matches); the
"character profiles" the six-factor read of each activity; the "chat
records that are only backed up with files" the chat messages carrying an
uploaded file, whose text lived only on the message record.

**Files attached in chat are read into the activities they name
(2026-09-09)** — `b734c6c`. Chat is the only place a student uploads a
file; its text lived only in the message's encrypted `model_content` and
the vault's document list, and the EC strength read — built to consume
attachment text — never saw it (nothing in the UI reaches
`/api/ec/upload`). New `backend/ec-chat-evidence.js` parses the
"[Attached files — …]" block of a persisted turn, captures a document
block's text as the chat route inlines it (named from the client's
priming sentence), matches the activity deterministically (name words in
the student's message weigh 3, in the file name 2, in the file text 1,
the whole name verbatim +2; threshold 2, margin 1; with several files in
one turn the message counts for a file only when that file's own name or
text names the activity), stores each match as an `ec_attachments` row
(`storage_path chat://<thread>/<message>`, text sealed with the chat
history's key, deduplicated by text hash) and backfills stored threads,
reporting uploads whose text is not in their record (`nameOnly`).
`server.js`: `queueChatEvidence` runs from the message-persist route and
the chat route and recomputes the strength vectors when anything linked;
`POST /api/ec/evidence/from-chat` is the backfill; the single-EC route
marks each attachment's `origin`. The vectorizer opens sealed text through
`chat-history.js openText`. The prestige rationale separates where the
competition was recognized from where the level was read. Frontend:
`EcEvidence.jsx` (the evidence list under an expanded activity and the
"Read chat uploads into activities" button with its report), `api.js`,
`App.jsx`. Tests: `tests/ec-chat-evidence.test.js`, the route test "files
attached in chat become EC evidence", `EcEvidence.test.jsx`.

**Both audits clean, and the admin tests get the time they take
(2026-09-09)** — `cd15135`. The npm debug logs on this machine held
nothing from the project but `EBADENGINE`, so the fixes came from what
`npm audit` still reported. Backend: two moderate advisories in qs 6.15.3
under express 4.22.2 (which pins qs `~6.15.1`); body-parser already ships
qs 6.16.0, a minor within the API express 4 calls, so `package.json`
carries `"qs": "^6.16.0"` in `overrides` and `npm ls qs` shows one 6.16.0.
Frontend: `npm audit fix` took vitest 4.1.10 → 4.1.11 (the @vitest/mocker
redirect-mock path traversal; devDependencies only). That patch revives
vitest's lifecycle concurrency limit, so in a whole-suite run each test's
steps queue behind the other files': the AdminApp bootstrap test, under 3 s
alone, crossed the 5 s default on every full run; both AdminApp tests now
carry a 20 s limit like the dashboard tests.

**Backend lockfile takes the multer, xmldom and js-yaml advisory fixes
(2026-09-09)** — `ba07b4e`. CI's audit gate failed on `4eae5cc` for
reasons unrelated to it: high advisories published between the morning's
green run and that push. All three fixes sit inside the declared ranges,
so only the lockfile moved (multer 2.3.0, xmldom 0.8.15 via mammoth,
js-yaml 4.3.2 via eslint).

**The priorities matrix reads the whole record, and prestige is read from
the description (2026-09-09)** — `4eae5cc`. `college-values.js
computeFit(values, profile, options)` takes the student's strength rows
and the school's College Fit read and scores four kinds of evidence
against each value: courses (AP/IB/honors/dual now speak to "rigor"),
activities with the traits their own description yields (leadership,
character, talent, commitment, impact, major focus; the strength vector's
community proxy damped to 0.6), academics placed against the enrolled
class (GPA, class rank, every test with its sections, AP exams; a score
below the range is listed but is not a match), and priorities the profile
cannot show (essay, recommendations, interview, background, demonstrated
interest — `unreadable` with a `reason`, excluded from `overall`). Hints
match at word starts; three-letter hints stand alone ("act" never fires
inside "impact"). `server.js profileComparisonForSchool` makes the fit
calculation's reads from the stored CDS with no live fetch; the CDS
fallback keeps up to ten declared factors (six cut Stanford's character
and talent); a school whose site cannot be reached at all now falls back
to its CDS instead of "research failed". `CalibratedFitCard.jsx` lists the
evidence under each value with localized placement words. Prestige
(`competition-research.js`): the catalog is searched by the name, then
the description, awards, role and attachment text; the level is read from
everything the student wrote; the cache key carries a digest of that
evidence (a changed description is a new read, one student's "Math Team"
never explains another's); rationales are prose (competition, level,
where found, the next level and its worth, or what to write); a benchmark
hit cites the organizer's pages; source labels no longer describe web
research that no longer runs; `PrestigeCard.jsx` shows the level and the
source label it never rendered before. Tests: `tests/college-values.test.js`,
additions to the prestige, vectorizer, labels and i18n tests, the route
test "the priorities matrix and the prestige rationale read the whole
record", `CalibratedFitCard.test.jsx`, `PrestigeCard.test.jsx`.

**Earlier in this conversation (2026-09-08 to 2026-09-09, before
compaction):** `c33004f` — the CDS parser reads ACT section bands, the C9
score-range tables, the C11 GPA distribution, the C12 average and
submitted share, fixes percentages read as whole numbers and the
"between 3.75 and 3.99" band; `parserVersion` 4, store re-ingests newer
files, 30 PDF-backed records regenerated. `2e49205` — College Fit reads
sections, class rank and AP scores against the whole CDS (`compareTestsToSchool`,
`compareGpaToSchool`, `compareRankToSchool`, `compareApExams`,
`profileComparison`), shared `test-catalog.js`, grounding renders and
checks sections and class rank; the positioning cache is keyed by student
and snapshot (it had served one student's read to another). `9dbafe0` —
dashboard editors for every test, AP score and class rank; the fit card's
"How your record compares". `8469d60` — a weighted admitted average is
compared with the weighted GPA. `b7e7bba`, `52a833c` — a cut-off body
read and an empty budget-exhausted reply are retried (`llm-adapters`).
`333cfc3` — server-spawning tests wait up to a minute.

**Earlier (2026-09-07 and before):** deadline tables in the policy scout,
Columbia's official CDS, scout resilience, applicant counts on the CDS
line (`c4c5bb0` and the commits it summarizes); the official-source gate,
the model-catalog scout, crisis handling, OCR uploads, the College Fit
double-check, profile grounding.

## Verified live, and not

All checks used throwaway `probe-*@example.test` accounts on production,
each deleted afterwards (200).

- **After `b734c6c` (bundle `main-CvQF7dpb.js`, deployed 11:19 UTC):** a
  letter persisted in a thread before the activities existed waited; after
  the sync USACO read prestige 0.25. A certificate persisted as a
  text-extracted upload ("Gold Division — promoted to Gold", message "My
  USACO certificate.") lifted USACO to 0.65 within seconds, listed as
  `usaco-gold.txt` with `origin "chat"`, rationale "recognized from the
  activity's name, read at the "USACO Gold" level from an uploaded
  document …". A real chat turn with a text/plain document block named in
  the priming sentence answered in 37.7 s with `attachmentsInlined 1` and
  the award was filed to Food Bank from the turn. The backfill linked the
  early letter, skipped the stored certificate, reported no name-only
  uploads and recomputed.
- **After `cd15135` (backend-only; restart blip 10:46 UTC):** query-string
  routes through the overridden qs answered 200, including an
  array-and-nested key (`friendly[0]=1,2&a[b][c]=1`).
- **After `4eae5cc`/`ba07b4e` (bundle `main-64vLzzFp.js`, 10:13 UTC):**
  Math Team read from its description at "AIME qualifier" (benchmark,
  maa.org cited, next level USAMO 0.92); Food Bank got the what-to-write
  rationale with status 200 (it used to 404 without a cache row);
  Stanford's values matrix (from its own site, 24 s) listed activities with
  `major_focus` and `character` traits and carried `fit.academics` (GPA
  "within", rank "above", SAT with sections "within") and
  `fit.characterProfile`.
- **Earlier in this conversation:** the profile round-trip kept sections
  and class rank; Stanford's fit read carried `profileComparison`; after
  the adapter fixes eight consecutive chat turns answered (11–18 s for the
  Stanford ACT-sections question).
- **Not verified:** the fit card's matrix, the prestige card, the evidence
  list and the sync button in a real browser (vitest covers them); a real
  PDF or image through the chat picker on production (the probe and the
  route test send a text/plain document block through the same inlining
  path); the Korean strings in situ; the C7 fallback path on production
  (the route test covers it with a refused host); the weighted-average
  read live (Harvard).

## Open items and things to watch

- **Chat evidence is keyed by activity name;** renaming an activity
  orphans its evidence (the upload path's existing design;
  `linkAttachmentToEC` exists for a future re-link action). The match is
  conservative: a file whose name and text never mention the activity, in
  a turn whose message names none, is reported `unmatched`; re-attaching
  it with the activity named in the message links it. Only the answered
  turn's document block is filed on a chat turn; text-extracted uploads
  are filed when the turn is persisted, so a turn that fails moderation
  files nothing. Per-file cap 20,000 characters; the vector reads under
  the existing 15,000-character combined cap.
- **Academic rows appear mostly under C7 factors:** quoted mission values
  rarely name GPA or tests. A follow-up could list a school's C7 factors
  beside its quoted values whenever a CDS record is held.
- **Prestige rationales are English-only** (catalog level texts and the
  composed prose); source labels and friendly messages are localized.
- **Strength rows computed before `4eae5cc`** fall back to the shared
  by-name prestige cache until the next sync rewrites them.
- **The `impact` trait** is the legacy projection's blend of achievement,
  leadership and prestige (an AIME qualifier read 0.48 live); add
  `impact_and_scope` to `PROXY_TRAIT_DAMPING` in `college-values.js` if
  that reads as a stretch; lower the community damping if character rows
  look generous for captains of long-running teams.
- **The qs override** can come out once express 4 moves past qs 6.15 or
  the app moves to express 5. New advisories can fail CI on a push that
  touched no dependency — read `gh run view <id> --log-failed` before
  suspecting the code, `npm audit fix` in the package, rerun its tests (a
  patch can change runner behaviour, as vitest 4.1.11 did), commit the
  lockfile.
- **Old positioning cache rows** keyed without a student stay in the
  scorecard query cache until pruned; unreachable under the new key.
- **Parser extras are unvalidated** (the validator checks admit rate, SAT
  band, scope and B1). Cornell, Washington and Wisconsin yield no extras;
  the xlsx records (Stony Brook, Berkeley, UIUC) keep parser version 2/3.
  Georgia Tech's GPA band reads 4.0–4.0.
- **Small-tier empty replies:** the default small model is
  reasoning-capable but not on `REASONING_MODEL_PATTERNS`; the adapter
  retries once at 4,096 (`BUDGET_RETRY_MODELS`) and logs `[llm] <model>
  returned no text`. If blanks recur, add the model to the patterns or
  route COLLEGE FIT turns to the medium tier (`TIER_BY_CLASSIFICATION`).
- `normalizeTestScores` exists but the sync route stores `testScores` as
  sent; the class-rank fidelity check reads "top N%" only.
- Carried from 2026-09-07: the sixty-school scout cap, the scout's
  table-pass limits, the document-scope extractor exercised only on
  Columbia, `index.json` as a College Transitions cache, the Spanish
  duplicate page slot, the "a Early Decision II" article, SAT sections not
  read from uploaded score reports, streaming vs the post-hoc fidelity
  check, bare "Brown" not an alias, validator token lists, the
  StudentAid.gov footer.

## Quick verification recipes

Unit tests for this session's modules and their neighbours:

```bash
cd backend && node --test tests/ec-chat-evidence.test.js tests/college-values.test.js tests/competition-research.test.js tests/ec-strength-vectorizer.test.js tests/friendly-labels.test.js tests/i18n-korean.test.js tests/positioning-engine.test.js tests/chat-grounding.test.js
```

Route tests for the whole path (each spawns the server, ~1 min):

```bash
cd backend && node --test --test-name-pattern="files attached in chat become EC evidence" tests/council-naming-deadlines-routes.test.js
```

```bash
cd backend && node --test --test-name-pattern="the priorities matrix and the prestige rationale" tests/council-naming-deadlines-routes.test.js
```

Frontend: `cd frontend && npx vitest run && npm run build`. Backend
gate: `cd backend && npm run lint && npm audit --audit-level=high`.

Live probe (Node 22+, a `.mjs` in a scratch folder, `BASE` the site):
register with grade 11 / CA / example.edu, grant the three consents
(`POST /api/consent/grant` with `consentType` and `grantedBy: "student"`),
`POST /api/students/threads`, persist a user message with `attachmentName`
and a `modelContent` that carries an "[Attached files — …]" block naming
an activity's level, sync a profile with that activity, poll
`GET /api/ec/strength?friendly=1` until the count matches, then
`GET /api/ec/strength/<name>` (attachments with `origin`) and
`/prestige` (`level`, `matchedIn`, prose rationale); `POST /api/chat` with
a `document` block plus the priming sentence naming the file;
`POST /api/ec/evidence/from-chat` (linked, unmatched, skipped, nameOnly);
`POST /api/colleges/values` `{ collegeName }` (`fit.perValueCoverage[].
evidence`, `fit.academics`, `fit.characterProfile`); `DELETE /api/students`
with retries. Print the account first; a 502 during a deploy can lose the
delete.

Deploy markers: `/` carries `assets/main-*.js` (changes with anything in
the main chunk), `/admin.html` carries `assets/admin-*.js`; a backend-only
or docs-only deploy shows only as a brief `/api/health` 502 blip after CI
succeeds (Render redeploys on every green run, two to eight minutes
later).

## Tooling notes

- Bash heredocs containing single quotes fail here; write scripts and
  commit messages with the Write tool and run or `-F` them; import backend
  modules from scratch scripts with `file:///C:/…` URLs; append tests to a
  file by writing the block to a scratch file and `cat`-ing it on.
- Parallel Bash calls share one working directory and a `cd` in one moves
  the others — use absolute paths (`npm run build` in the wrong package
  reports "Missing script").
- Stage explicit paths only; commit messages end with
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Foreground `sleep` is discouraged but a bounded foreground loop with
  `sleep 10` worked for a deploy wait; a background Bash `until` loop
  notifies on completion (CI watch: `gh run watch <id> --exit-status`).
- The route-test file shares one server and database across its tests; a
  state leak between students shows up only in the full run.
- A UI test that passes alone but times out at 5 s in the full
  `npx vitest run` is queueing behind other files (vitest 4.1.11), not
  hanging: give it the time it takes (`it(name, fn, 20_000)`).
- Overnight on 2026-09-09 every process launch on this machine took
  seconds and the server-spawning tests timed out; the health waits are
  now a minute. If `npm test` fails only with "Timed out waiting for
  route-test server", time `node -e 1` before suspecting the code.
- jsdom has no `scrollIntoView`; `frontend/src/test-setup.js` shims it.
