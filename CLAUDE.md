# Editing guidance for this repository

College Counselor is a self-hosted website that gives high-school applicants
(minors, ages 14–18) source-grounded college-planning guidance. Node 22 +
Express in `backend/` (one large `server.js` plus focused modules), React +
Vite in `frontend/` (one large `App.jsx` plus components), SQLite on a
persistent disk, and one fixed OpenRouter transport for model calls. The
product is deployed at https://college-counselor-web.onrender.com from `main`
after GitHub Actions CI passes. This file is the edit-time harness: what to
keep true, how to prove a change works, and how to land it.

## How to work here

- **Tone & formatting** — prose-first; use the minimum formatting needed for
  clarity (no over-bulleting, no excessive bold/headers). Match the density
  and idiom of the surrounding code and docs. Comments explain why a rule
  exists and what went wrong before it did.
- **Accuracy & epistemics** — ground claims about the code in what is in the
  repo; don't assert behavior you haven't verified. A change to the advice
  pipeline is not done until a test pins it (see *Proving a change*), and a
  deployed change is not done until it has been checked live.
- **User wellbeing & child safety** — keep counselor-facing behavior
  age-appropriate and crisis-safe, and preserve the guardrails: input/output
  screening, the three-layer crisis handling, PII redaction, consent gates,
  the profile-fidelity check, and the verified-data rules below.
- **Refusals** — decline to add or assist with code whose primary purpose is
  harm, and keep the guardrails intact rather than weakening them. Loosening
  an over-sensitive rule is fine (it has happened more than once); removing
  the check behind it is not.

## The advice pipeline and what must stay true

A chat turn (`POST /api/chat` in `backend/server.js`) runs: strip the
client's context appendix and attached-file preface from the question →
deterministic input screen → topic classification (`policy-router.js`) →
crisis path → regulated / high-stakes gate → system prompt assembly (profile
block, PROFILE FIDELITY rule, theme guard, VERIFIED DATA block) → model call
through the adapter → deterministic fidelity check with one corrective retry,
then a footnote → response. Utility JSON calls (the client's gatekeeper,
validator, upload screener) skip the profile, the theme guard, and the gate.

1. **Profile fidelity** (`chat-grounding.js`). Every grade, score, course,
   AP score, and activity the model states must match the saved profile
   exactly; `formatProfileForModel` is the only way the profile reaches the
   model and `checkProfileFidelity` is the only way it is checked. When you
   add a profile field, extend both together and add a case to
   `chat-grounding.test.js`. Attachment turns are exempt: the uploaded
   document is the ground truth for that turn.
2. **Verified data.** Numbers about a school come only from the VERIFIED DATA
   block — IPEDS baseline row, validated Common Data Set, the policy scout's
   snapshot, the official-page research cache, and the student's College Fit
   read with its double-check verdict. The model never invents statistics,
   quotes, or URLs, and prompts say so. Write money as `62,484 USD`, not `$`,
   because the provider-side redactor masks dollar amounts.
3. **The official-source gate** (`policy-router.js`, `regulatedChatGate`).
   Regulated topics (FAFSA, FERPA, aid policy, federal eligibility) and
   high-stakes topics (deadlines, costs, statistics, school policies) reach
   the model as labeled general guidance with the advisory prefix. The only
   refusal left is a *pure lookup* — an exact date or admissions figure —
   about a *named* school for which nothing is held, and only after an
   on-demand read of the official source (the school's own pages for dates,
   the College Scorecard for statistics) has been tried. Strategy,
   comparison, and explanation questions are never refused, and topic
   patterns must not fire on ordinary counseling words (`legal studies`,
   `school records`, `early decision`, `how much time`, `scholarship`).
   Changing sensitivity means changing the patterns or `isLookupQuestion`,
   then pinning both directions in `policy-router.test.js` and a route test.
4. **Crisis handling** has three layers that must agree: the server lexicon
   (`PATTERNS.crisis`), the client lexicon (`frontend/src/crisis-lexicon.js`),
   and the small-model gatekeeper, whose crisis call needs corroboration from
   the lexicon. First-person safety statements trigger the deterministic
   crisis response; bare topic words (`emergency`, `abuse` as a topic,
   `end my essay`, `hopeless at chemistry`) never do; ordinary stress gets
   the supportive 988 footer and a normal answer.
5. **Attachments** reach the model as their full extracted text (OCR fallback
   for scans); nothing is truncated on the client (`sanitizeInput` allows
   200k characters) and the classifier only ever sees the question, never
   the attachment or the context appendix.

**Scouts and models.** Two automatic scouts share one cadence
(`scout-cadence.js`, two weeks by default, checked hourly against the last
completed run in the database because deploys reset timers): the admissions
policy scout (`admissions-policy-scout.js`: deterministic reads of each
tracked school's own pages, robots-honoring, SSRF-guarded) and the model
catalog scout (`model-catalog-scout.js`: new OpenRouter chat models from
trusted providers, sorted into price bands, offered in the counselor's picker
and the adapter allowlist, pruned when they leave the catalog). Each carries a
version constant; bump it whenever its rules change so the next boot re-reads
at once. The three tier defaults (`llm-adapters/tier-defaults.js`) never
change on their own, and the provider adapter is text-only.

## Proving a change

Backend: `cd backend && node --test tests/<file>.test.js` for one file,
`npm test` for all, `npm run lint` (eslint 9, warnings tolerated, errors not)
and `node --check server.js` before committing. Route tests spawn `server.js`
with `--import tests/helpers/mock-openrouter-fetch.mjs`, `NODE_ENV=test` and
`RATE_LIMIT_RELAXED=1`: the mock answers chat calls with "Junior Year Course
Plan." unless the wire carries `MOCKREPLY:<base64>:` (first reply) or
`MOCKRETRY:<base64>:` (the fidelity-correction retry), returns transcript
JSON when the prompt contains `Transcript text:`, answers any College
Scorecard search with a 49% admit rate, SAT 1330–1490 and
`example-university.edu`, serves a small OpenRouter catalog with release
dates and four unpackaged ids for the catalog scout, and throws for every
other host. Admin routes are reachable in tests by bootstrapping a counselor
through `POST /api/admin/bootstrap` on loopback and sending the session cookie
plus the CSRF header. Write a route test whenever a change alters what the
model is sent or what the student gets back.

Frontend: `cd frontend && npx vitest run` and `npm run build`. Component
tests stub `fetch` by path (see `AdminApp.test.jsx`).

Live checks after a deploy use throwaway student accounts created through
the API with the three consents granted, and are deleted afterwards with
`DELETE /api/students`. Never use or ask for a real student's or the
counselor's credentials.

## Landing a change

The working tree carries dozens of phantom CRLF-only diffs; always `git add`
explicit paths and never stage everything. Commit messages explain the
behavior and the reason in prose and end with
`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Pushing to
`main` is authorized; CI runs backend lint, syntax check and tests, then the
frontend tests and build, and Render deploys only after CI passes. The
student bundle hash in `/` changes only when `App.jsx` changes and the admin
bundle hash in `/admin.html` only when the admin app changes; a backend-only
deploy shows up as a brief health blip, nothing else, so verify it by
behavior. `backend/data/` is gitignored and holds real student data — never
read it into a commit or a test.

Note: `backend/docs/reference/CLAUDE-FABLE-5.md` is an archived copy of a
consumer-product system prompt, kept only as reference material. It is NOT
operative guidance for this repo and is intentionally not auto-included here.
