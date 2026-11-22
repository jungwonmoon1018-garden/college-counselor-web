# Session handoff

One current document for whoever picks this repository up next, written for
a reader with no access to the conversation that produced it. Read
`CLAUDE.md` first (the edit-time harness); `RUNBOOK.md` is the operator
sheet. Long forms of older entries: `git show 350f9e6:SESSION-HANDOFF.md`
(2026-11-04), `ef3a323` (2026-10-09), `7df4c1a` (2026-10-08), `6d9bac1`
(2026-09-20 to 24), `812cdeb` (2026-09-16 and earlier).

## Where things stand (2026-11-22)

- **AI calls fail in production — the owner's to fix.** After the #7
  deploy, every model call answered 502: the chat route reports upstream
  404 from OpenRouter in about 200 ms (`provider_error`), and the
  transcript import `http_error`. The packaged tier defaults are still in
  OpenRouter's public catalog, so the likely cause is the model chosen on
  `/admin.html` or the OpenRouter account's provider or data settings
  leaving no endpoint. Not known whether it began before the deploy: no
  model call was made against production earlier in the session. The
  crisis reply, registration, consents and erasure work (they make no
  model call).
- **Deployed:** `main` at `b316183` (identity-redaction follow-up) on top
  of the #7 merge `a8107a4`. The #7 deploy was confirmed by `/` serving
  `assets/main-DVxEdzW0.js`, the hash of a local build of the merged
  frontend; `b316183` is backend-only (see "Verified live").
- **Tests on `b316183` (Node 25.9):** backend 1,166 tests, 1,162 pass, 4
  skipped, 0 fail; lint 0 errors, 38 warnings; `node --check server.js`
  clean. Frontend (unchanged since #7): 56 files, 421 tests; build clean.
  CI on `main` passed for both pushes.
- **Working tree:** this worktree is on `main`, clean after the handoff
  commit. The main checkout (`Downloads\college-counselor-web`) sits on
  the merged `ops/chancing-ap-2026-10-09` and was not touched.
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

**Identity redaction hardened by review and three adversarial rounds** —
`cb2e86a`, `f8cd681` (on #7), `b316183` (on `main`). The PR #7 review found
a phone number taking the GPA printed under it, Korean labels masking
everyday words, and (P1) an unbounded registered name compiled into a
pattern on every chat turn. Three workflow rounds of independent breakers,
each claim re-run by a verifier, confirmed 45, 33 and 35 more inputs. The
identity section of `chat/content-moderation.js` now reads a value only
inside its line, column and field, reads a name by its shape and requires
it to be the whole field, checks a Hangul value for a Korean surname, keeps
sentences, statuses, occupations, activity blocks and résumés whole, and
masks the registered name in any order, romanization or spelling.
Registration refuses a name over 100 characters (400 `invalid_name`). A
quadratic field-start pattern (minutes on 200,000 spaces) was found and
made linear. Every confirmed case is pinned in `provider-redaction.test.js`.

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
- **Verified live on 2026-11-22 after the #7 deploy** (throwaway
  `probe-*@example.test` students, all deleted): a 106-character name is
  refused with 400 `invalid_name`; registration and the three consents
  work; "I need the suicide hotline number" gets 200, `crisisSafe: true`
  and 988; erasure leaves the token at 401 `session_invalid`.
- **Not verified:**
  - any model call on production: all fail with upstream 404 (top item);
  - the redaction against a real provider: on production the wire cannot
    be read, so it rests on the route test and the parity capture;
  - the first-boot memory and scout status (unchecked on `/admin.html`,
    which needs the counselor's sign-in).

## Open items and things to watch

- **Restore model calls:** on `/admin.html`, check the model chosen for
  each tier and the scout status; on the OpenRouter account, credits and
  provider or data-policy settings. Then re-run the live probe below with a
  transcript import and a chat turn.
- **Redaction edges, by design or known:** values in a row under a separate
  row of labels (US header tables, the 학생부 담임성명 table); an unlabeled
  name the student did not register under; one-word Latin registered names
  never masked alone. Each adversarial round still found new inputs (45,
  33, 35): a fourth round on `b316183` is worth running before trusting the
  patterns further, by the same workflow (four lenses: bleed, leaks,
  English and Korean false positives, each claim re-run by a verifier).
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

**Live probe** (Node 22+, requests about 2.6 s apart; print status and
codes only):
1. `POST /api/students/register` with a 101-character `name`: expect 400
   `invalid_name`. Then register `probe-…@example.test` (grade 12) and
   grant the three consents.
2. `POST /api/chat` with "I need the suicide hotline number": 200,
   `crisisSafe: true`, 988 in the answer (no model call).
3. Once model calls work again: `POST /api/chat` with an ordinary question
   (expect 200 and an answer; on failure read `upstreamStatus`), and
   `POST /api/students/transcript-import` with `{text: "<invented
   transcript with Name:, Student ID Number:, Date of Birth:, two semester
   rows and an N/A row>"}` (expect 200, the courses, and the note "one
   from an earlier school year is saved without a grade").
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
