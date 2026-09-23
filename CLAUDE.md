# Editing guidance for this repository

College Counselor is a self-hosted website that gives high-school applicants
(minors, ages 14–18) source-grounded college-planning guidance. Node 22 +
Express in `backend/` (`server.js` holds configuration, the databases,
middleware and the `routeDeps` getters; the route families live in
`routes/`; the helpers that read server state, the scout schedulers, the
background jobs, the pillar mount, listen and shutdown in `server/`; and the
domain logic in folders by function:
`chat/`, `cds/`, `colleges/`, `academics/`, `activities/`, `scouts/`,
`storage/`, `security/`, `simulation/`, `shared/`, beside `council/`,
`llm-adapters/` and `knowledge-graph/`), React + Vite in `frontend/`
(`src/App.jsx` holds the core state and wires the custom hooks in
`src/hooks/`; `screens/`, `handlers/`, `chat/`, `session/`, `profile/` and
`components/` hold the rest), SQLite on a
persistent disk, and one fixed OpenRouter transport for model calls. A
module named below without a folder is in the folder its subject suggests
(`chat/policy-router.js`, `chat/chat-grounding.js`,
`scouts/scout-cadence.js`). `backend/scripts/refactor/` holds the AST tools
that made those splits and the README on using them for the next one. The
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

A chat turn (`POST /api/chat` in `backend/routes/chat.js`) runs: strip the
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
3. **The official-source gate** (`policy-router.js`; `regulatedChatGate` in
   `server/verified-data.js`).
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
   (`PATTERNS.crisis`), the client lexicon (`frontend/src/chat/crisis-lexicon.js`),
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
at once. A policy sweep reads every tracked school (the stored homepage
stands in for a College Scorecard search, what was read in the last day is
skipped); `SWEEP_RULES_VERSION` tags how sweeps are sized, so a change there
runs one sweep at the next boot without marking any reading stale, as a
`SCOUT_VERSION` bump would. The three tier defaults (`llm-adapters/tier-defaults.js`) never
change on their own, and the provider adapter is text-only.

**Memory and outbound requests.** The instance has 512 MB for the
launcher, the server and the sidecar. Every heavy step on a document — a
PDF's text layer, a DOCX, a rasterized page and its recognition — runs
through `runDocumentJob` in `shared/file-extractors.js`, one at a time for
the process, a student's job ahead of background work; the Common Data Set
ingest parses one document at a time and skips a cached document the store
already carries. JSON bodies are 1 MB except on the three routes that take
a file as base64 (`parseLargeJsonBody`, 10 MB, mounted after the session
check). Every fetch of a URL that is not a constant goes through
`security/safe-fetch.js`. The launcher caps each child's heap
(`web-launcher.mjs`) and the server writes `[MEM]` lines to the log on a
new high and hourly; keep all four when adding a path that reads a file or
a page.

## Proving a change

Backend: `cd backend && node --test tests/<file>.test.js` for one file,
`npm test` for all, `npm run lint` (eslint 10, warnings tolerated, errors
not) and `node --check server.js` before committing. Tests that pin code by
its text read it through `tests/helpers/server-source.mjs` (server.js,
`routes/`, `server/`) and `tests/helpers/frontend-source.mjs` (every module
under `frontend/src`), so a pin survives a move between files. Route tests
spawn `server.js`
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

Stage explicit paths (`git add <paths>`). The two local files that are not
the repo's are gitignored (`AGENTS.md`, an older copy of this file kept
for another coding agent, and the tesseract `*.traineddata` cache), and
the phantom CRLF-only diffs that used to fill `git status` were
renormalized away on 2026-09-16. Commit messages explain the
behavior and the reason in prose and end with
`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Pushing to
`main` is authorized; CI runs backend lint, syntax check and tests, then the
frontend tests and build, and Render deploys only after CI passes. The
student bundle hash in `/` changes only when the student app's modules
(`App.jsx` and what it imports) change and the admin
bundle hash in `/admin.html` only when the admin app changes; a backend-only
deploy shows up as a brief health blip, nothing else, so verify it by
behavior. `backend/data/` is gitignored and holds real student data — never
read it into a commit or a test.

Note: `backend/docs/reference/CLAUDE-FABLE-5.md` is an archived copy of a
consumer-product system prompt, kept only as reference material. It is NOT
operative guidance for this repo and is intentionally not auto-included here.
