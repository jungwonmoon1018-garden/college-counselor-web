# Session handoff

One current document for whoever picks this repository up next — a person
or a fresh Claude session with no access to the conversation that produced
it. Read `CLAUDE.md` first: it is the edit-time harness (invariants, how to
prove a change, how to land it). This file says where things stand, what
changed recently and why, what was verified live, and what is open.

## Where things stand (2026-09-06)

- **Deployed:** `main` at `0cf696c`, live at
  https://college-counselor-web.onrender.com. Render deploys after GitHub
  Actions CI passes; the deploy was confirmed (CI green, new student bundle
  `main-C77xLMj6.js` served, behavior probed with a throwaway account).
- **Tests:** backend `npm test` 642 tests, 637 pass, 5 skipped, 0 fail;
  frontend `npx vitest run` 25 pass; `npm run lint` 0 errors, 70 warnings
  (the CI cap is 500).
- **Working tree:** clean apart from the repository's dozens of phantom
  CRLF-only diffs (never stage them) and one untracked file,
  `backend/kor.traineddata` — a Tesseract Korean model that appeared during
  the OCR work. It is not committed; delete it or leave it.
- **Standing authorizations from the user:** push straight to `main`; create
  and delete throwaway student accounts on production for live checks.
  Never ask for or use the counselor's password or a real student's.
- **Deferred by the user:** the University of Wyoming College Fit data-source
  precedence ("Wait, the wyoming is not answering. I think that it would be
  ok for that to be dealt with that later"). Do not pursue until asked.

## What changed, newest first

Each item names the commit that carries it. Earlier sessions' work
(profile grounding, the policy scout, the fit double-check) is summarized
at the end.

**Seven review fixes (2026-09-06)** — `0cf696c`, one commit. (1) Deadlines:
`POST /api/calendar/context` reads a school's own pages on demand
(`scoutSchoolOnDemand`) before the optional model research; the client's
`createDeadlinesForSchool` titles any typical-cycle fallback
"(approximate — verify)" and its note says it is a planning window, while
page-read dates cite the page. (2) Signup privacy footer rewritten to
describe browser-side vault encryption, server storage, redaction and
OpenRouter processing. (3) A `blocked: true` 400 from `/api/chat` (essay
ghostwriting) is shown as the counselor's reply, not "Something went
wrong". (4) Add-activity default category is `academic` (was the legacy
`club`, which saved as "Other Club/Activity"). (5) i18n strings no longer
name API endpoints (test forbids `POST /api`); `DriftBanner` takes
`refreshKey` (bumped on narrative save) and a "Write your story" button.
(6) `composeAnswer` takes `questionText` and attaches the official-source
follow-up action only when the question concerns that sub-intent's domain
(`questionConcernsSubIntent`); the upload priming sentence is stripped
before classification. (7) The EC re-rank is bounded at 30 s
(`EC_RERANK_TIMEOUT_MS`, `rerankNote` on the response); `ccFetch` has a
45 s default timeout (`timeoutMs` per call; 60 s rank, 120 s model tools);
the ranker shows elapsed seconds and a Retry button. Four files
(`backend/i18n.js`, `candidates-and-deadlines.test.js`,
`CandidateRanker.jsx`, `DriftBanner.jsx`) were among the phantom-CRLF files
and got normalized to LF in this commit; the diff is large but content-wise
small.

**Chat latency and context rot (2026-09-06)** — `d292cb4`, `5fb313e`,
`15a2643`, `6e4a4ec`. Four commits, in order:

1. *Timings.* `POST /api/chat` returns `_meta.timings` (`classify`,
   `on_demand_read`, `attachments`, `context`, `model`, `fidelity_retry`,
   `total`, in ms) and logs one `[CHAT] timings {...}` line per turn; the
   client pipeline logs `[chat timing] {...}` (`quick_query`, `gatekeeper`,
   `upload_screen`, `specialists`, `supervisor`, `refusal_retry`,
   `validator`, `total`) and puts `timings` on the orchestrate result.
2. *Chain cut* (client, `orchestrateStages` in `frontend/src/App.jsx`). The
   `/api/agents/orchestrate` pre-flight is gone (`/api/chat` runs the same
   router and deterministic answers). Multi-route now needs an explicit
   conjunction AND two keyword families (it fired on any "and"/"plan").
   The LLM validator runs only when a deterministic read of the draft finds
   guarantees/predictions, medical-financial-legal advice, overclaiming,
   conduct or grooming signals, an unsourced statistic, an essay turn, an
   attachment, or a non-`safe_*` category; everything else returns as
   drafted (the server still screens every answer).
3. *Prompt order* (server). System prompt is now fixed rules → specialist
   prompt → STUDENT PROFILE → THREAD MEMORY → regulated prefix → VERIFIED
   DATA, most-static first, so the adapter's `cache_control` on the system
   message (and providers' automatic prefix caching) can hit. Pinned in
   `council-naming-deadlines-routes.test.js`.
4. *Thread graph* (`backend/chat-graph.js`, tables `chat_graph_facts` and
   `chat_graph_edges`). When an assistant turn is persisted through
   `POST /api/students/threads/:id/messages`, the preceding question plus a
   ≤420-char excerpt of the answer become one fact (encrypted with the
   chat-history key), linked to schools (`detectSchoolMentions`), plans,
   the student's recorded activities, topics, the classifier intent and an
   attachment name. No model call. `/api/chat` detects the entities in the
   new question, pulls up to 6 matching facts (≤2400 chars), drops facts
   already in the verbatim history, and renders a THREAD MEMORY block
   (`_meta.threadMemory` = count). A new thread with no match recalls the
   two latest facts. Hard-deleting a thread forgets its facts; account
   erasure removes them (both tables carry `student_id`). The client sends
   3 exchanges verbatim (was 6) and 2 short memory excerpts (was 4 full
   answers). Side fix: "AP Calculus BC" no longer links Boston College.

**Official-source gate sensitivity** — `e737f62`, `a02ff77`, `3b833b8`.
The regulated / high-stakes patterns in `backend/policy-router.js` fired on
ordinary counseling words ("legal studies", "school records", "am I
eligible for Princeton", "early decision", "how much time", "scholarship")
and the hard no-source rule refused every deadline or statistics question
without verified evidence, strategy questions included. Now the patterns
need the regulated sense, and `enforceGates` refuses only a *pure lookup*
(`isLookupQuestion`: an exact date or figure asked without strategy,
comparison or explanation words) about a *named* school for which nothing
is held — and only after the chat route has read the official source on
demand: the school's own admissions pages through `scoutSchool` (snapshot
kept for later turns) for dates, the College Scorecard for statistics
(answered deterministically with its source). What remains is an honest
message with the typical deadline window and a pointer to the official
page. A cached deadline record no longer short-circuits strategy questions;
"holding data" is judged per lookup (an IPEDS row does not count for a
deadline question); the dates answer says when the plan asked about is not
on the pages read; a school known only through a scouted snapshot now
reaches the VERIFIED DATA block. The high-stakes system prompt in
`orchestration-engine.js` no longer tells the model to refuse.

**Edit harness** — `e737f62`. `CLAUDE.md` rewritten around the current
pipeline; `backend/docs/HANDOFF.md` points at it.

**Admin picker and scout cadence** — `64c6520`, `4f993d3`. Each tier
dropdown in `frontend/src/AdminApp.jsx` now has a "Reviewed models" group
plus one "Found by the scout" group per price band, and a panel below
shows the last and next check, every candidate with price / context /
dates, Dismiss / List again, and "Check the catalog now"
(`POST /api/admin/models/scout/run`). Korean copy for the models section
added. Both automatic scouts moved from 24-hour timers to one persisted
two-week cadence (`backend/scout-cadence.js`, `SCOUT_CADENCE_DAYS`
overrides): an hourly job and a boot hook compare the last completed run
in the database with the cadence. The catalog scout prunes rows a run no
longer confirms (dismissals kept) and carries `MODEL_SCOUT_VERSION`; a
version bump forces one run at the next boot, which is how production's
stale ":batch" rows were cleared.

**Model-catalog scout** — `34e366f`, `f985290`. `backend/model-catalog-scout.js`:
trusted providers, text in/out, ≥32k context, priced, released within a
year, no ":suffix" / preview / safety variants; price bands ≤$1 small,
≤$6 medium, else large; newest 15 per band in the picker; every listed id
passes the adapter allowlist; tier defaults never change on their own.

**Crisis gate** — `209335b`, `f985290`. Server lexicon (`PATTERNS.crisis`)
and client lexicon (`frontend/src/crisis-lexicon.js`) trigger on
first-person safety statements only; a model "crisis" call needs lexicon
corroboration; ordinary stress gets the 988 footer and a normal answer.
Verified live: essay-ending, ER volunteering and "hopeless at chemistry"
questions answered normally; "I want to end my life" still returns the
crisis resources.

**Uploads and transcripts** — `fdfb517`, `aca3525`. The client no longer
truncates uploads (`sanitizeInput` 200k chars); document and image blocks
are inlined as extracted text with OCR fallback; a transcript import card
adds courses to the profile; AP exam scores are listed in the sidebar;
the classifier sees only the question, never the attachment or context
appendix; JSON utility calls skip the regulated gate.

**College Fit double-check** — `02c5256`, `1a4c823`. `backend/fit-verifier.js`
compares the inputs a fit read used against three live sources; the read
and its verdict are shared with the chat's VERIFIED DATA block.

**Earlier (2026-09-03 to 2026-09-04)** — profile grounding
(`backend/chat-grounding.js`: structured profile block, deterministic
fidelity check with one retry then a footnote, invented-course detection),
CDS source label, and the admissions-policy scout
(`backend/admissions-policy-scout.js`, `SCOUT_VERSION` 3) with deterministic
deadline answers from scouted snapshots.

## Verified live today, and not

Verified on production 2026-09-06 (second probe, throwaway account
deleted): a "write my whole college essay" turn returned 400 with
`blocked: true` and the coaching redirect as its message; `POST
/api/calendar/context` for Johns Hopkins University with `research: false`
came back in 12 s with `deadlinesSource: official_pages`, ED 2026-11-01 and
RD 2027-01-02 from https://apply.jhu.edu/ (financial aid and commit-by
not found on the pages read, so those two entries would be created as
"(approximate — verify)"); an EC ranking with a saved narrative returned in
6.2 s with `engine: llm`; the drift message after saving no longer names
an endpoint. Not verified in a browser: the ghostwriting reply rendering,
the approximate titles in the Deadlines tab, the ranker's elapsed counter
and Retry button, the drift banner refresh, and the category default.

Verified on production 2026-09-06 (first probe) with a throwaway account
(deleted): an assistant append returned `threadGraph: { factId, entities: 7 }`; a new
thread asking about Brown University's binding plan got
`_meta.threadMemory: 1` and the model recapped the earlier advice; the
same turn sent inside the verbatim history got `threadMemory: 0`; an EC
question recalled the fact through its activity/topic edges. Server-side
timings on those turns: `classify` 7–34 ms, `context` 2–118 ms, `model`
6.3–15.2 s, total within 160 ms of the model call — the model call is
essentially all of the server's turn time now. Not verified live: the
client-side `[chat timing]` line and the validator skip rate (both need a
browser session; watch the console on the next manual check).

Verified earlier (2026-09-05) with throwaway accounts (all deleted): the gate
cases above (Brown ED/EA strategy answered with scouted dates and source;
acceptance-rate strategy question answered; "legal studies" routed as
coaching; "When is NJIT's regular decision deadline?" triggered a live read
of njit.edu and answers "Early Action: 2026-11-15" plus the missing-plan
note; NJIT acceptance rate cited from IPEDS and the Common Data Set); the
crisis probes; the admin picker's grouped options and panel on a local
website-mode copy fed by the live OpenRouter catalog (431 models, 106
eligible: 23 low, 52 mid, 31 high).

Not verified: the production admin page itself (needs the counselor
password); Render's boot log lines (reading them needs the Chrome tool,
which blocks on a browser choice); the exact date of the next automatic
scout runs — read `GET /api/admin/policy-scout/status` (`nextRunAt`,
`cadenceDays`) and `GET /api/admin/models` (`catalogScout.nextRunAt`) as
the counselor.

## Open items and things to watch

- Johns Hopkins' pages also state January 15 (its Early Decision II date);
  the scout's deadline extraction knows ED / EA / RD / REA only, so ED II
  is neither scouted nor detected as an asked plan. Adding it touches
  `admissions-policy-scout.js`, `snapshotAsDeadlineRecord`, and the
  client's four-round deadline creation.
- The on-demand page read in `POST /api/calendar/context` adds up to 15 s
  per school (observed 12 s for JHU) the first time a target is added; the
  snapshot is reused afterwards.
- The StudentAid.gov follow-up fix is a relevance rule in the composer; the
  reviewer's exact biomedical / transcript questions could not be
  reproduced through the classifier, so if the footer reappears, capture
  the question text and add it to `answer-composer.test.js`.
- The model call is now ~99% of server turn time (6–15 s). The next real
  latency win is streaming the final answer, which conflicts with the
  post-hoc fidelity check, PII restore and validator; the workable design
  is "stream, then patch the footnote". Not started.
- The thread graph only links a school when `detectSchoolMentions` does:
  bare "Brown" or "Cornell" (no "University") is not an alias, so a fact
  about such a question links by plan/topic only. Adding bare names to
  `SCHOOL_ALIASES` would also change what the VERIFIED DATA block pulls in;
  decide deliberately.
- The validator skip is broader now. If a bad answer slips through, add
  the pattern to `RISKY_OUTPUT_TOKENS` / `OVERCLAIM_OUTPUT_TOKENS` /
  `CONDUCT_OUTPUT_TOKENS` in `orchestrateStages` rather than restoring the
  length rule.
- Facts accumulate one per assistant turn per student with no cap; a
  long-lived account could reach thousands of rows. Retrieval is indexed
  and bounded, so this is a storage question, not a latency one.
- On-demand page reads add up to 15 s to a pure deadline lookup about a
  school with no snapshot (bounded; the read finishes in the background).
- `LOOKUP_ASK_RE` / `GUIDANCE_RE` in `policy-router.js` are word lists. When
  a phrasing misroutes, add it to `policy-router.test.js` and extend the
  list; keep "decide/deciding" rather than "decid*" so "early decision"
  stays a lookup word.
- The dates answer's plan detection (`deadlinesFromResearchCache`) knows
  RD / ED / EA / REA; ED II is not detected as an asked plan.
- The policy scout's per-school on-demand read reuses `scoutSchool`, so it
  also logs a "change" the first time a school is read; that is expected.
- `backend/kor.traineddata` (untracked) — decide whether to keep it.

## Quick verification recipes

Route tests for the gate and the admin page:

```bash
cd backend && node --test tests/policy-router.test.js tests/admin-models-routes.test.js && node --test --test-name-pattern="no-source gate|old refusal|College Scorecard|pages read" tests/council-naming-deadlines-routes.test.js
```

Thread graph, prompt order and timings:

```bash
cd backend && node --test tests/chat-graph.test.js tests/chat-grounding.test.js && node --test --test-name-pattern="THREAD MEMORY|VERIFIED DATA block|profile and theme guard" tests/council-naming-deadlines-routes.test.js
```

Live gate probe with a throwaway account (Node 22, `BASE` is the site):

```js
const base = process.env.BASE, t = Date.now().toString(36); let token = "";
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: b && JSON.stringify(b) }); return { status: r.status, data: await r.json().catch(() => null) }; };
token = (await call("POST", "/api/students/register", { email: `probe-${t}@example.test`, password: `probe-${t}-correct-horse`, grade: 11, state: "CA", schoolDomain: "example.edu", majorInterest: "Computer Science" })).data.token;
for (const consentType of ["data_processing", "ai_interaction", "cross_border_transfer"]) await call("POST", "/api/consent/grant", { consentType, grantedBy: "student" });
await call("POST", "/api/students/sync", { profile: { gpa: { unweighted: 3.7 }, courses: [], testScores: [{ test: "sat", totalScore: 1380 }], apScores: [] }, activities: [], majorInterest: "Computer Science", goals: [] });
const turn = await call("POST", "/api/chat", { system: "You are the COLLEGE FIT specialist for students ages 14-18.", messages: [{ role: "user", content: "When is NJIT's regular decision deadline?" }], request_id: `probe-${t}-1` });
console.log(turn.data._meta, turn.data.answer);
console.log(await call("DELETE", "/api/students"));
```

Deploy markers: `/` carries `assets/main-*.js` (changes only with
`App.jsx`), `/admin.html` carries `assets/admin-*.js`; a backend-only
deploy shows only as a brief `/api/health` blip after CI succeeds.

Admin page on a scratch database (never production): build the frontend,
then from `backend/` run `web-launcher.mjs` with `PORT`, `SIM_PORT`,
`HOST=127.0.0.1`, a scratch `DATA_DIR`, `PUBLIC_DIR=../frontend/dist`,
`WEB_CONFIG_KEY` (32+ chars), `WEB_ADMIN_BOOTSTRAP_TOKEN` (24+ chars),
`WEB_COOKIE_SECURE=0`, `CDS_DAILY_REFRESH=0`, `POLICY_SCOUT=0`; the first
visit to `/admin.html` bootstraps a throwaway counselor with that token.
Delete the scratch `DATA_DIR` afterwards.

## Tooling notes for a Claude session on this machine

- Bash heredocs containing single quotes fail here; write node patch
  scripts with the Write tool and run them. The working directory can
  drift between calls — use absolute paths.
- Stage explicit paths only; commit messages end with
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- The in-app Browser pane can fill forms but screenshots are correct only
  at scroll position 0; for anything below the fold use headless Chrome
  (`npm i playwright-core` in a scratch folder,
  `chromium.launch({ channel: "chrome" })`, clip with page coordinates).
- Watch a deploy with a background loop over `gh run list --branch main`
  and the markers above; foreground `sleep` is blocked.
