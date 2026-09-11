# Session handoff

One current document for whoever picks this repository up next — a person
or a fresh Claude session with no access to the conversation that produced
it. Read `CLAUDE.md` first: it is the edit-time harness (invariants, how to
prove a change, how to land it). This file says where things stand, what
changed recently and why, what was verified live, and what is open.

## Where things stand (2026-09-11)

- **Deployed:** `main` at `95f5116`, live at
  https://college-counselor-web.onrender.com. Confirmed by CI run
  34603951260 (success) and the backend-only redeploy blip (`/api/health`
  non-200, then 200 at 13:24 UTC on 2026-09-11), then by behavior (the
  probe below). Earlier the same day: `651f7ac` (backend-only, CI run
  34602871341, blip 13:12 UTC), `6a29565` (bundle `main-CEBZ2mnd.js`, CI
  run 34601700790), `fa6c5b1` (bundle `main-bsyCx_FV.js`, CI run
  34571763935). `/` still serves `assets/main-CEBZ2mnd.js`. CI runs
  backend lint, syntax, tests and `npm audit --audit-level=high`, then
  frontend tests and build; Render redeploys after it passes, with a few
  seconds of 502s.
- **Tests:** backend `npm test` 708 tests, 703 pass, 5 skipped, 0 fail
  (run locally after `651f7ac`'s edits; CI ran it green for `95f5116`,
  whose one-line hint change was covered locally by the college-values,
  course-rigor and positioning-engine files, 34 tests); `npm run lint` 0
  errors, 70 warnings (CI cap 500); frontend `npx vitest run` 12 files,
  43 tests; `npm run build` clean.
- **Working tree:** 37 phantom CRLF-only diffs (never stage them; a file
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

The user's asks on 2026-09-11, verbatim, in order: "We got some problems
such as AP scores and the amount of APs taken are not considered as
course rigor in the college fit machine. Also, college fit section having
korean language in it is a problem." — "Also count honors courses as half
a unit in rigor and I think that in college fit should call in updated
parts of the profile when the profile gets updated." — "Also align the
rigor units between the matrix and the comparison read" — "Also, the
suggest ECs for me getting blocked by the rules engine."

**The course-load line speaks to intellectual curiosity (2026-09-11)** —
`95f5116`. Under a school's quoted values each AP course evidenced
"intellectual curiosity" through `TYPE_VALUE_HINTS` while the one-line
load did not, so Stanford's re-extracted values (no theme names rigor,
challenge or curriculum) listed the AP courses and nothing about the
load. `ACADEMIC_VALUE_HINTS.rigor` now carries "intellectual curiosity".

**"Suggest ECs for me": no block found (2026-09-11, no code change).**
The chip (`App.jsx`, the quick-action row under the composer) puts
"Suggest ECs for me" in the composer; on send the client's quick-query
handler ignores it (every pattern is anchored to whole profile lookups),
the quick keyword router sends it straight to the EC specialist
(`EC_KW` matches "ECs"; the essay-keyword test does not fire, so the
small-model gatekeeper never runs), and the specialist call reaches
`/api/chat` wrapped in the `<student_message>` envelope. Server-side, that
exact wrapped text passes `screenInput`, classifies as coaching /
`ec_strategy`, is not a lookup, and `enforceGates` allows it with the
coaching label only. Two live probes on 2026-09-11 (throwaway accounts,
the client's EC system prompt and envelope verbatim) answered 200 in
27 s with a profile and 20 s without one: full coaching replies,
`profileFidelity null`, no fidelity footnote, no block. The Strategy
Council runs only when the student picks a decision type, and the EC
ideas generator (`/api/ec/ideas/generate`) has no deterministic filter.
The one deterministic "engine" the code names is the quick-query handler
(`maybeHandleQuickQuery`), which answers "my ecs" / "my activities" with
the saved list and nothing else. What the student actually saw is not
known; see the open item.

**The rigor units are one number everywhere (2026-09-11)** — `651f7ac`.
The matrix's "Course rigor" detail carried `readCourseRigor` units while
`compareCourseRigor` added half a unit per senior-year college-level
course on top (4.3 against 4.8 for the same record). The senior credit
now lives in `course-rigor.js` (`SENIOR_YEAR_CREDIT` 0.5, applied inside
`readCourseRigor`), the engine uses `units` as is, and the matrix detail
takes the College Fit read's copy when one is supplied. No score moved:
the engine's load was already that sum. `college-values.test.js` builds
the comparison from the engine and checks the two agree with and without
the read.

**Honors carry half a unit, and the fit card re-reads the school when the
profile changes (2026-09-11)** — `6a29565`. `course-rigor.js` weighs an
honors course at `HONORS_WEIGHT` 0.5 (counted, not college-level, so
`collegeLevelCourses` and the senior half-unit exclude it); the
comparison block's "Course rigor" row now shows an honors-only load. The
card kept the read it was opened with until the student searched the
school again. New `frontend/src/fit-refresh.js` fingerprints what the fit
reads (GPA, class rank, courses, AP and test scores, activities, major);
`lookupCollege` in `App.jsx` records the fingerprint the shown read was
taken from, and the auto-sync effect calls `refreshCollegeFit(data)` once
the sync has landed, which re-reads the shown school through
`lookupCollege(name, undefined, { refresh: true })` only when the
fingerprint moved (chat memory, notes and documents never trigger it); an
`evidenceVersion` bump (chat uploads read into activities) re-reads it
too. A refresh keeps the old card and positioning until the new read
lands, keeps them on a failed re-read, and stamps the body with
`refreshedAt`, which the card renders as "Re-read after your profile
changed · HH:MM" (`fit.refreshed`, both languages). The server needs
nothing: every sync writes a snapshot and the positioning cache is keyed
by it, and the values fit is computed per request. Tests:
`fit-refresh.test.js`, `course-rigor.test.js`, `CalibratedFitCard.test.jsx`.

**College Fit reads AP exams and their scores as course rigor, and the
fit card speaks the app's language (2026-09-11)** — `fa6c5b1`. The rigor
component of the admissibility read counted only courses typed AP, IB or
dual enrollment: AP work recorded as exam results, or an "AP Calculus BC"
left typed regular, was no rigor at all, and AP scores only ever fed the
separate six-percent exam component. New `backend/course-rigor.js` reads
a course's level from its type or its name (`courseLevel`), counts an AP
exam whose subject no listed course names as an AP taken, and weighs each
AP by its exam score (5 → 1.2 units, 4 → 1.1, 3 → 1, 2 → 0.8, 1 → 0.6,
unscored 1) — `readCourseRigor`. `positioning-engine.js buildStudentModel`
builds the load from it; `compareCourseRigor(student, averageGpa)` places
the load (plus half a unit per senior-year college-level course) against
the expectation the engine already used (about `(average − 3.2) × 10`,
never under four; meeting it reads "above", sixty percent "within") and
returns it in `reads.rigor`, so `buildProfileComparison` carries a `rigor`
block (`apTaken`, `apCourses`, `apExamsWithoutCourse`, `apScored`, `ib`,
`dualEnrollment`, `aLevel`, `honors`, `units`, `expectation`, `position`,
`score`); `server.js profileComparisonForSchool` computes the same read
for the matrix. `college-values.js` adds one "Course rigor: 4 AP (3 with
exam scores)" academic evidence line (kind `rigor`, hints rigor /
advanced placement / college-level / course load / curriculum / honors),
reads course levels by name, and lists academic reads before courses and
activities (the tone sort still decides among unequal tones). The EC
vectorizer's AP-course detection uses `courseLevel` too. The Korean text:
`lookupCollege` in `App.jsx` sent no locale on the values and positioning
calls, `resolveLocale` fell back to the browser's Accept-Language (Korean
on this machine), and `CalibratedFitCard` took its language from the
values body. Both calls now send `X-CollegeApp-Locale`, the `locale`
state is declared ahead of them, and the card takes `locale` as a prop
with the body's locale as fallback. The comparison block gets a
"Course rigor" row and the matrix line renders "about N college-level
courses expected here · at or above that load / close to it / below it"
(`fit.cmp_rigor*`, `fit.rigor_*` keys in both languages). Tests:
`tests/course-rigor.test.js`, additions to `positioning-engine.test.js`,
`college-values.test.js`, `CalibratedFitCard.test.jsx`.

**Session of 2026-09-09.** The user's three asks, verbatim, in the order they came:
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

- **After `95f5116` (backend-only; blip 13:24 UTC 2026-09-11):** a grade-12
  profile with "AP Calculus BC" typed regular (exam 5), "AP Physics C"
  typed ap in senior year, "Honors Spanish 4", and an unmatched Computer
  Science A exam (4). Positioning for Stanford reported `rigor.units 4.3`
  (1.2 + 1 + 0.5 senior + 0.5 honors + 1.1), `expectation 7`, "within",
  score 61.4; the values matrix carried "Course rigor: 3 AP (2 with exam
  scores), 1 honors" under Stanford's "Intellectual Curiosity" theme with
  `detail.units 4.3` — the same number. The same probe after `651f7ac`
  (blip 13:12 UTC) showed the positioning units at 4.3 but no load line,
  because Stanford's re-extracted values carry no rigor hint; `95f5116`
  fixed that. Accounts deleted (200).
- **After `6a29565` (bundle `main-CEBZ2mnd.js`, 13:00 UTC 2026-09-11):**
  the `fa6c5b1` profile below plus "Honors English 11" typed honors and
  "Honors Precalculus" typed regular. `POST /api/positioning/targets` for
  Stanford answered in 0.2 s with `profileComparison.rigor` `{honors 2,
  units 5.8, expectation 7, position "within", score 82.9}` (68.6 without
  the honors halves); the values call with the app header returned
  `locale "en-US"`. Account deleted (200).
- **After `fa6c5b1` (bundle `main-bsyCx_FV.js`, 06:54 UTC 2026-09-11):**
  a profile with "AP Calculus BC" (junior) and "AP Chemistry" (senior)
  both typed regular, and exams Calculus BC 5, Computer Science A 4,
  Biology 3. `POST /api/positioning/targets` for Stanford answered in
  0.9 s with `profileComparison.rigor` `{apTaken 4, apCourses 2,
  apExamsWithoutCourse 2, apScored 3, units 4.8, expectation 7, position
  "within", score 68.6}` and `featureBreakdown.courseRigor 68.6` (the
  old read would have been 0). `POST /api/colleges/values` with
  `Accept-Language: ko-KR` and no app header returned `locale "ko"` (the
  cause, still the server's fallback); with `X-CollegeApp-Locale: en-US`
  it returned `en-US`. Stanford's values came from its own site (not C7),
  and the "Collaborative Innovation" row carried the AP exams line, both
  courses labeled "(AP)", and "Course rigor: 4 AP (3 with exam scores)"
  at "within" against 7. Both probe accounts deleted (200).
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
- **Not verified:** the fit card re-reading a school after a profile
  edit, in a real browser (it needs a logged-in UI session; vitest pins
  the fingerprint helper and the card's "Re-read after your profile
  changed" note, not the effect in `App.jsx`) — the user should edit a
  course with a school shown and watch the note appear; the fit card in a
  real browser with the Korean Windows locale (vitest pins the locale
  prop; the API check above pins the header), so the Korean-in-English
  report should be re-checked in the UI; the "Course rigor" row under a
  C7 fallback school on production (the unit tests cover the "Rigor of
  Secondary School Record" row; live it was seen under a quoted value);
  what the student sees when "Suggest ECs for me" is "blocked" (the API
  path answered twice; the browser path was not exercised); the fit
  card's matrix, the prestige
  card, the evidence list and the sync button in a real browser; a real
  PDF or image through the chat picker on production; the
  weighted-average read live (Harvard).

## Open items and things to watch

- **"Suggest ECs for me" reported as blocked, not reproduced.** Every
  deterministic layer passes it and two production turns answered in
  full (see the change log). Things that could still produce a block or
  a blank in a real session, none confirmed: a burst of sends inside ten
  seconds (the client's burst guard says "Three messages in 10 seconds —
  give it a beat"); a month's AI budget spent (402, shown as "Something
  went wrong while answering that"); a model reply made only of pseudo
  tool-call text, which the output screen strips to an empty answer (the
  client then runs the validator on an empty draft and shows only the
  "could not be fully verified" note); a specialist refusal phrased
  "outside my role", which the refusal-recovery pattern does not match
  (it catches "outside my scope/domain" and "unrelated to your goals").
  The next step is the exact text the student saw and the entry in the
  counselor's audit log for that turn (`input_blocked`,
  `off_topic_blocked`, `essay_blocked`, `validation_failed`, or nothing).
- **The rigor units figure is not rendered anywhere yet:** both reads
  carry the same `units` now, but the card shows only the load
  description, the expectation and the position. Showing the number
  ("4.3 of about 7") is a one-line change in `CalibratedFitCard.jsx`.
- **The fit refresh is wired but not unit-tested end to end:** the
  fingerprint helper and the card's note are pinned; the effect in
  `App.jsx` (sync lands → `refreshCollegeFit`) is not, and it runs only
  while the sync effect runs (chat or survey screen, a saved passphrase).
  Strength vectors are recomputed after the sync response, so a re-read
  fired right after a sync can sharpen activity traits from the previous
  vectors; the lexical read of each description is always current. A
  second refresh happens when chat evidence is read in.
- **The rigor expectation is a GPA proxy** (the admitted average on the
  4.0 scale), not a read of the school's own course-count statistics; a
  CDS carries none.
- **The server still guesses locale from Accept-Language** when no app
  header arrives; other plain `fetch` calls in `App.jsx` (the verify
  call, the cache-clear button) do not send the header. Their bodies are
  not localized today, but a new localized field on one of them would
  bring the Korean text back — send `X-CollegeApp-Locale` or use
  `api.js ccFetch`, which always does.
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
cd backend && node --test tests/course-rigor.test.js tests/positioning-engine.test.js tests/college-values.test.js tests/ec-vectorizer.test.js tests/ec-chat-evidence.test.js tests/competition-research.test.js tests/chat-grounding.test.js
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
`POST /api/students/sync` with `profile.courses` named "AP …" or
"Honors …" but typed regular and `profile.apScores` naming subjects no
course lists, then
`POST /api/positioning/targets` `{ targets: [{ schoolName }], major }` and
read `targets[0].profileComparison.rigor`; `POST /api/colleges/values`
once with `Accept-Language: ko-KR` and no `X-CollegeApp-Locale` (expect
`locale "ko"`) and once with the header `en-US` (expect `en-US`, and a
`fit.perValueCoverage[].evidence` entry of kind `rigor`). For the chat
evidence path: `POST /api/students/threads`, persist a user message with `attachmentName`
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
- `grep -rP` with a `\x{AC00}` class fails here ("character value too
  large") and a recursive grep over `backend/` walks node_modules for
  minutes; use the Grep tool with a literal `[가-힣]` class instead.
- Some backend files (`ec-vectorizer.js`) start with a UTF-8 BOM; insert
  imports after line 1, not before it.
- `useCallback` dependency arrays evaluate at render, so a state variable
  must be declared above the callback that lists it (`locale` was moved
  ahead of `lookupCollege` for this reason).
