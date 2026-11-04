# Session handoff

One current document for whoever picks this repository up next, written for
a reader with no access to the conversation that produced it. Read
`CLAUDE.md` first (the edit-time harness, updated in `7b6d46c`);
`RUNBOOK.md` is the operator sheet. Long forms of older entries:
`git show ef3a323:SESSION-HANDOFF.md` (2026-10-09), `7df4c1a` (2026-10-08),
`6d9bac1` (2026-09-20 to 24), `812cdeb` (2026-09-16 and earlier).

## Where things stand (2026-11-04)

- **Deployed:** production runs `3647a5f` (the #5 merge). On 2026-11-03 its
  `/` served `assets/main-k0U-9Lqf.js`, the same hash as a local build of
  `3647a5f`, and `/api/health` answered ok.
- **Open, not merged:**
  [#6](https://github.com/jungwonmoon1018-garden/college-counselor-web/pull/6)
  from `claude/tech-debt-stability-3ac129`: 31 commits `648a775`..`7b6d46c`
  plus this file. Its CI had not reported when this was written. Auto-fix
  is on for it in the desktop app; auto-merge is off.
- **`main` cannot deploy as it stands:** new high advisories (multer,
  body-parser, qs; vite, undici) fail CI's `npm audit --audit-level=high`
  on any push to `main`. `1bc2f11` on #6 fixes them (lockfiles only).
- **Tests on #6's head, after the last code edit (Node 25.9):**
  - backend: 1,152 tests, 1,148 pass, 4 skipped, 0 fail; lint 0 errors,
    38 warnings; `node --check server.js` clean;
  - frontend: 55 files, 409 tests; `npm run build` clean;
  - `npm run build:web`, `node --check backend/web-launcher.mjs` and both
    high-level audits clean.
- **Standing authorizations from the user:** push straight to `main`;
  create and delete throwaway `probe-*@example.test` accounts on
  production. Never ask for or use the counselor's or a real student's
  credentials.
- **Deferred by the user (2026-09-07):** the University of Wyoming College
  Fit data-source precedence: "Wait, the wyoming is not answering. I think
  that it would be ok for that to be dealt with that later." Do not pursue
  until asked.

## What changed, newest first

The user's ask on 2026-11-03, verbatim: "identify tech debts, bugs and
potential issues to the users and fix them in a way that are stable in
long-term like missing data, rules engine rejections and more". An audit
(nine finders, each verified by a second agent trying to refute it) kept
102 of 104 findings. They were fixed in three waves, a five-lens pre-merge
review found 24 more on the branch itself, and those were fixed and
rechecked. Each commit message gives the behavior and the reason.

**Judgment calls made for the owner, for review:**
- Korean crisis lines are 109, 1388, 119, 112, then the US lines; 1393 and
  1577-0199 are dropped because Korea folded its lines into 109 in 2024.
- No GPA and no SAT/ACT gives "Not enough data yet" instead of a label.
- The grade advances on Aug 1 from a stored graduation year (`class_of`),
  and the budget cap follows it (a junior becomes a senior at 15 USD).
- The planning cycle pivots on Feb 1.
- No 2027-28 FAFSA ruleset: its Volume 1 was unpublished on 2026-11-03.
- Chat is limited to 60 calls a minute per student, 300 per IP.
- Consent can be revoked through the API, but there is no UI control.
- Retention also removes thread memory.
- Suicide named as a topic is answered with the footer; a third party's
  attempt and weak ideation stay crisis.

**Crisis** — `648a775`, `d5034b0`, `364bf48`, `83be86b`.
- The server reply (`buildCrisisChatReply`) carries every line in the
  answer text, in the student's language. The client ends the turn on it
  from any call carrying the student's words, and keeps the draft when it
  comes back on the validator or supervisor.
- Both lexicons are built from shared fragments, held equal by
  `crisis-lexicon-parity.test.js` and `tests/fixtures/crisis-lexicon-cases.json`
  (about 250 cases, English and Korean).
- Asking for a crisis line is a crisis; describing one as an activity is a
  topic answered with the footer. The footer also rides on any failed turn.

**Screens and fidelity** — `2aac527`, `e9d27e3`, `11353a6`, `e248196`,
`f097805`.
- Ghost-writing, dishonesty and credential screens refuse requests, not
  keywords (essay coaching, "What is an FSA ID:", 원 incomes pass).
- The provider redactor keeps achievement amounts but masks family income
  and possible names.
- The fidelity check reads a value as the student's only when the sentence
  ties it to them, checks every listed item and Korean replies, and knows
  the grade level.

**College Fit** — `3708e5f`, `87dc037`, `d377bae`.
- No hidden defaults: a blank major is not CS; an unknown admit rate or
  test policy is said to be unknown.
- A dead CDS index degrades instead of 500ing, and degraded reads are not
  cached.
- Card and matrix share `server/fit-context.js`. The card reads in Korean.
- `positioning_v3`; `CDS_PARSER_VERSION` 8 (an unread policy is null).

**Chat reliability** — `ead3b28`, `a1fb3ed`, `ceb13b3`.
- Every error carries a code with English and Korean copy, held by
  `chatglue-error-contract.test.js`.
- An empty reply is retried once. An upstream 401 is a 502
  `provider_auth_failed`, never a session expiry.
- `mode: "utility"` marks JSON calls. Closing the page aborts the call and
  its on-demand reads. A failed turn keeps its draft.

**Student data** — `e56e3ab`, `bb753d4`, `fc9d3f1`, `0fc1855`, `10113e5`.
- Profile revisions, with a 409 on a stale save, so a stale device cannot
  overwrite.
- Unchanged syncs store nothing, and snapshots compact to 50 per student.
- Erasure covers every table, the sidecar and the narrative-fit cache.
- The export decrypts what it seals.
- Logout, expiry and delete remount the student tree (`end-session.js`).

**Input, deadlines, scouts** — `7325b1d`, `f5b09f8`, `59dc4bf`, `00e61da`,
`621bb69`, `fbae357`, `4692379`.
- Accepted now: the enhanced ACT, the TOEFL 1-6 band, PSAT 8/9, both
  semesters, Korean records and the two new AP courses. Set-asides are
  named per entry.
- Deadlines are calendar dates (overdue after Anywhere on Earth).
  Reminders follow the student's own cycle; snoozes wake.
- A model in use is never pruned (`MODEL_SCOUT_VERSION` 3). Empty runs
  retry with a backoff. `SCOUT_VERSION` is 6.
- FAFSA rulesets are kept by award year and warn 60 days out. Mojibake is
  repaired, and `backendglue-source-encoding.test.js` guards against more.

**Earlier sessions:**
- 2026-10-09 (#5): chancing realism (`c4d0a59`, `e8203f9`), stated test
  policy (`fbcbf58`), AP names (`12278ad`), deadline limits, origin
  allowlist.
- 2026-10-08 (#4): sync checks, save failures, story delete.
- 2026-09-23 and earlier: full policy sweep, the likelihood label, OCR, the
  folder reorganization.

## Verified, and not

- **Verified on 2026-11-03/04, locally:** the gates above. Every fix has a
  test, and the review's findings were re-run against the final code by a
  separate agent.
- **Not verified:**
  - CI on Node 22.22 for #6 (pending when written);
  - production (nothing deployed, no probe account used);
  - a production-parity boot (`prod-parity.mjs` was not run this session);
  - the first boot's memory, with a sweep, a catalog check and the CDS
    re-parse all due;
  - the Korean screens in a browser.

## Open items and things to watch

- **Merge #6 once CI is green**, then run the live probe below and watch the
  first boot's `[MEM]` lines and the scout status on `/admin.html`.
- **Crisis lexicon residuals.** Both directions still show the lines, but
  they are worth a fixture case each if they come up:
  - a request after an activity clause in one sentence is a topic ("I
    volunteered at the crisis text line but now I need the suicide hotline
    number");
  - activity phrasings after "is there / do you know" that the activity
    list lacks ("lets high schoolers volunteer", "looking for volunteers");
  - "I need the suicide hotline's volunteer form" reads as crisis.
- **Fidelity residuals:** a dash-separated stats list is not checked;
  "target T20 schools" (a capital after target) is read as a noun.
- **Not built (the owner's call):**
  - Korean coverage of the login, create-account and survey screens;
  - a GPA-scale field (an unweighted GPA over 4.0 now reads as an unknown
    scale);
  - a grade editor;
  - a consent-withdrawal control;
  - "snoozed until" on the tracker.
- **Carried:**
  - residency (plan in `ef3a323`);
  - each future AP course and alias;
  - unreadable tracked schools;
  - two 2026-09-07 probe accounts on production;
  - JHU's manual CDS fetch;
  - the small tier's empty replies (now retried once).
- **Graph and vault:** last rebuilt 2026-09-22. This branch adds about 40
  modules. Refresh with `/graphify . --update`, then the vault export.
  Never touch the six hand-written notes.

## Quick verification recipes

**Gates:** `cd backend && npm ci && npm test && npm run lint && node --check
server.js`; `cd frontend && npx vitest run && npm run build`; CI adds both
audits and `build:web`.

**Live probe** (Node 22+, a scratch `.mjs`, requests about 2.6 s apart):
1. Register `probe-…@example.test` (grade 11) and grant the three consents.
2. `POST /api/chat` with "I need the suicide hotline number" and a fresh
   `request_id`. Expect 200, `crisisSafe: true` and 988 in the answer. With
   `X-CollegeApp-Locale: ko`, expect 109. No model call is billed.
3. `POST /api/students/sync` with an enhanced ACT
   `{test:"act", sections:{english:30, math:31, reading:32}}`, then
   `GET /api/students/profile`. Expect it stored, and a `revision`.
4. `POST /api/positioning/targets` for a school with no GPA and no test on
   a fresh probe. Expect labelKey `insufficient_student_data` and
   `positioning_v3`.
5. `DELETE /api/students`; the token then answers 401 `session_invalid`.

**Deploy markers:** the `assets/main-*.js` hash in `/` changes (`App.jsx`
changed). A backend-only deploy shows only as a brief `/api/health` outage.

## Tooling notes

- **`npm run build:web` strips the backend's dev dependencies** (`npm ci
  --omit=dev`). Afterwards `npm run lint` fails with "eslint is not
  recognized"; run `npm ci` in `backend/` again.
- **Parallel agents** worked well on disjoint file ownership in one
  worktree, with cross-file requests applied afterwards and one commit per
  theme. A network drop ends a workflow with no partial results; agents
  that read for an hour before editing lose everything, so tell them to
  edit and test finding by finding.
- **Regex lexicons drift at the edges.** Grow them through the shared
  fixture in both directions, never by one-off patches.
- **Dates in tests:** use `tests/helpers/fixed-clock.mjs`. SQLite's
  `datetime('now')` is not moved by it, so compute expiries relative to now.
- **Bash quoting:** the Bash tool mangles backslashes in `node -e`. Write
  scripts and commit messages with the Write tool.
- **Commits:** stage explicit paths and end messages with the `CLAUDE.md`
  trailer. A UI test that passes alone but times out in the full run is
  queueing: give it the 20 s allowance with a note.
