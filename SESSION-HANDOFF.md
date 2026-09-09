# Session handoff

One current document for whoever picks this repository up next — a person
or a fresh Claude session with no access to the conversation that produced
it. Read `CLAUDE.md` first: it is the edit-time harness (invariants, how to
prove a change, how to land it). This file says where things stand, what
changed recently and why, what was verified live, and what is open.

## Where things stand (2026-09-09, evening)

- **Deployed:** `main` at `cd15135` (this session's commits `4eae5cc`,
  `ba07b4e`, the handoff `4236c9e`, and `cd15135`, on top of the morning's
  `333cfc3`/`db4cb5f`; then the handoff commit), live at
  https://college-counselor-web.onrender.com.
  Every push to `main` runs CI (backend lint, syntax, tests, `npm audit
  --audit-level=high`; frontend tests and build) and Render redeploys
  after it passes; each deploy restarts the process (a few seconds of
  502s). The student bundle changed with `4eae5cc` (the fit card and the
  prestige card are in the main chunk): `main-ENyTRcx7.js` →
  `main-64vLzzFp.js`.
- **Tests:** backend `npm test` 696 tests, 691 pass, 5 skipped, 0 fail
  (34 s when the machine is healthy); `npm run lint` 0 errors, 70
  warnings (CI cap 500); frontend `npx vitest run` 10 files, 34 tests;
  `npm run build` clean.
- **Dependencies:** `npm audit` reports 0 vulnerabilities in both
  packages (backend: `qs` overridden to 6.16 under express 4; frontend:
  vitest 4.1.11). `npm outdated` still lists updates inside the declared
  ranges that were deliberately not taken: backend dotenv 17.4.2, eslint
  9.39.5, helmet 8.3.0, mammoth 1.12.2, pdfjs-dist 6.3.289 (the CDS parser
  depends on pdfjs text positions — re-run `tests/cds-extras.test.js` and
  a spot re-parse before taking it); frontend @testing-library/react
  16.3.3, user-event 14.6.7, @vitejs/plugin-react 6.1.1, vite 8.2.2. Major
  jumps available (not taken): better-sqlite3 13, eslint 10, express 5,
  express-rate-limit 8, pdf-parse 2, tesseract.js 7, @napi-rs/canvas 1,
  react 19, jsdom 29, jest-dom 7. `npm fund`: 57 backend and 25 frontend
  packages seek funding — express (cors, http-errors, multer), eslint and
  its tree, dotenv, @napi-rs/canvas, express-rate-limit, pdf-parse, uuid,
  feross's buffer packages, isaacs's glob; vite (lightningcss, postcss,
  picomatch, tinyglobby, oxc types), vitest, parse5/entities, csstools.
- **Node on this machine:** every `npm install` here warns `EBADENGINE`
  because the packages declare Node `>=22.13.0 <23.0.0` (what CI's
  `.node-version` 22.22.0 and Render's `NODE_VERSION` run) and this
  machine runs Node 25.9 with no version manager installed. The tests
  pass on 25; the warning is the machine's, not the project's. To silence
  it, run Node 22 locally (fnm/nvm read `.node-version`) — widening the
  engines range was not done, since nothing tests the project on 25.
- **Working tree:** clean apart from the repository's phantom CRLF-only
  diffs (never stage them) and two untracked files not made by any session
  (`backend/kor.traineddata`, a Tesseract Korean model; `AGENTS.md`, a copy
  of `CLAUDE.md` with "Claude" changed to "Codex"). Files whose committed
  blob still carries CRLF get a whole-file diff the first time they have to
  change (this session: `backend/friendly-labels.js` and two test files);
  `git diff --cached --ignore-cr-at-eol --stat` shows the real change.
- **Standing authorizations from the user:** push straight to `main`; create
  and delete throwaway student accounts on production for live checks.
  Never ask for or use the counselor's password or a real student's.
- **Deferred by the user (2026-09-07):** the University of Wyoming College
  Fit data-source precedence. Do not pursue until asked.

## What changed, newest first

The user's ask for this session, verbatim: "can we update eval matrix in
college fit section with things created in this session and character
profiles made through EC in the profiles? Also, I think that prestige
rationale must be fixed considering the 150 character description and
other features added into the machinery." The "eval matrix" was taken to
be the list under the College Fit card — each stated value or C7 admission
factor with its "✓ N matches" / "no profile match" — produced by
`backend/college-values.js computeFit`; the "character profiles" are the
six-factor read of each activity (`ec-vectorizer.js vectorizeEC`, whose
sixth factor is community and character) and the stored strength vectors.

**Both audits clean, and the admin tests get the time they take
(2026-09-09)** — `cd15135`. The user asked for "a package fund and fixes
using the npm logs". The npm debug logs on this machine held nothing from
the project but the `EBADENGINE` warning above (the one older log is a
peer-dependency report from an unrelated global install), so the fixes
came from what `npm audit` still reported. Backend: two moderate
advisories in qs 6.15.3 (an array-limit bypass through bracket-key comma
parsing; a denial of service through an attacker-controlled `isBuffer`);
express 4.22.2 pins qs `~6.15.1` and npm offered only express 5, but
body-parser 1.20.8 already ships qs 6.16.0, a minor within the API
express 4 calls, so `backend/package.json` carries `"qs": "^6.16.0"` in
its `overrides` (beside xmldom, tmp, uuid) and the lockfile dedupes to one
qs 6.16.0; the full suite passes. Frontend: `npm audit fix` took vitest
4.1.10 → 4.1.11 for the @vitest/mocker redirect-mock path traversal
(devDependencies only, the bundle hash unchanged). That patch revives
vitest's global concurrency limit for the test lifecycle, so in a
whole-suite run each test's steps queue behind the other files': the
AdminApp bootstrap test, which types three long strings through
userEvent and passes in under three seconds alone, crossed the 5 s
default on every full run. Both AdminApp tests now carry a 20 s limit, as
the dashboard tests already do.

**Backend lockfile takes the multer, xmldom and js-yaml advisory fixes
(2026-09-09)** — `ba07b4e`. CI's audit gate failed on `4eae5cc` for
reasons unrelated to it: high advisories for multer, @xmldom/xmldom (via
mammoth) and js-yaml (via eslint) were published between the morning's
green run and that push. All three fixes sit inside the ranges
`package.json` declares, so only `package-lock.json` moved (multer 2.3.0,
xmldom 0.8.15, js-yaml 4.3.2). Two moderate advisories in `qs` under
express 4 remain; they need express 5 and are below the gate.

**The priorities matrix reads the whole record, and prestige is read from
the description (2026-09-09)** — `4eae5cc`.

*The matrix.* `backend/college-values.js computeFit(values, profile,
options)` now takes `options.strengthRows` (the student's EC strength
vectors) and `options.comparison` (the College Fit read's
`profileComparison` for the school) and scores four kinds of evidence
against each value: courses (type hints; AP/IB/honors/dual now speak to
"rigor"), activities (category and text hints as before, plus the traits
the activity's own 150-character description yields — leadership,
character, talent, commitment, impact, major focus — merged with the
strength vector's projection; the vector's community/character value is a
proxy and is damped to 0.6 so it can support a fair read but never a
strong one), academics (GPA, class rank, every test with its sections, AP
exam results, each placed above / inside / below the school's middle 50%
when a Common Data Set is held; a score below the range is listed but is
not a match), and nothing (an essay, recommendations, an interview, family
background, demonstrated interest are `unreadable` with a `reason`, and
`overall` is the share of readable values covered). Hints match at word
starts, and a hint of three letters or fewer stands alone, so "act" never
fires inside "impact" or "activities". Each `perValueCoverage` row carries
`evidence: [{ kind, label, tone, position, detail, traits, advice }]`, and
the result carries `academics`, `characterProfile` (per activity: traits,
tier, prestige) and `readableValues`. `server.js`: the values route passes
`fitMatrixOptions(studentId, schoolName)`; its `profileComparisonForSchool`
makes the same reads the fit calculation makes (`compareTestsToSchool`,
`compareGpaToSchool`, `compareRankToSchool`, `compareApExams` →
`buildProfileComparison`) from the stored CDS record and baseline row, no
live fetch. `college-research.js`: the CDS fallback keeps up to ten
declared factors (six had cut Stanford's "Character / Personal Qualities"
and "Talent / Ability"), and a page that cannot be read at all (host does
not resolve, safety check refuses it, fetch throws) is a page not read, so
such a school falls back to its CDS instead of answering "research
failed" (found by the route test: the mock's example-university.edu is
refused). `CalibratedFitCard.jsx` lists up to four evidence rows under
each value with localized placement words (`data-testid="fit-matrix"`);
labels in `frontend/src/i18n.js` (`fit.hits_*`, `fit.no_match`,
`fit.below_range`, `fit.not_readable`, `fit.interest_note`,
`fit.withhold_short`, `fit.trait_*`; en + ko).

*Prestige.* `competition-research.js researchCompetitionPrestige` takes
`evidence` ({ description, awards, role, fileText }): the catalog is
searched by the name first, then the description, awards, role and
attachment text (`findCatalogMatchInText`: earliest whole-word alias), and
the level is read from everything the student wrote when the name matched,
or from the name plus the field that matched otherwise. Level words match
whole words. The cache key carries a digest of the evidence
(`computePrestigeCacheKey(name, levelHint, digest)`; the two-argument key
is unchanged), so a changed description is a new read and one student's
"Math Team" never explains another's. Rationales are prose for the
student: `catalogRationale` (competition, level, where it was found, the
organizer's level description, the next level and what it reads at, or —
at the participation baseline — what to name), `benchmarkRationale` (the
seeded benchmark, where the level was found, the catalog's level text,
the next level; a benchmark hit now cites the organizer's pages through
the catalog entry for the same competition), `unavailableRationale` (what
to write so the next save picks it up; prestige is one factor of six).
`ec-strength-vectorizer.js`: `resolveBenchmarkHit` reports
`activity_name`, `next` and `matchedIn` (the first field that yields the
same detection on its own); the prestige component cache is keyed on the
combined text (`combinedHash`) so editing the description re-reads; the
catalog is consulted even without `ragStmts` (an empty stmts object
disables only the cache); `PRESTIGE_SOURCES.CATALOG`; reasoning carries
`matchedIn`, `level`, `nextLevel`. `friendly-labels.js` and `i18n.js` (en
+ ko): a `catalog` source label; `benchmark` is "Benchmark match";
`unavailable`/`legacy`/`research_failed` no longer describe web research
that no longer runs ("needs an OpenRouter key") and say what to write.
`server.js prestigeExplanationFor(row, ecName)` explains a strength row
from its own `reasoning_json.prestige` before the shared by-name cache
(`getPrestigeExplanation`), at the five call sites (bundle, strength list,
single EC, prestige route, spike). `PrestigeCard.jsx` shows the level and
catalog name, the source label (it read `data.sourceLabel`, a field the
route never sent, so the chip never showed), the source summary, and the
404 friendly message. Tests: `tests/college-values.test.js` (new),
`competition-research.test.js` (+5), `ec-strength-vectorizer.test.js`
(+2), `friendly-labels.test.js` and `i18n-korean.test.js` (catalog), the
route test "the priorities matrix and the prestige rationale read the
whole record", `CalibratedFitCard.test.jsx` (+1), `PrestigeCard.test.jsx`
(new). `backend/docs/METHODOLOGY.md` describes both.

**Server-spawning tests wait up to a minute (2026-09-09)** — `333cfc3`.
The five test files that spawn `server.js` gave it 8–20 s to answer
`/api/health`; on the machine described under *Tooling* a boot took 56 s
and the suite reported 31 timeouts that were nothing but the wait
expiring. The `waitForHealth`/`waitFor`/`waitForUrl` loops now allow a
minute and the launcher test's own limit is 90 s.

**An empty reply that exhausted its budget is retried with room to answer
(2026-09-09)** — `52a833c`, `backend/llm-adapters/openai.js` and
`index.js`. The wire adapter took only a string `content` and treated an
empty reply as an answer; the small tier's default model is
reasoning-capable but not on the reasoning list, so at the chat's
1,024-token budget it can spend everything thinking and return empty
content with `finish_reason: "length"`. The adapter joins array content,
reports `reasoning_tokens`/`had_reasoning`, makes one follow-up at 4,096
tokens within the same attempt when the reply is empty and the budget was
exhausted or reasoning was present (`budget_retry`, a `[llm] … returned
no text` warning), and starts that model at 4,096 for the rest of the
process. Pinned in `tests/llm-adapters.test.js`.

**A cut-off model attempt is retried, not returned blank (2026-09-08)** —
`b7e7bba`. The attempt budget's abort landed inside `response.json()`,
was swallowed as "no JSON", and came back as an empty 200; the body read
now throws the aborted error so the retry on a fresh connection runs. The
quick-call split is `maxTokens < 1024`, so chat turns get the 60 s first
attempt. Pinned in `tests/llm-adapters.test.js`.

**A weighted admitted average is read against the weighted GPA
(2026-09-08)** — `8469d60`, `positioning-engine.js compareGpaToSchool`.
An average above 4.0 (Harvard's 4.21) is compared with the student's
weighted GPA (or with 4.0 when none is recorded); the read carries
`averageScale` and `comparedGpa`, the card shows "(weighted)", the
VERIFIED DATA line says "(weighted scale)".

**Dashboard editing and the fit card (2026-09-08)** — `9dbafe0`.
`frontend/src/App.jsx`: every test card opens an inline editor
(`TestScoreEditor`), "+ Add test score"; the AP list has `ApScoreEditor`
and "+ Add AP score"; class rank sits under the GPA (`ClassRankEditor`);
the survey's test step takes sections for every test through
`sectionDefs`/`withSection`. `CalibratedFitCard.jsx` renders
`positioning.profileComparison` as "How your record compares". Tests:
`CalibratedFitCard.test.jsx`, `App.dashboard.test.jsx`; `test-setup.js`
shims `scrollIntoView` for jsdom.

**College Fit reads the whole record against the whole document
(2026-09-08)** — `2e49205`. `backend/positioning-engine.js`:
`compareTestsToSchool` (both tests scored, the stronger read, concordance
when the school reports only the other band, sections against section
bands, placement in the score-range table, test-optional "withhold"),
`compareGpaToSchool` (average + C11 band + C11 distribution),
`compareRankToSchool` (C10 shares), `compareApExams` (0.06 component only
with results); `profileComparison` on every positioning result. New
`backend/test-catalog.js` (mirrored by `frontend/src/test-scores.js`,
pinned together by `tests/test-catalog.test.js`). `chat-grounding.js`:
sections and class rank in the profile block, subscore and class-rank
fidelity, section bands / distributions in VERIFIED DATA.
`rag-engine.js`: `profile_snapshots.class_rank_json`. **Bug found by the
route test:** the positioning cache was keyed by targets and major only;
the key now includes `studentId` and the snapshot id.

**The wider Common Data Set read (2026-09-08)** — `c33004f`.
`cds-pdf-parser.js extractExtras` reads ACT section bands, the C9
score-range tables, the C11 GPA distribution, the C12 average and
submitted share, and `classRank.topHalfPct`/`submittedPct`; two old bugs
fixed (percentages read as whole numbers; "between 3.75 and 3.99" not
matched). `parserVersion` 4; the store re-ingests newer parsed files; all
30 PDF-backed records regenerated (the three xlsx-backed ones were not).

**Earlier (2026-09-07 and before)** — deadline tables in the policy scout,
Columbia's official CDS, scout resilience, applicant counts on the CDS
line (`c4c5bb0` and the commits it summarizes); the official-source gate,
the model-catalog scout, crisis handling, OCR uploads, the College Fit
double-check, profile grounding.

## Verified live, and not

All checks used throwaway `probe-*@example.test` accounts on production,
deleted afterwards.

- **After `4eae5cc`/`ba07b4e` (bundle `main-64vLzzFp.js`, deployed
  10:13 UTC on 2026-09-09):** one probe account (registered, three
  consents, profile GPA 3.9 / rank 12 of 400 / SAT 1520 with sections /
  AP 5 / two AP courses, three activities, target Stanford; deleted, 200).
  `GET /api/ec/strength?friendly=1` after the sync: Math Team prestige
  0.72 "Benchmark match", Robotics Club 0.45 "Benchmark match" (the FRC
  regional in its description), Food Bank 0 "No catalog match". `GET
  /api/ec/strength/Math%20Team/prestige`: `level "AIME qualifier"`,
  `matchedIn "description"`, `nextLevel {USAMO qualifier, 0.92}`, the two
  maa.org pages cited, rationale "Matched the seeded Math Olympiad
  (AMC/AIME/USAMO/IMO) benchmark at the "AIME qualifier" level from your
  description. AIME qualification is a selective national math
  achievement in the MAA pathway. The next level, "USAMO qualifier",
  reads at 0.92." Food Bank's route answered 200 (it used to 404 without
  a cache row) with the what-to-write rationale. `POST
  /api/colleges/values` for Stanford answered in 24 s from Stanford's own
  site (five quoted values, no CDS fallback): `fit.overall` 80 of 5
  readable values; "Intellectual Curiosity" 5 hits (both AP courses
  strong, Math Team and Robotics Club strong with `major_focus`, Food Bank
  fair); "Civic Engagement" and "Service And Common Good" list Food Bank
  with `character`; "Diversity Of Thought" 0 hits; `fit.academics` carried
  GPA 3.9 "within", class rank top 3% "above", SAT 1520 (Reading &
  Writing 740, Math 780) "within", AP exams strong — placed against
  Stanford's stored CDS by the values route itself — and
  `fit.characterProfile` had the three activities' traits (Robotics
  leadership 0.98, Math Team major focus 0.9, Food Bank character 0.45).
- **After `cd15135` (backend-only deploy; CI green, restart blip 502 at
  10:46:39 → 200 at 10:46:43 UTC on 2026-09-09; bundle unchanged):** a
  throwaway account's query-string routes through the overridden qs all
  answered 200 — `/api/ec/strength?friendly=1`, the same with
  `&locale=ko`, an array-and-nested key (`friendly[0]=1,2&a[b][c]=1`, the
  shape the advisory was about) and `/api/students/profile?locale=en-US`;
  the account was deleted (200).
- **Earlier today (after `9dbafe0`, `b7e7bba`, `52a833c`):** the profile
  round-trip kept sections and class rank; Stanford's fit read returned
  `profileComparison` (SAT "within" 1510–1580 with both sections against
  740–780 / 770–800, GPA 3.9 in the 3.75–3.99 band with 73.3% above, class
  rank top10 against 97.8%, advice "submit"; provenance `cds_store`,
  validated); after the adapter fixes, two probes of four chat turns each
  answered every turn (the Stanford ACT-sections question in 11–18 s with
  a cited section table; "Should I submit my SAT?" 56 s once with the
  budget follow-up, then 16 s; Knox College honestly in 5–9 s).
- **Not verified:** the fit card's matrix and the prestige card in a real
  browser (vitest covers them); the Korean strings in situ; the C7
  fallback path on production (it triggers only when a school's site
  cannot be read — the route test covers it with a refused host); the
  weighted-average read live (Harvard).

## Open items and things to watch

- **Academic rows appear mostly under C7 factors.** Quoted mission values
  ("Intellectual vitality", "Service") rarely name GPA or tests, so the
  academic evidence shows when the values come from the CDS fallback; a
  possible follow-up is to list the school's C7 factors beside its quoted
  values whenever a CDS record is held, so the record is always read
  against both.
- **Prestige rationales are English-only** (the catalog's level texts and
  the composed prose); the source labels and the friendly messages are
  localized. Korean students see the rationale in English, as before.
- **Strength rows without reasoning** (computed before `4eae5cc`) still
  fall back to the shared by-name cache row (`getPrestigeCacheByName`)
  until the next sync recomputes them; the next save of the activities
  list rewrites every row.
- **The strength vector's community/character proxy** (0.4 dedication +
  0.3 leadership + 0.3 narrative fit) is damped to 0.6 in the matrix; the
  lexicon read of the description dominates. If character rows look
  over-generous for captains of long-running teams, lower
  `PROXY_TRAIT_DAMPING` in `college-values.js`. The `impact` trait is the
  legacy projection's blend of achievement, leadership and prestige (live,
  an AIME qualifier read `impact` 0.48 and appeared as fair evidence under
  "Innovation And Discovery"); add `impact_and_scope` to the damping map
  if that reads as a stretch.
- **The qs override** (`"qs": "^6.16.0"` in `backend/package.json`) can
  come out once express 4 itself moves past qs 6.15 or the app moves to
  express 5; until then `npm ls qs` should show one 6.16.x. New advisories
  can fail CI's `npm audit --audit-level=high` on a push that did not
  touch dependencies — check `gh run view <id> --log-failed` before
  suspecting the code, run `npm audit fix` in the package, rerun its
  tests (a patch can change runner behaviour: vitest 4.1.11 did), and
  commit the lockfile.
- **Old positioning cache rows** keyed without a student remain in the
  scorecard query cache until pruned; unreachable under the new key.
- **Rows regenerated by the parser** are unvalidated extras (the validator
  checks admit rate, SAT band, scope and B1 only). Cornell, Washington and
  Wisconsin still yield no extras; the xlsx records (Stony Brook, Berkeley,
  UIUC) keep parser version 2/3 and no sections.
- **Georgia Tech's GPA band reads 4.0–4.0**; `cdsLine` prints "25th and
  75th percentile both in the 4 band".
- **Small-tier latency and empty replies.** The default small model
  (`google/gemma-4-26b-a4b-it`) is reasoning-capable but not on
  `REASONING_MODEL_PATTERNS`; the adapter retries once at 4,096 and
  remembers the floor per process (`BUDGET_RETRY_MODELS`). If blanks still
  appear, add the model to the reasoning patterns or route COLLEGE FIT
  turns to the medium tier (`TIER_BY_CLASSIFICATION`).
- The `normalizeTestScores` helper exists but the sync route still stores
  `profile.testScores` as sent; wiring it in would drop malformed entries
  from older builds silently — decide deliberately.
- The class-rank fidelity check flags only "top N%" claims; "top tenth"
  wording is not checked.
- Items carried from 2026-09-07: the sixty-school scout cap
  (`POLICY_SCOUT_MAX_SCHOOLS`), the table-pass limits in the scout, the
  document-scope extractor exercised only on Columbia, `index.json` as a
  cache of College Transitions' index, the Spanish duplicate page slot,
  the "a Early Decision II" article, SAT sections not read from uploaded
  score reports, streaming vs the post-hoc fidelity check, bare "Brown"
  not an alias, validator token lists, the StudentAid.gov footer.

## Quick verification recipes

Matrix, prestige read, labels, engine, grounding, catalog:

```bash
cd backend && node --test tests/college-values.test.js tests/competition-research.test.js tests/ec-strength-vectorizer.test.js tests/friendly-labels.test.js tests/i18n-korean.test.js tests/positioning-engine.test.js tests/chat-grounding.test.js tests/test-catalog.test.js
```

Route tests for the whole path (spawn the server, ~1 min each):

```bash
cd backend && node --test --test-name-pattern="the priorities matrix and the prestige rationale" tests/council-naming-deadlines-routes.test.js
```

```bash
cd backend && node --test --test-name-pattern="subscores, AP scores and class rank" tests/council-naming-deadlines-routes.test.js
```

Frontend: `cd frontend && npx vitest run && npm run build`.

Live probe with a throwaway account (Node 22, `BASE` is the site): register
with grade 11 / CA / example.edu, grant the three consents, sync a profile
with GPA, `classRank: { rank, size }`, an SAT with `sections`, `apScores`,
and activities including one whose description names a level ("Qualified
for AIME after a 108 on the AMC 12") and one service activity; poll `GET
/api/ec/strength?friendly=1` until `count` matches; `GET
/api/ec/strength/<name>/prestige` (expect `level`, `matchedIn`, prose
`rationale`, `friendly.short`, organizer `sourcesCited`); `POST
/api/colleges/values` `{ collegeName }` (expect `fit.perValueCoverage[].
evidence`, `fit.academics`, `fit.characterProfile`; the Stanford values
come from its site, so the academic rows show under a school whose site
cannot be read); `POST /api/positioning/targets` and a College Fit chat
turn as before; `DELETE /api/students` with retries. Print the account
first; a 502 during a deploy can lose the delete.

Re-parse one cached CDS PDF and print the wider read: from a scratch
folder, a `.mjs` that imports `parseCDSPositional` from
`file:///…/backend/cds-pdf-parser.js` (Windows needs the `file://` form),
calls it on `backend/tools/cds-cache/pdfs/<slug>.<year>.pdf` with
`{ method: "auto" }`, and prints `enrolledGPA` and `extras`.

Deploy markers: `/` carries `assets/main-*.js` (changes with anything in
the main chunk: `App.jsx`, the components, `i18n.js`), `/admin.html`
carries `assets/admin-*.js`; a backend-only deploy shows only as a brief
`/api/health` blip after CI succeeds. Render deploys roughly five to eight
minutes after CI goes green.

## Tooling notes for a Claude session on this machine

- Bash heredocs containing single quotes fail here; write node scripts and
  commit messages with the Write tool and run or `-F` them. Import backend
  modules from scratch scripts with `file:///C:/…` URLs. To append tests to
  an existing file, write the block to a scratch file and `cat` it on.
- Stage explicit paths only; commit messages end with
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Foreground `sleep` is blocked; a background Bash loop with `sleep` (CI
  watch over `gh run watch --exit-status`, a deploy-marker wait) works and
  notifies on completion. Parallel Bash calls share one working directory
  and a `cd` in one of them moves the others — use absolute paths.
- The route-test file shares one server and database across its tests;
  a cache or state leak between students shows up only in the full run,
  never when a test runs alone (`--test-name-pattern`).
- Overnight on 2026-09-09 every process launch on this machine took
  seconds (`node -e 1` 2–15 s, `cmd /c echo` 11 s, CPU idle, memory
  free), so a server boot took 56 s and the server-spawning test files
  timed out. Those waits are now a minute. If `npm test` fails only with
  "Timed out waiting for route-test server", time `node -e 1` before
  suspecting the code; run the failing file alone to confirm. By the
  evening the machine was healthy again (full suite 34 s).
- jsdom has no `scrollIntoView`; `frontend/src/test-setup.js` shims it.
  The chat screen's sidebar is in the DOM even when closed, so its editors
  are reachable from a signed-in vitest without toggling it.
- A UI test that passes when its file runs alone but times out at 5 s in
  the full `npx vitest run` is queueing behind the other files (vitest
  4.1.11's lifecycle concurrency limit), not hanging: give it the time it
  takes (`it(name, fn, 20_000)`), as the AdminApp and dashboard tests do.
