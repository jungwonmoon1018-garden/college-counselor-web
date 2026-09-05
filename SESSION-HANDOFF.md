# Session handoff

One current document for whoever picks this repository up next — a person
or a fresh Claude session with no access to the conversation that produced
it. Read `CLAUDE.md` first: it is the edit-time harness (invariants, how to
prove a change, how to land it). This file says where things stand, what
changed recently and why, what was verified live, and what is open.

## Where things stand (2026-09-05)

- **Deployed:** `main` at `3b833b8`, live at
  https://college-counselor-web.onrender.com. Render deploys after GitHub
  Actions CI passes; every deploy today was confirmed (CI green, Render
  restart observed, behavior probed).
- **Tests:** backend `npm test` 632 tests, 627 pass, 5 skipped, 0 fail;
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

Verified on production with throwaway accounts (all deleted): the gate
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
