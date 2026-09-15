# Session handoff

One current document for whoever picks this repository up next — a person
or a fresh Claude session with no access to the conversation that produced
it. Read `CLAUDE.md` first: it is the edit-time harness (invariants, how to
prove a change, how to land it). This file says where things stand, what
changed recently and why, what was verified live, and what is open.

## Where things stand (2026-09-16)

- **Deployed:** `main` at `5f4e207`, live at
  https://college-counselor-web.onrender.com. Confirmed by CI run
  35005431519 (success) and by the bundle hash
  and by behaviour at 18:09:24 UTC on 2026-09-15 (see *Verified live*). Earlier in
  this session: `2f287de`, `40b1ee6` and `dacc220` (their own CI run 35000625447 hung twice and was cancelled — see the change log — so they deployed with `5f4e207`), `ef1d56e`
  (backend-only, CI run 34993176954, 16:10 UTC 2026-09-15), `0af239e`
  and `72f2509` (CI run 34982389053; `/` serves
  `assets/main-rc4QTNwr.js` since 14:34:55 UTC 2026-09-15, after a 502
  blip at 14:34:23). Before that: `3a8fdc3` (CI run 34763637850, bundle
  `main-DNKi9XlM.js`, 14:48 UTC 2026-09-13), `9ec5edc` (CI run
  34763205856), `3c5f10b` (CI run 34762384550), `0caa68e` (CI run
  34762088537), `58b28fb` (CI run 34760878050); the 2026-09-11 builds
  `95f5116` CI run 34603951260, `651f7ac` CI run 34602871341,
  `6a29565`, `fa6c5b1`. CI runs backend lint, syntax, tests and
  `npm audit --audit-level=high`, then frontend tests and build; Render
  redeploys after it passes, with a few seconds of 502s.
- **Tests (full run 2026-09-15 ~17:40 UTC, before `5f4e207`, whose only change is the shutdown handler; CI ran the whole suite on `5f4e207` in run 35005431519, backend job 41 s):**
  backend `npm test` 737 tests, 733 pass, 4 skipped, 0 fail;
  `npm run lint` 0 errors, 70 warnings (CI cap 500); frontend
  `npx vitest run` 18 files, 53 tests; `npm run build` clean
  (local bundle `main-B6X5y47h.js`; Render builds it as `main-DmeQgzda.js`).
- **Working tree:** the same phantom CRLF-only diffs (never stage them;
  `git diff --cached --ignore-cr-at-eol --stat` shows the real change),
  the two untracked files not made by any session (`backend/kor.traineddata`,
  `AGENTS.md`), and the local download cache
  `backend/data/cds-cache/pdfs/` (gitignored, ~330 documents fetched by
  the refresh on 2026-09-16; the tracked seed is
  `backend/tools/cds-cache/parsed/`).
- **The CDS cache now covers 298 schools** (was 36): 118 on
  2025-26 documents, 141 on 2024-25, the rest on the newest cycle
  the school has published. Every record carries the section read
  (parser version 6). The server re-ingests all of them at boot from the
  parsed directory (`ensureCdsStoreSeeded`: newer parser version or a
  changed cycle label), so the first boot after a deploy runs ~300
  `persistAndValidate` calls.
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

The user's asks on 2026-09-15/16, verbatim, in order: "Reload the tab
and check Course plan and update college fit sections to apply the
2025-2026 CDS" (the Course plan check landed in `3a8fdc3`'s handoff) —
"Also, make a closing button similar to the claude code interface." —
"Also, update all of the other school's CDS to the newest versions." —
"Also, ingest all the other sections." — "read chat uploads into uploads
section is defective and can we have a collappse section at the sidebar?"

**Every chat attachment is filed under Documents, and the sidebar folds
into sections (2026-09-16)** — `dacc220`. Files attached through
the chat picker reached the sidebar's Documents list only when one of them
was the binary promoted to the legacy attachment slot (`send` in
`App.jsx` filed `attachment` alone): a resume or essay draft (text), a
second PDF, or an image sent beside a PDF never appeared. `chat-documents.js`
(`filedChatDocuments`, `mergeDocuments`) files every attached file once
the turn has passed screening — a type from the media type or extension, a
category from the name (score report, report card, transcript, resume,
essay, letter, certificate), the size — and a re-sent file (same name and
size) is not filed twice; the list lives in the encrypted vault with the
rest of `data`. The sidebar's headings (Chats, College fit, Profile,
Courses, AP exam scores, ECs, Documents, Target schools, Tools, Language)
are `SidebarSection` headings now: a button with a chevron that folds the
section away (`hidden` content, `aria-expanded`), remembered per section
in `localStorage` (`cc.sidebar.collapsed`); the Chats heading keeps its
"+ New" action. `chat-documents.test.js` and `SidebarSection.test.jsx`
pin both; the sidebar itself was not looked at in a browser. Also in this
session's backend: `server.js` logs an unhandled promise rejection
instead of exiting (Node's default) — pdfjs rejected one after a document
was torn down during the whole-index refresh ("AbortException: Value is
none of these types"), which would have taken the counselor down during
the daily CDS refresh. That guard first hung CI for 36 minutes
(`5f4e207` fixed it): a route test sends SIGTERM two seconds after
boot, while the seeding of 298 records still has a statement running, so
`db.close()` threw inside the async `shutdown`; before the guard the
rejection ended the process and the test moved on, with it the process
stayed alive and the test waited on its exit forever. Windows kills the
child outright, so local runs never reach the handler. `shutdown` now
closes each database inside its own try, exits in every path, and arms a
five-second forced exit first. The backend CI job normally takes about
40 seconds; a run past three minutes is a hang, and `gh run cancel`
makes its partial log readable.

**The remaining CDS sections reach the model, and every school reads its
newest document (2026-09-16)** — `40b1ee6` (code), `2f287de`
(data). `cds-sections.js` reads what the parser left alone: B
(undergraduate headcount, first-year retention, the six-year graduation
rate of the most recent cohort), C2 (wait list offered / accepted /
admitted), C22 (Early Action volume), D2 (transfer applied / admitted /
enrolled), F1 (shares of first-year students from out of state and living
on campus), G1 (tuition, required fees, food and housing for the academic
year the document names), H2 (average share of need met) and I3 (class
sections by size, summarized as the share under 20). The layouts differ:
Indiana and the workbooks put the numbers on the label's line, Harvard and
Stanford wrap them to the next line, the workbooks print ratios (0.71)
where PDFs print percentages, Harvard's graduation grid holds ratios
beside Indiana's percentages; the reader accepts all of these and keeps the
first-year column. Both parsers merge the sections into `extras` (the
workbook parser read no extras at all before), parser version 6 makes the
store re-ingest every record at boot, and `cdsExtrasParts`
(`chat-grounding.js`) writes the facts into the VERIFIED DATA block with
money as "10,622 USD" (the provider-side redactor masks dollar signs).
`extractC1Counts` also reads Indiana's Men / Women / Another / Unknown
columns with no total (summed; "in Fall 2024" between label and numbers
ignored; "students who applied" and "who admitted" tolerated) and
Middlebury's "(September only)" qualifier, which had made its admitted
count 2. Then the whole index: all 345 schools in the merged operator +
repository index went through the pipeline (a scratch SQLite database
built with `initRAGTables` + `prepareRAGStatements`, `ingestBulk` at
concurrency 3 preferring 2025-26 and falling back to the newest live
cycle, then `loadValidatedRecord` + `loadLatestValidation` dumped to
`tools/cds-cache/parsed/<slug>.json` for the statuses ok / consistent /
discrepancies / ok_with_overrides). Result: 298 records; skipped 22
schools with no link, 24 whose document yields nothing checkable
(`no_truth`), 3 parse failures (Syracuse and the Air Force Academy
workbooks throw in exceljs, Yeshiva's workbook has broken XML), Brown
(scope mismatch on its 2023-24 document; its committed record stays) and
Alfred. None of the 36 earlier records lost a field; seven moved to a
newer cycle (Caltech relabeled 2023-24; Michigan State, Northwestern,
Purdue, Penn, UVA and Wisconsin to 2024-25; Penn's admit rate 5.87% →
5.4%, UVA gained its C7). The operator index lost a bogus "col9" cycle key
(Agnes Scott, Alfred, UMass Lowell). The route tests' "school with no
data" helper now skips any school with a parsed record. Tests:
`cds-sections.test.js` (both layouts, an empty document),
`chat-grounding.test.js` (the block), `cds-c1-counts.test.js` (Indiana,
Middlebury), `cds-xlsx-parser.test.js` (version 6).
Coverage across the 298 records: undergraduate headcount 218,
retention 66, graduation 184, wait list
167, Early Decision 112, Early Action 5,
transfer 192, student life 230, costs 119,
aid 224, class size 39. Two reads were corrected after
the first whole-index pass: an amount must not be the digits of a coded
item id ("G.201" follows the G1 labels in the workbooks' coded view and
had read as a 201-dollar tuition for Cornell, Kenyon, Rhodes and
Allegheny), and a six-year graduation rate under 5% is a stray cell
(Austin College, UC Davis), both pinned in `cds-sections.test.js`.

**The workbook C7 read and the newer-cycle guard (2026-09-15)** —
`ef1d56e`. Cornell's and Illinois's 2025-26 workbooks put the form view
and a coded data view on the same sheet rows, so the C7 X grid read as all
not_considered and Cornell lost the admissions-factor weights its 2023-24
PDF had. `extractC7Labelled` (`cds-xlsx-parser.js`) reads the coded rows
(factor label cell, then the rating as text) when the grid read is empty.
And the daily June-onward refresh (`refreshAllCds`, registered in
`server.js`) falls back to an older cycle when the newest link fails —
Cloudflare blocks the JHU document for a Node fetch — which would have
replaced the seeded 2025-26 record and made the next boot flip it back
from the parsed cache; `ingestOne` now compares the downloaded cycle with
the stored one (`isOlderCycle`) and reports `kept_newer` instead of
persisting, unless forced.

**Every dismissible surface closes from a × in its corner, like the
Claude Code interface (2026-09-15)** — `0af239e`. The tool cards (Edit
story, Rank EC ideas, Spike Finder, Course plan) had a bordered "✕" pill,
the drift banner a text "Dismiss" button, the deadlines dialog a text
"Close" button, and the session toasts (inactivity warning, reconnecting,
session expired, offline, unsynced change) no close at all.
`CloseButton.jsx` is the one control they share: a bare "×" at the
corner, muted until hovered or focused, a full-size hit target, an
accessible name from the existing "Close" / "Dismiss" strings in both
languages; a closed session toast hides that notice only, a different
notice still shows. `CloseButton.test.jsx` and a `DriftBanner` case pin
it. Not checked in a browser: the Chrome tab group of the earlier session
was gone after the context reset and the user was not asked to sign in
again; the bundle hash confirms the deploy.

**College Fit reads the 2025-26 Common Data Set (2026-09-15)** —
`72f2509`. The 2025-26 template renamed the C1 rows (males, females,
students of unknown sex), UNC and CMU publish C1 as one row per count with
Men / Women / Unknown / Total columns and no gender word, and the Cornell
and Illinois workbooks carry every label twice; ten of the eleven cached
2025-26 documents had no counts and no admit rate, and the workbooks
summed to 184,557 applicants. `extractC1Counts` now reads only the
numbers right after each label, counts each distinct label once, prefers
gender rows and otherwise takes the first no-gender row (the residency
table repeats those labels). Validation was pinned to 2023-24 ground
truth, so a 2025-26 record failed against last cycle's figures or lost to
the IPEDS baseline; the corrections registry is cycle-aware
(`DEFAULT_TRUTH_CYCLE`, Columbia's entry is 2024-25), a record from
another cycle keeps only the scope checks and passes
`checkConsistency` (monotonic counts, rate within 0.005 of
admitted/applied, SAT 800–1600 and ACT 1–36 with p25 ≤ p75) into the new
`consistent` status; the store treats it as usable and reports
`cdsVerification` (unverified / consistent / validated), the engine docks
confidence 0.05 (cap 0.77) for it and counts a 2025-26 cycle as current,
the fit card labels it "CDS · school document". Twenty-four schools got
2025-26 records; the Princeton, Michigan and Georgia Tech links in the
operator index were dead and are replaced; the download user agent is
Chrome/140 (UCLA rejects Chrome/120); the JHU document was fetched by hand
(curl with a browser user agent, a referer and `Accept: application/pdf`;
Cloudflare returns 403 to Node's fetch whatever the headers). The Stanford
route pins read the seeded record instead of the 2023-24 numbers.
`scripts/export-parsed-cds.mjs` dumps validated rows to the parsed
directory by slug or year.

The user's asks on 2026-09-13, verbatim, in order: "The chat file uploads
do not work. Also, check for additional UI defects by playing with it.
Use claude in chrome to do that." — "Also fix the Spike Finder tier label
and the concept mastery display." — "Reload the tab and check Spike
Finder and Course plan" — "Fix the double fetch in Spike Finder too" —
"Also apply the same fix to Course plan and Rank EC ideas and verify
that other things do not have this defect".

**The Course plan and the calendar read fetch once when the target list
arrives (2026-09-13)** — `3a8fdc3`. Same shape as the Spike Finder's
double fetch, same remedy: `CourseSequencer.jsx` keeps `tunedForRef`
against the `targetSchools` the recommendations route reports and skips
the refetch when the list that arrives matches (aborting a superseded
request; `api.js recommendations` takes a `signal`), and the app-level
calendar effect in `App.jsx` (`/api/calendar/context` on entering chat
and on every target-list change) does the same with
`calendarTunedForRef`. Audit of everything else that fetches:
`CandidateRanker` ("Rank EC ideas") fetches only on the student's own
clicks (generate ideas, rank) with the list current at that moment, so
it had no automatic double fetch — its only duplication was the extra
card per button click, fixed in `9ec5edc`; `NarrativeEditor` reads the
active story once on mount and uses the target list only for the draft
button; `DriftBanner`, `DeadlineTracker`, `EcEvidence` and
`PrestigeCard` key their reads on a refresh counter or an activity name,
never the target list; in `App.jsx` the remaining fetching effects are
the auto-sync (keyed on the vault data by design) and the 30-second
profile poll. `CourseSequencer.test.jsx` pins the single fetch.

**Spike Finder fetches once per open, and a tool button brings its open
card into view (2026-09-13)** — `9ec5edc`. Opening Spike Finder cost two
model re-ranks: the parent's target-school list loads from localStorage
after sign-in, so a panel mounted before it arrived fetched bare and
again with the list, while the server had already resolved the saved
schools for the bare call (`resolveTargetSchools`) and reported them as
`targetSchools`. `SpikeFinder.jsx` keeps `tunedForRef` (the list the last
read was tuned for, as the server reported it), skips the refetch when
the list that arrives is that one, aborts a superseded request (the
`api.js spike` helper takes a `signal`), and refetches when the list
differs. Separately, each click on a tool's button appended another card
and each card fetched — three clicks were three Spike Finder panels and
three re-ranks; `openTool` in `App.jsx` now scrolls an open card of that
tool into view (the card wrapper carries `id={m.id}`) instead of adding
one, reading the open cards through `messagesRef`. `SpikeFinder.test.jsx`
pins the single fetch and the refetch on a changed list; the tool-button
behaviour has no test (it lives in `App.jsx`).

**Research output is achievement, the tier no longer needs contest
prestige, and an AP exam score leads the concept read (2026-09-13)** —
`0caa68e`. The Spike Finder's "Foundational" beside a 0.80 lead score
came from two rules. The achievement factor
(`ec-strength-vectorizer.js`) read only awards, competitions, reach and
listed prizes, so a publication, preprint, manuscript, poster or talk
scored 0; `RESEARCH_OUTPUT` now scores published work 0.5, shared output
0.35, author credit +0.12, and `ACHIEVEMENT_RULES_VERSION` (2) is part of
the factor-cache inputs so scores cached under the old rule are not
served. `computeTierLabel` required catalog prestige for tiers 2 and 3,
and prestige comes from the competition catalog, so research, a job, a
founded project or a portfolio could never leave Foundational; tiers 2
and 3 now take `max(prestige, achievement)` for that floor (tier 1 still
needs prestige), and `toPublicShape` derives `tierLabel` from the stored
factors at read time so the rule applies without a recompute (the
achievement change itself lands at the next recompute or sync). The
course plan's "concept mastery developing (0.43)" beside an AP 5:
`conceptSignalFor` and `apExamScoresBySubject` in
`course-sequence-catalog.js` let the exam outrank the chat-derived
concept vector (4–5 solid; 3 solid only when the chat read agrees; 1–2
developing; exam names normalized past "Physics C: Mechanics"'s colon),
the route passes `snap.ap_scores_json`, and `CourseSequencer.jsx` renders
"AP exam 5 · concepts solid (chat read 0.43)". Tests: additions to
`ec-strength-vectorizer.test.js` (the tier-2 prestige-floor test now
needs achievement low too) and `course-sequence-catalog.test.js`, new
`CourseSequencer.test.jsx`.

**Chat PDF uploads, attachment-turn classification, and four live UI
defects (2026-09-13)** — `58b28fb`. Driving the deployed app in the
user's Chrome (signed in by the user; a text, a PDF and a PNG attached
through the 📎 picker): the TXT and the PNG (OCR) were read and answered,
the PDF came back "Uploaded file could not be safely processed" (HTTP
422, code `pdf_parse_failed`). Reproduced from the API with three PDFs:
a 662-byte hand-written PDF and the repo's `tests/fixtures/hello.pdf`
fail, a 370 KB Common Data Set PDF passes even as a cache-missing copy;
locally on Node 25 all three parse, and under Node 22.22.0 (`npx -y
node@22.22.0`) the two small ones fail with "bad XRef entry" — pdf-parse's
bundled 2020 pdf.js on a classic cross-reference table (the shape every
small export has; Word/Acrobat PDFs carry xref streams). The repository's
PDF test recorded exactly this and was skipped. `file-extractors.js
extractPDF` now reads the text layer with pdfjs-dist (the build the CDS
parser and the OCR fallback already run in production), passes the
standard-font directory, joins lines as pdf-parse did, and keeps
pdf-parse as the second reader; the PDF test runs again and a
classic-xref PDF built inline is extracted from a pooled Buffer as the
upload route decodes it. Second finding, on every attachment turn: the
reply carried "Limitations … Next actions: StudentAid.gov" — the
regulated decoration. The client's `sanitizeInput` strips every "[" and
"]" before sending, so the "[Attached files — …]" and "[Context appendix
— …]" sentinels arrive bracketless and the server's strip patterns (which
required the brackets) matched nothing: the document text and the
calendar's "FAFSA opens …" were classified, and `attachmentTurn` was
false so the fidelity check ran on document turns. New
`backend/chat-envelope.js` (`stripClientEnvelope`, `hasAttachmentPreface`)
matches the sentinels with or without brackets; `sanitizeInput` leaves
its own sentinel lines intact (`SENTINEL_LINE_RE`); tests
`chat-envelope.test.js` and the route test "file preface lost its
brackets". Found while playing: (1) the drift banner showed "Every
activity's narrative_fit was scored … You're up to date." as a warning
with a Review button on every visit — `/api/narrative/drift` never sent
the `status` the banner keys off (`all_fresh` hides it); added in both
branches, the message says "narrative fit", `DriftBanner.test.jsx` pins
it; (2) the Course plan's verified line and the model's target-school
block wrote "admit ~0.0923%" (the validated CDS record holds a fraction)
— `admitRatePercentOf` in `getSchoolPriorities`; (3) the course ladder
called Calculus AB a gap for a student whose Calculus BC existed only as
an AP exam result — `coursesWithApExams` in `course-sequence-catalog.js`
adds AP exams as AP courses before the diff. Not changed: the Spike
Finder read a first-author review as tier "Foundational" with lead score
0.80 and achievement/prestige 0.00 (a strength-vector read, not a
rendering fault), and the Course plan shows "concept mastery developing
(0.43)" beside an AP subject the student scored 5 on (the concept vector
comes from chat prompts, not the exam).

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
each deleted afterwards (200), except the browser session of 2026-09-13,
which the user signed into with their own account in their own Chrome;
nothing from that account is recorded here.

- **After `5f4e207` (bundle `main-DmeQgzda.js`, 18:09:24 UTC 2026-09-15):**
  a fresh account (grade 11, three consents, a small
  profile) asked `/api/positioning/targets` for Indiana University
  Bloomington, Middlebury College and Stony Brook University with
  `searchCds: false`: all three came from `cds_store` with verification
  `consistent` — Indiana on its 2024-25 document (admit 78.2%, SAT
  1180–1390), Middlebury on 2025-26 (12.8%, 1460–1530: the "(September
  only)" fix), Stony Brook on 2025-26 (48.2%, 1350–1470). One `/api/chat`
  turn ("For Indiana University Bloomington, what are the in-state and
  out-of-state tuition figures, and how many students were offered a
  place on its wait list? Just the numbers from your verified data.")
  answered "10,622 USD; 40,369 USD; 7,524 students." with
  `verifiedData: true` (topic high_stakes, medium tier), so the G1 and C2
  sections reach the model. Account deleted (200). The Documents list and
  the folded sidebar were not looked at in a browser.
- **After `ef1d56e` (backend-only; CI success 16:10 UTC 2026-09-15):** a
  fresh account's College Fit read of Cornell carried 19 admissions factors
  (0 before) and JHU 19, both on their 2025-26 documents with verification
  `consistent`; `/api/colleges/values` for Cornell answered from its
  curated values (5 rows, no `fallback`), so the C7 fix shows there only
  for schools without curated values. Account deleted (200).
- **After `0af239e` (bundle `main-rc4QTNwr.js`, 14:34:55 UTC
  2026-09-15):** a fresh account (grade 11, three consents, a small
  profile) asked `/api/positioning/targets` for JHU, Princeton, UNC and
  Cornell with `searchCds: false`: every read came from `cds_store` with
  `yearLabel "2025-26"`, `verification "consistent"`, `validated false`
  and the school's own 2025-26 document as `sourceUrl`; admit 6.1% / 4.4%
  / 16.7% / 8.4%; the enrolled SAT bands 1530–1565, 1490–1560, 1400–1530,
  1490–1550; JHU's class-rank top-tenth share 100 (23.4% submitting).
  `/api/colleges/values` for JHU: `fallback cds_admission_factors`, 10
  rows, locale en-US. Account deleted (200). The close button was not
  looked at in a browser.
- **After `3a8fdc3` (bundle `main-DNKi9XlM.js`, 14:48 UTC 2026-09-13), in
  the user's own tab, reloaded and signed in by the user:** one
  `/api/calendar/context` call after sign-in; the Course plan opened with
  one `/api/courses/recommendations` request carrying the five targets
  and no bare call, and rendered "AP exam 5 · concepts solid (chat read
  0.43)" rows as before.
- **After `9ec5edc` (bundle `main-Bj7IFpMZ.js`, 14:39 UTC 2026-09-13), in
  the user's own tab, reloaded and signed in by the user:** the network
  log was cleared, the Spike Finder button was clicked twice three
  seconds apart, and the tab held one Spike Finder card and one request
  to `/api/ec/spike`, carrying the five target schools, with no bare call;
  it answered in 25 s (the three-panel session saw 94 s and 120 s) and
  the cards read "Developing · Lead score 0.54" and "Foundational" at
  0.30 and 0.21.
- **After `3c5f10b` (backend-only; blip 14:22 UTC 2026-09-13):** a fresh
  account with a first-author review ("manuscript posted as a preprint on
  bioRxiv", 4 h/week, one year, no saved story) and a math team:
  `/api/ec/strength` read the review at achievement 0.47, prestige 0,
  tier `tier_4_foundational` (dedication and fit under the floors on that
  thin record — the rule, not a fault); `/api/ec/spike` (engine `llm`,
  10 s) returned rank scores 0.271 and 0.219, on the 0–1 scale. Account
  deleted (200). Then, at the user's request, their own tab reloaded onto
  `main-BGY9a-V4.js` and was signed in by the user: the drift banner was
  gone; the Course plan read "AP exam 5 · concepts solid (chat read
  0.43)" on AP Biology, Chemistry and Statistics, listed Calculus AB
  under "On your transcript" (from the Calculus BC exam) with no gap
  section, and "admit ~9.2%" / "admit ~8%" on the verified lines; the
  Spike Finder's cards read "Developing · Lead score 0.54" for the review
  and "Foundational" at 0.30 and 0.21 for the next two.
- **After `0caa68e` (bundle `main-BGY9a-V4.js`, 14:16 UTC 2026-09-13), in
  the user's own tab (previous bundle, server current):** a
  `POST /api/ec/strength/recompute` from the page recomputed 6 activities;
  `GET /api/ec/spike` then read the first-author review at achievement
  0.47, tier `tier_3_developing` (it was 0.00 and `tier_4_foundational`),
  with prestige still 0. The Course plan, reopened, showed "concepts solid
  (0.43)" beside AP Biology and AP Chemistry (exam 5s; the old bundle's
  wording — the new "AP exam 5 · concepts solid (chat read 0.43)" is
  pinned by `CourseSequencer.test.jsx`) and "admit ~9.2%" / "admit ~8%"
  on the verified lines. The Spike Finder panel showed its earlier data
  until closed with ✕ and reopened (it fetches on mount); reopened, the
  review's card read "Developing" with the lead score, which was 1.34 on
  the unscaled composite — scaled to 0–1 in `3c5f10b`.
- **After `58b28fb` (bundle `main-B9Hm9u2i.js`, 13:50 UTC 2026-09-13):**
  from the API, the 662-byte classic-xref PDF that answered 422 before
  extracted with its text (200); `/api/narrative/drift` carried
  `status "no_active_narrative"` for a fresh account; a bracketless
  file preface plus a bracketless context appendix naming FAFSA classified
  as `coaching` with `attachmentTurn true` and no regulated limitation or
  action. In the user's Chrome tab (still on the previous bundle, which
  strips the brackets), the same PDF attached through the 📎 picker with
  a 200 from the extractor and a chip, and "What does this PDF say?"
  was answered from the PDF's text (the AIME qualifier line) with no
  "Limitations / Next actions" block; the account's own drift status
  read `all_fresh`. Before the fix in the same tab: TXT and PNG attached
  and were answered (the PNG through OCR), the PDF failed with 422, and
  both answered turns carried "Limitations … Next actions: StudentAid.gov".
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

- **Five records carry no C1 counts** (College of the Holy Cross,
  New College of Florida, Occidental, Trinity College, Kansas — Kansas uses
  its own template, "Section A1. General Information …"), so their admit
  rate comes from the IPEDS baseline while their SAT bands and C7 come from
  the CDS. Dump their C1 region with `extractItems` + `groupByLine` and
  add the layout to `extractC1Counts` with a case in
  `cds-c1-counts.test.js`.
- **Sections the reader misses on some documents:** Harvard's class-size
  table (its "CLASS SECTIONS" label is split across lines), Indiana's
  headcount ("Total undergraduate", numbers on the next line) and
  retention (the value sits several lines below the question), and the H2
  "average percentage of need met" on the PDFs whose values sit in a
  separate column (Harvard, Stanford, JHU, Indiana read no `needMetPct`;
  the workbooks do). `sections-check`-style spot reads: parse a document
  with `parseCDSPositional` and print `extras`.
- **104 records carry no C7 weights** (the school's document has no
  readable grid or labelled rows), so their priorities matrix falls back
  as before; and 44 carry no SAT band (test-blind schools among them).
- **Cycles still behind:** Columbia has no 2025-26 link (its 2024-25
  record validates `ok`); Caltech (2023-24), Northwestern and UChicago
  stay on the newest cycle the scrape offers; the page-only 2025-26 links
  (Brown, MIT, Penn, UVA, Wisconsin, Purdue, Michigan State, Georgetown)
  fall back to the newest Drive copy. Brown's committed record has no
  `yearLabel` (the 2023-24 document; the refresh hit `scope_mismatch`).
  Penn's tracked "2023-24" PDF holds fall-2024 figures; its record is the
  2024-25 document now anyway.
- **JHU needs a hand-fetched document each cycle.** Cloudflare on
  `oira.jhu.edu` returns 403 to Node's fetch (any user agent, referer or
  accept header); curl with a Chrome user agent, a referer and
  `Accept: application/pdf` gets the PDF. The daily refresh keeps the
  stored 2025-26 record (`kept_newer`), so nothing regresses, but a
  2026-27 JHU document will need the same manual fetch into
  `backend/data/cds-cache/pdfs/<slug>.<cycle>.pdf` (and the tracked
  folder) before a run.
- **`scripts/refresh-cds.mjs` fails on this machine** ("no such column:
  class_rank_json": the local `backend/data/counselor.db` predates the
  schema). The refresh was run against a scratch database instead — see
  *Quick verification recipes*.
- **Re-parsing older documents moves a few counts slightly** (Caltech
  13,847 → 13,856 applicants, Michigan State and Northwestern by tens):
  rows the old reader skipped. The registry truths cover rates only.
- **Rendering of the new sections:** they reach the model's VERIFIED
  DATA block only; the fit card and the values matrix do not show costs,
  wait list, transfer or class size yet. `CalibratedFitCard.jsx` reads
  `provenance`/`parsed`; the sections would come through
  `cdsRecordToPositioningResult` (`extras` is on the record).
- **`tools/cds-validator.js`** is an older duplicate of the root
  `cds-validator.js` and was left untouched.
- **pdfjs returns only text inside the page box.** The probe PDF's one
  line runs past the 612-point page width and came back cut at "…and
  qu"; pdf-parse returned the whole string. Real documents wrap, the
  `hello.pdf` fixture and the CDS PDFs extract in full, and the inline
  test uses a line that fits. If a student's PDF ever reads as cut off,
  the second reader (pdf-parse) is still there to fall back to
  explicitly.
- **Tier floors still require leadership ≥ 0.2 for "Developing".** With
  `0caa68e` the first-author review reads Developing, but a solo
  competition entry (National History Day at achievement 0.55, prestige
  0.3, leadership 0) stays Foundational because `computeTierLabel`'s
  floors cover dedication, achievement, leadership, major spike and
  narrative fit. If solo work should be able to read Developing, drop
  leadership from `floors` in `ec-strength-vectorizer.js` and add a test.
- **Strength rows recompute only on sync or the recompute route.** The
  new achievement rule (versioned into the factor cache) reaches a
  student's rows at their next profile save or `POST
  /api/ec/strength/recompute`; the tier rule applies at read time already.
  The user's own account was recomputed on 2026-09-13 from the page.
- **The Spike Finder panel fetches on mount and when the target-school
  list changes,** so a recompute made while it is open shows only after
  ✕ and reopen (or a reload). The spike route's model re-rank took 94 s
  and 120 s (the client's cap) on the user's account with five targets and
  three panels open at once; with one panel per open (`9ec5edc`) that
  should ease, but the re-rank's own latency was not looked into.
  `CourseSequencer` and the calendar read got the same `tunedForRef`
  treatment in `3a8fdc3`; `CandidateRanker` fetches only on clicks.
- **Tool panels open inline in the chat column** (Course plan, Spike
  Finder, story editor) with a ✕ but no keyboard close; Escape did not
  close the story editor.
- **The Chrome tab reports a 108×50 viewport when the window is
  minimized**, and screenshots time out then; DOM reads keep working.
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

Refreshing the CDS cache without the local database (the way the
2026-09-16 refresh ran): in a scratch folder, open a fresh SQLite file
with `better-sqlite3`, `initRAGTables(db)` and
`prepareRAGStatements(db)` from `rag-engine.js`, take the names from
`getRepositoryIndex()`, run `ingestBulk(stmts, names, { concurrency: 3,
year: "2025-26" })` from `cds-ingest-pipeline.js` (downloads land in
`backend/data/cds-cache/pdfs/`, cached by slug and cycle), then for each
result whose status is ok / consistent / discrepancies / ok_with_overrides
write `{ source: "cds", extractionMethod, ...loadValidatedRecord(stmts,
slug), validation: { school, slug, status, discrepancies, overrides,
scopeFromPDF } }` (from `loadLatestValidation`) to
`tools/cds-cache/parsed/<slug>.json`. Review the summary by status and
cycle, scan for implausible counts (applied under 300, admitted above
applied, a rate outside 2–99%), compare the previously committed records
for lost fields, and run `npm test` before committing the parsed
directory with explicit paths. A single school: the same with one name.

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
