# Session handoff

One current document for whoever picks this repository up next — a person
or a fresh Claude session with no access to the conversation that produced
it. Read `CLAUDE.md` first: it is the edit-time harness (invariants, how to
prove a change, how to land it). This file says where things stand, what
changed recently and why, what was verified live, and what is open.

## Where things stand (2026-09-09)

- **Deployed:** `main` at `333cfc3` (this session's seven commits:
  `c33004f`, `2e49205`, `9dbafe0`, `8469d60`, `b7e7bba`, `52a833c`,
  `333cfc3`, then the handoff commit), live at
  https://college-counselor-web.onrender.com. Every push
  to `main` runs CI (backend lint, syntax, tests; frontend tests and build)
  and Render redeploys after it passes; each deploy restarts the process (a
  few seconds of 502s). The student bundle changed twice this session
  (`main-bGb17sj1.js`, then `main-ENyTRcx7.js`).
- **Tests:** backend `npm test` 682 tests, 677 pass, 5 skipped, 0 fail
  (the last full local run took eight minutes on the slow machine noted
  under *Tooling*; CI is the gate);
  `npm run lint` 0 errors, 70 warnings (CI cap 500); frontend `npx vitest
  run` 9 files, 31 tests; `npm run build` clean.
- **Working tree:** clean apart from the repository's phantom CRLF-only
  diffs (never stage them) and two untracked files not made by any session
  (`backend/kor.traineddata`, a Tesseract Korean model; `AGENTS.md`, a copy
  of `CLAUDE.md` with "Claude" changed to "Codex"). Two files that had CRLF
  in the working tree, `backend/cds-pdf-parser.js` and
  `frontend/src/components/CalibratedFitCard.jsx`, were normalized to LF
  because they had to change.
- **Standing authorizations from the user:** push straight to `main`; create
  and delete throwaway student accounts on production for live checks.
  Never ask for or use the counselor's password or a real student's.
- **Deferred by the user (2026-09-07):** the University of Wyoming College
  Fit data-source precedence. Do not pursue until asked.

## What changed, newest first

The user's ask for this session, verbatim: "make sure that in college fit,
other sections of the CDS is used and the profile of the student like for
standardized tests and GPA. Also, make sure to allow subscores in
standardized tests and other things, and allow edits for all standardized
tests in the dashboard page. Also, allow edits of AP scores in the
dashboard page." Everything below is that ask, plus the four bugs it
surfaced (a cross-student fit cache, a weighted average read as
unweighted, and two ways a model reply came back empty).

**Server-spawning tests wait up to a minute (2026-09-09)** — `333cfc3`.
The five test files that spawn `server.js` gave it 8–20 s to answer
`/api/health`; on the machine described under *Tooling* a boot took 56 s
and the suite reported 31 timeouts that were nothing but the wait
expiring. The `waitForHealth`/`waitFor`/`waitForUrl` loops now allow a
minute and the launcher test's own limit is 90 s. Nothing changes on a
healthy machine: the loops return at the first healthy reply.

**An empty reply that exhausted its budget is retried with room to answer
(2026-09-09)** — `52a833c`, `backend/llm-adapters/openai.js` and
`index.js`. After the cut-off fix deployed, one College Fit turn still
came back as the composer's fallback after 15.7 s — not a timeout. The
wire adapter took only a string `content` (an array of parts translated
to nothing) and treated an empty reply as an answer; the small tier's
default model is reasoning-capable but not on the reasoning list, so at
the chat's 1,024-token budget it can spend everything thinking and return
empty content with `finish_reason: "length"`. The adapter joins array
content, reports `reasoning_tokens`/`had_reasoning`, makes one follow-up
at 4,096 tokens within the same attempt when the reply is empty and the
budget was exhausted or reasoning was present (result marked
`budget_retry`, a `[llm] … returned no text` warning in the log), and
starts that model at 4,096 for the rest of the process. Pinned in
`tests/llm-adapters.test.js`.

**A cut-off model attempt is retried, not returned blank (2026-09-08)** —
`b7e7bba`, `backend/llm-adapters/openai.js` and `index.js`. Live College Fit chat turns
kept answering "There is not enough information to produce a specific
suggestion." after exactly 40 s on the small tier (`_meta.timings.model`
40001, `profileFidelity: null`). OpenRouter sends headers first and the
body when generation ends; the attempt budget's abort landed inside
`response.json()`, was swallowed as "no JSON", and came back as an empty
200, so the adapter's retry on a fresh connection never ran. The body read
now throws the aborted error, so the retry happens. The attempt split was
also backwards for chat: `maxTokens <= 1024` counted the chat turn's
default budget as a quick call (40 s first attempt); it is now `< 1024`,
so chat gets the 60 s first attempt and client utility calls (24, 700
tokens) stay quick. Pinned in `tests/llm-adapters.test.js`. This is the
"not enough information" reply the 2026-09-07 handoff could not reproduce.

**A weighted admitted average is read against the weighted GPA
(2026-09-08)** — `8469d60`, `positioning-engine.js compareGpaToSchool`. Harvard's CDS
reports a 4.21 average; read against an unweighted 4.0 it made a perfect
record "below average" and asked for ten AP courses. An average above 4.0
is compared with the student's weighted GPA (or with 4.0 when none is
recorded), the rigor expectation stays on the 4.0 scale, the read carries
`averageScale` and `comparedGpa`, the card shows "(weighted)", and the
VERIFIED DATA line says "(weighted scale)".

**Dashboard editing and the fit card (2026-09-08)** — `9dbafe0`.
`frontend/src/App.jsx`: every test card opens an inline editor
(`TestScoreEditor`: test type, total, every section the catalog defines,
date, subject; Save / Cancel / Remove; a pencil button for anyone a
double-click does not suit) and "+ Add test score" adds one; the AP list
has the same (`ApScoreEditor`: exam, score, year) with "+ Add AP score";
class rank sits under the GPA with `ClassRankEditor` (rank + class size,
or top %). The survey's test step takes sections for every test through
`sectionDefs`/`withSection` (the total derives once every counting section
is filled: SAT/PSAT sum, ACT rounded mean, TOEFL sum, IELTS nearest half
band), and its GPA step takes the class rank. The login-recover and
reconcile merges carry `classRank`. `CalibratedFitCard.jsx` renders
`positioning.profileComparison` as "How your record compares" (test read
with each section against its band, placement in the score-range table,
test-optional advice, GPA against average/band/distribution, class rank
against the top-tenth share, AP evidence); strings in `i18n.js` (en + ko).
Tests: `CalibratedFitCard.test.jsx`, `App.dashboard.test.jsx` (signs in
with a populated backend profile, edits an ACT section, rejects an
out-of-range one, adds an SAT, edits/adds/removes AP scores, records a
class rank, checks each synced profile); `test-setup.js` shims
`scrollIntoView` for jsdom.

**College Fit reads the whole record against the whole document
(2026-09-08)** — `2e49205`. `backend/positioning-engine.js`:
`compareTestsToSchool` (SAT and ACT both scored, the stronger read;
concordance `actToSat`/`satToAct` when the school reports only the other
band; sections against section bands with the section part half mean,
half weakest; placement in the score-range table; test-optional: a score
under the 25th percentile is "withhold" — counts no worse than no score
and the test weight drops to 0), `compareGpaToSchool` (average + C11 band
+ C11 distribution, 60/40 formula/distribution), `compareRankToSchool`
(student's top share against C10 shares), `compareApExams` (new 0.06
component only when the student has exam results, weighted toward exams
in the intended field); red flags for a Math section under the 25th
percentile for a quantitative major and for field AP scores under 3;
`profileComparison` on every positioning result. `buildStudentModel`
reads `ap_scores_json`/`apScores` and `class_rank_json`/`classRank`.
New `backend/test-catalog.js` (mirrored by `frontend/src/test-scores.js`,
pinned together by `tests/test-catalog.test.js`): every test's range,
sections and derivation rule, `validateTestEntry`, `normalizeTestScores`,
`normalizeClassRank`. `chat-grounding.js`: the profile block renders every
test's sections and "Class rank: top 3% (12 of 400)"; the fidelity check
compares a stated ACT subscore with the recorded sections (not the
composite) and flags a class-rank claim of better standing than recorded;
the VERIFIED DATA block renders ACT section bands, score-range shares, the
GPA distribution, the GPA band and submitted shares. `rag-engine.js`:
`profile_snapshots.class_rank_json` (migration on boot;
`setSnapshotClassRank` runs after the unchanged twelve-value insert).
`server.js`: all three `buildStudentModel` call sites pass AP scores and
class rank; the three profile loaders return `classRank`. Route test in
`council-naming-deadlines-routes.test.js` ("subscores, AP scores and class
rank reach the profile, the College Fit read and the counselor").
**Bug found by that test:** the positioning cache was keyed by targets and
major only, so a second student asking about the same school and major
was served the first student's read; the key now includes `studentId` and
the snapshot id, so a profile edit recomputes.

**The wider Common Data Set read (2026-09-08)** — `c33004f`.
`cds-pdf-parser.js extractExtras` reads ACT English/Math/Reading/Science
bands (`extras.actSections`, with `p50` when three numbers are printed —
`satSections` gained `p50` too), the C9 score-range tables
(`extras.scoreDistribution.{satComposite, satSections, actComposite,
actSections}`, read column by column from header x-positions via
`extractScoreDistributions`, so Columbia's blank composite cell in "24-29
2% 7% 1% 3%" cannot shift values), the C11 GPA distribution
(`extras.gpaDistribution`, last column when three are filled, a truncated
"between 3.75" label handled), the C12 average and submitted share
(`extras.gpa`), and `classRank.topHalfPct`/`submittedPct`. Two old bugs:
percentages were read as whole numbers ("97.8%" → 8, Stanford's top-tenth
share was 8 and its SAT submit rate 3 — now decimals), and the text-scan
GPA extractors expected "3.75-3.99" where the form says "between 3.75 and
3.99", so no cached record had a GPA band. `parserVersion` is 4;
`cds-store.js ensureCdsStoreSeeded` re-ingests a parsed file whose version
is newer than the row's; `cdsRecordToPositioningResult` carries
`gpaBand`, `satSections`, `actSections`, `scoreDistribution`,
`gpaDistribution`, `classRank`, `submitting` into `parsed`. All 30 PDF-
backed parsed records were regenerated with only `extras`, `enrolledGPA`
and `parserVersion` replaced (validated numbers untouched); the three
xlsx-backed ones (Stony Brook, Berkeley, UIUC) were not.

**Earlier (2026-09-07 and before)** — deadline tables in the policy scout,
Columbia's official CDS, scout resilience, applicant counts on the CDS
line (`c4c5bb0` and the commits it summarizes); the official-source gate,
the model-catalog scout, crisis handling, OCR uploads, the College Fit
double-check, profile grounding.

## Verified live, and not

All checks used throwaway `probe-*@example.test` accounts on production,
deleted afterwards (each delete returned 200).

- **After `9dbafe0` (bundle `main-bGb17sj1.js`, ~21:00 UTC):** sync of a
  profile with SAT 1520 (740/780), ACT 33 (35/31/34/32), AP 5 and 4,
  class rank 12 of 400 → `GET /api/students/profile` returned
  `classRank {topPercent 3, rank 12, size 400}` and the ACT sections;
  `POST /api/positioning/targets` for Stanford (searchCds false) returned
  `profileComparison` with the SAT read "within" 1510–1580, both sections
  against Stanford's 740–780 / 770–800 bands, the ACT as the weaker
  alternative (33 vs 34–36), placement "1400–1600, 97.3% of submitters",
  GPA 3.9 in the 3.75–3.99 band with 73.3% above, class rank top10 against
  97.8%, AP count 2, advice "submit"; provenance `cds_store`, validated —
  so the boot re-ingest of the parser-4 records reached production. Label
  "High reach 20.5" (the probe's profile had two courses and no narrative;
  three pre-existing red flags).
- **Chat, before the adapter fixes:** the College Fit question about ACT
  sections and class rank at Stanford answered fully on the small tier in
  36 s, citing "Stanford University Common Data Set 2024 (validated
  against ground truth)" with a section-by-section table; a plain coaching
  question answered on the medium tier in 17 s and quoted the AP score
  correctly. Two shorter fit questions came back as the composer's
  fallback sentence at exactly 40.0 s (the cut-off body read).
- **Chat, after `b7e7bba` (bundle `main-ENyTRcx7.js`, 03:22 UTC on
  2026-09-09):** the plain question 17 s; "Should I submit my SAT to
  Stanford?" answered in 18 s ("Stanford requires test scores… your SAT is
  clearly the right one", citing the scouted policy line); the Knox
  College question (no CDS, no baseline) answered honestly in 26 s: no
  verified data, then the student's own SAT and ACT sections listed. The
  Stanford ACT-sections question came back blank after 15.7 s — not a
  timeout: the small tier's model returned empty content, the second
  adapter fix.
- **Chat, after `52a833c`/`333cfc3` (backend-only deploy, restart seen
  at 06:28 UTC on 2026-09-09), two probes of four turns each, eight
  answers, no blanks:** the Stanford ACT-sections question answered in
  11.2 s and 18.2 s with a section table quoting "English 35–36, Math
  33–36, Reading 34–36, Science 33–36 [Source: Stanford University Common
  Data Set 2024]"; "Should I submit my SAT to Stanford?" answered in 56 s
  once (the empty-reply follow-up at 4,096 tokens inside the same
  attempt) and 16.4 s the next time (the learned floor); the Knox College
  question answered in 5.3–8.7 s pointing at Knox's own CDS and IPEDS;
  the plain coaching question 16.5–17.9 s on the medium tier. Every
  probe account deleted (200).
- **Not verified:** the dashboard editors and the fit card in a real
  browser (vitest covers them); the Korean strings in situ; the
  `class_rank_json` migration on the populated production database beyond
  the profile round-trip above (it worked); the weighted-average read
  live (Harvard); `GET /api/cds/school/<slug>` does not expose `extras` or
  `parserVersion` (it returns a canonical shape), so the fit read is the
  way to see the wider data on production.

## Open items and things to watch

- **Old positioning cache rows** keyed without a student remain in the
  scorecard query cache until pruned; they are unreachable under the new
  key. Every student's first fit read after the deploy recomputes.
- **Rows regenerated by the parser** are unvalidated extras (the validator
  checks admit rate, SAT band, scope and B1 only). Spot checks: Columbia
  (blank C11 → no GPA), Stanford, Harvard (4.21 weighted average), Boston
  University (truncated label), Florida, Yale (no ACT table) read right.
  Cornell, Washington and Wisconsin still yield no extras (pdfjs finds
  nothing usable); the xlsx records keep parser version 2/3 and no
  sections — running `cds-xlsx-parser.js` through the same regeneration
  would fill them, since the C11/C12 text-scan fixes apply to it too.
- **Georgia Tech's GPA band reads 4.0–4.0** (more than 75% of the class
  at 4.0); `cdsLine` prints "25th and 75th percentile both in the 4 band".
- **Small-tier latency and empty replies.** A College Fit turn on the
  small tier takes 16–45 s; the medium tier answers in ~17 s. The default
  small model (`google/gemma-4-26b-a4b-it`, `llm-adapters/tier-defaults.js`)
  is reasoning-capable but not on `REASONING_MODEL_PATTERNS`, so at the
  chat's 1,024-token budget it can return empty content with
  `finish_reason: "length"`; the adapter now retries once at 4,096 and
  remembers the floor per process (`BUDGET_RETRY_MODELS` in
  `llm-adapters/index.js`), and logs `[llm] <model> returned no text`.
  If blanks still appear, read that log line, add the model to the
  reasoning patterns (floor 8,192), or route COLLEGE FIT turns to the
  medium tier (`TIER_BY_CLASSIFICATION` in the chat route).
- The `normalizeTestScores` helper exists but the sync route still stores
  `profile.testScores` as sent; the client validates before saving. Wiring
  it in would drop malformed entries from older builds silently — decide
  deliberately.
- The class-rank fidelity check flags only "top N%" claims of better
  standing than recorded; "top tenth" wording is not checked.
- Items carried from 2026-09-07: the sixty-school scout cap
  (`POLICY_SCOUT_MAX_SCHOOLS`), the table-pass limits in the scout, the
  document-scope extractor exercised only on Columbia, `index.json` as a
  cache of College Transitions' index, the Spanish duplicate page slot,
  the "a Early Decision II" article, SAT sections not read from uploaded
  score reports, streaming vs the post-hoc fidelity check, bare "Brown"
  not an alias, validator token lists, the StudentAid.gov footer.

## Quick verification recipes

Engine, grounding, catalog, parser, store and adapter:

```bash
cd backend && node --test tests/positioning-engine.test.js tests/chat-grounding.test.js tests/test-catalog.test.js tests/cds-extras.test.js tests/cds-store.test.js tests/llm-adapters.test.js
```

Route test for the whole path (spawns the server, ~1 min):

```bash
cd backend && node --test --test-name-pattern="subscores, AP scores and class rank" tests/council-naming-deadlines-routes.test.js
```

Frontend: `cd frontend && npx vitest run && npm run build`.

Re-parse one cached CDS PDF and print the wider read: from a scratch
folder, a `.mjs` that imports `parseCDSPositional` from
`file:///…/backend/cds-pdf-parser.js` (Windows needs the `file://` form),
calls it on `backend/tools/cds-cache/pdfs/<slug>.<year>.pdf` with
`{ method: "auto" }`, and prints `enrolledGPA` and `extras`. To regenerate
the parsed records after a parser change, spread the existing JSON, replace
only `extras`, `enrolledGPA` and `parserVersion`, keep the 2-space indent
and trailing newline, and review `git diff` of the previously existing
values (this session's regeneration changed only the decimal-bug values).

Live probe with a throwaway account (Node 22, `BASE` is the site): register
with grade 11 / CA / example.edu, grant the three consents, sync a profile
with `classRank: { rank, size }`, SAT and ACT `sections`, and `apScores`;
then `GET /api/students/profile` (expect `classRank` and `sections` back),
`POST /api/positioning/targets` `{ targets: [{ schoolName: "Stanford
University" }], major: "Computer Science", searchCds: false }` (expect
`targets[0].profileComparison`), a `POST /api/chat` with the COLLEGE FIT
system prompt asking how the ACT sections compare at Stanford (expect a
cited section table, `_meta.timings.model` well under 60 s), and `DELETE
/api/students` with retries. Print the account first; a 502 during a
deploy can lose the delete.

Deploy markers: `/` carries `assets/main-*.js` (changes only with
`App.jsx`), `/admin.html` carries `assets/admin-*.js`; a backend-only
deploy shows only as a brief `/api/health` blip after CI succeeds. The
boot log line `[cds-store] re-ingesting N parsed CDS record(s) from a
newer parser version` is the parser-4 top-up.

## Tooling notes for a Claude session on this machine

- Bash heredocs containing single quotes fail here; write node scripts and
  commit messages with the Write tool and run or `-F` them. Import backend
  modules from scratch scripts with `file:///C:/…` URLs.
- Stage explicit paths only; commit messages end with
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Foreground `sleep` is blocked; a background Bash loop with `sleep` (CI
  watch over `gh run list`, a deploy-marker wait that then runs the probe)
  works and notifies on completion.
- The route-test file shares one server and database across its tests;
  a cache or state leak between students shows up only in the full run,
  never when a test runs alone (`--test-name-pattern`).
- Overnight on 2026-09-09 every process launch on this machine took
  seconds (`node -e 1` 2–15 s, `cmd /c echo` 11 s, CPU idle, memory
  free; even a PowerShell counter sample timed out), so a server boot took
  56 s and the five server-spawning test files reported 31 timeouts that
  were nothing but the health wait expiring. Those waits are now a minute
  (`waitForHealth`/`waitFor`/`waitForUrl` loops). If `npm test` fails only
  with "Timed out waiting for route-test server", time `node -e 1` before
  suspecting the code; run the failing file alone to confirm.
- jsdom has no `scrollIntoView`; `frontend/src/test-setup.js` shims it.
  The chat screen's sidebar is in the DOM even when closed, so its editors
  are reachable from a signed-in vitest without toggling it.
