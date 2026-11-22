# Session handoff

One current document for whoever picks this repository up next, written for
a reader with no access to the conversation that produced it. Read
`CLAUDE.md` first (the edit-time harness); `RUNBOOK.md` is the operator
sheet. Long forms of older entries: `git show 350f9e6:SESSION-HANDOFF.md`
(2026-11-04), `ef3a323` (2026-10-09), `7df4c1a` (2026-10-08), `6d9bac1`
(2026-09-20 to 24), `812cdeb` (2026-09-16 and earlier).

## Where things stand (2026-11-22)

- **Deployed:** production runs `1561fd8` (the #6 merge). On 2026-11-22 its
  `/` served `assets/main-9lhtNdfj.js`, the same hash as a local build of
  `1561fd8`, and `/api/health` answered ok. CI for that push passed.
- **Open, not merged:**
  [#7](https://github.com/jungwonmoon1018-garden/college-counselor-web/pull/7)
  from `ops/mock-run-2026-11-22`: `d6d76d9`, `a8bf703`, `5d15c20` plus this
  file. Its CI had not reported when this was written. Auto-fix is on for it
  in the desktop app; auto-merge is off. Merging it deploys a frontend and
  backend change (the `main-*.js` hash in `/` changes).
- **Tests on #7's head, after the last code edit (Node 25.9):**
  - backend: 1,158 tests, 1,154 pass, 4 skipped, 0 fail; lint 0 errors,
    38 warnings; `node --check server.js` clean;
  - frontend: 56 files, 421 tests; `npm run build` clean.
- **Working tree:** clean on `ops/mock-run-2026-11-22`. The main checkout
  (`Downloads\college-counselor-web`) sits on the merged
  `ops/chancing-ap-2026-10-09` and was not touched.
- **Standing authorizations from the user:** push straight to `main`;
  create and delete throwaway `probe-*@example.test` accounts on
  production. Never ask for or use the counselor's or a real student's
  credentials.
- **Deferred by the user (2026-09-07):** the University of Wyoming College
  Fit data-source precedence: "Wait, the wyoming is not answering. I think
  that it would be ok for that to be dealt with that later." Do not pursue
  until asked.

## What changed, newest first

The user's ask on 2026-11-22, verbatim: "fix the problems after a mock run".
No mock-run output of theirs existed, so the session made one: the
production-parity stack (`prod-parity.mjs`, then `web-launcher.mjs`) with
the model, Scorecard and CDS hosts mocked inside the server, driven in a
browser as three throwaway students. Mid-run the user supplied a real
four-year transcript PDF "to model the course list"; it went through the
survey's import on the parity stack only, and every copy was deleted. None
of its content is in the repo or the commits.

**A transcript's identity fields stay off the model provider** —
`d6d76d9`. The import sent the provider the student's name, ID number,
date of birth, the school's +82 phone and Korean street address, and the
counselor's name; only emails were masked, and chat attachments use the
same redactor. `chat/content-moderation.js` now masks labeled identity
fields in English and Korean (value masked, label kept), Korean resident
numbers, international and Korean phone numbers, and Korean road
addresses; bare labels count only at a line or column start. The
student's registered name (`storage/pii-vault.js`
`studentNamesForRedaction`) is masked in any form on the transcript import
and every chat turn. Pinned both ways in `provider-redaction.test.js` and
by a route test of both wires.

**An imported transcript reads as the student's record** — `a8bf703`.
Semester rows name their term (survey chips, sidebar); the import note,
welcome, sidebar and quick replies count courses as the survey total does;
an ungraded row from a finished year is saved without a grade, not "in
progress" (`profile/transcript-utils.js`); "Calculate GPA from courses"
asks before replacing a saved GPA, showing both values
(`profile/gpa.js`); the quick questions follow the student's year, major
and language (`chat/quick-prompts.js`).

**College Fit's CDS fallback in the card's language** — `5d15c20`. The
fallback rows carry `factor`, `tier` and `cdsYear` (the English theme stays
the fit matrix's matching key); `CalibratedFitCard.jsx` translates them.

**2026-11-03/04 (#6, merged as `1561fd8`):** a 102-finding audit fixed in
waves: crisis replies and the shared lexicon fixture, request-not-keyword
screens, fidelity by sentence, College Fit without hidden defaults, chat
error codes, profile revisions and erasure, calendar-date deadlines, scout
backoff. Judgment calls made for the owner (Korean crisis lines 109, 1388,
119, 112; Feb 1 planning pivot; 60 chat calls a minute) are listed in
`git show 350f9e6:SESSION-HANDOFF.md`.

**Earlier:** 2026-10-09 (#5) chancing realism, stated test policy, AP
names; 2026-10-08 (#4) sync checks, save failures; 2026-09-23 and earlier
the full policy sweep, the likelihood label, OCR, the folder
reorganization.

## Verified live, and not

- **Verified on 2026-11-22, on the parity stack (mocked model):** each fix
  above in the browser after the change: the import wire held none of the
  seven identifiers, with a registered name that did not match the
  document; term labels, counts, the N/A row, the GPA question (cancel
  keeps the saved GPA), Korean chips and the Korean CDS rows. Account
  deletion leaves old tokens and fresh sign-ins at 401.
- **Not verified:**
  - CI on Node 22.22 for #7 (pending when written);
  - production after #7 (not merged, no production probe this session);
  - the redaction against a real provider: on production the wire cannot
    be read, so it rests on the route test and the parity capture;
  - the first-boot memory and scout status after #6 (still unchecked on
    `/admin.html`).

## Open items and things to watch

- **Merge #7 once CI is green**, then the live probe below.
- **Redaction edges:** an unlabeled name in a header the student did not
  register under (only labels and the registered name are masked); a city
  and postal code line stays; one-word Latin registered names are never
  masked alone, by design.
- **Locale residual:** College Fit's evidence line "Course rigor: …" is
  still English on a Korean card.
- **Idea, not done:** the mock-run harness (a fetch mock that answers the
  client's gatekeeper, validator and screener) could live in the repo as a
  script; it was rebuilt from scratch this session (recipe below).
- **Carried from 2026-11-04:** crisis lexicon residuals ("volunteered at
  the crisis text line but now I need the suicide hotline number" reads as
  a topic); fidelity residuals (dash-separated stats lists, "target T20
  schools"); not built by the owner's call: Korean login, create-account
  and survey, a GPA-scale field, a grade editor, a consent-withdrawal
  control, "snoozed until"; residency (plan in `ef3a323`); future AP
  aliases; unreadable tracked schools; two 2026-09-07 probe accounts on
  production; JHU's manual CDS fetch.
- **Graph and vault:** last rebuilt 2026-09-22; refresh with
  `/graphify . --update`, then the vault export. Never touch the six
  hand-written notes.

## Quick verification recipes

**Gates:** `cd backend && npm ci && npm test && npm run lint && node --check
server.js`; `cd frontend && npx vitest run && npm run build`. Stop any
parity stack first: `simulations-endpoint.test.js` pins its sidecar to
port 3102.

**Mock run:** `node ~/.claude/skills/collegeapp-ops/scripts/prod-parity.mjs
--students-open`, then start the printed launcher command with
`NODE_OPTIONS=--import=<file>` where the file imports
`backend/tests/helpers/mock-openrouter-fetch.mjs` and then wraps
`globalThis.fetch`: for chat completions whose system text holds "safety
gatekeeper" answer `{"category":"safe_multi","route_to":["college"]}`, "You
validate responses" answer `{"passed":true}`, "content safety screener"
answer `{"safe":true}`, and anything else a short prose plan. Add
`openai/gpt-5.6-luna` to the mock catalog or the large tier reports
not_in_catalog. Clean up with `prod-parity.mjs --clean`.

**Live probe after #7** (Node 22+, requests about 2.6 s apart):
1. Register `probe-…@example.test` (grade 12), grant the three consents.
2. `POST /api/students/transcript-import` with `{text: "<invented
   transcript with Name:, Student ID Number:, Date of Birth:, two semester
   rows and an N/A row>"}`. Expect 200, the courses, and the note "one from
   an earlier school year is saved without a grade".
3. The 2026-11-04 crisis and enhanced-ACT checks still apply
   (`git show 350f9e6:SESSION-HANDOFF.md`).
4. `DELETE /api/students`; the token then answers 401.

**Deploy markers:** the `assets/main-*.js` hash in `/` changes when
`App.jsx` or its imports change. A backend-only deploy shows only as a
brief `/api/health` outage.

## Tooling notes

- **Bash tool and backslashes:** `node -e` and heredocs fed to `node -`
  mangle `—`, `\s` and friends; edit with the Edit tool, and write
  scripts and commit messages with the Write tool. A quoted `<<'EOF'`
  heredoc appended to a file kept backslashes intact.
- **Browsers:** the in-app browser cannot attach a local file; Chrome's
  `file_upload` can, from the session's scratchpad only. React-controlled
  checkboxes ignore `form_input`; click them. A closed sidebar drawer
  swallows clicks; call the button's `.click()` from page script. Stub
  `window.confirm` before triggering a confirm, or the page blocks.
- **PDF reading:** no Python PDF library here; xpdf's `pdftotext -table`
  keeps two-column transcript rows aligned where `-layout` does not.
- **Real documents:** keep them out of comments and fixtures. This
  session's first draft used a real transcript's name, ID and address as
  "examples" in code comments; they were caught by grepping the diff
  before commit.
- **Commits:** stage explicit paths; end messages with the trailer the
  environment gives (this session: `Co-Authored-By: Claude Opus 5.5
  <noreply@anthropic.com>`).
