# Session handoff

One current document for whoever picks this repository up next — a person
or a fresh Claude session with no access to the conversation that produced
it. Read `CLAUDE.md` first: it is the edit-time harness (invariants, how to
prove a change, how to land it); `RUNBOOK.md` is the operator sheet. This
file says where things stand, what changed recently and why, what was
verified live, and what is open. It was compressed on 2026-09-21: the long
form of every entry dated 2026-09-16 or earlier is in git
(`git show 812cdeb:SESSION-HANDOFF.md`).

## Where things stand (2026-09-21)

- **Deployed:** `main` at `8b5110a` (plus this handoff), live at
  https://college-counselor-web.onrender.com. CI green on each push of the
  session: runs 35517580306 (`9c15000`), 35517945709 (`234c107`),
  35518625060 (`8b5110a`). Confirmed by behaviour, see *Verified live*.
  The session's commits, newest first: `8b5110a` (modules into folders by
  function), `234c107` (the sidebar drawer closes on a phone), `9c15000`
  (refactoring tools, docs, `.graphifyignore`), `470cd2a` (server.js
  helpers to `server/`, the 1,300-line modules split), `deb7baf` (App.jsx
  split).
- **Tests (run after the last code edit, 2026-09-20 15:05 UTC):** backend
  `npm test` 741 tests, 737 pass, 4 skipped, 0 fail; `npm run lint` 0
  errors, 39 warnings (CI cap 500); frontend `npx vitest run` 18 files, 56
  tests; `npm run build` clean.
- **Working tree:** clean apart from two untracked files no session made
  (`AGENTS.md`, `backend/kor.traineddata`) and the gitignored local
  artefacts (`backend/data/`, `graphify-out/`).
- **Shape of the code now.** Backend entry points stay at the top of
  `backend/` (`server.js` 1,396 lines of setup, middleware, schedulers,
  `routeDeps` and boot; `web-launcher.mjs`; `simulation-sidecar.js`).
  Routes are in `routes/` (26 files; `/api/ec` in four), helpers that read
  server state in `server/` (nine files, bound to `routeDeps` at the top of
  server.js), and the domain modules in `chat/`, `cds/`, `colleges/`,
  `academics/`, `activities/`, `scouts/`, `storage/`, `security/`,
  `simulation/`, `shared/`, beside `council/`, `llm-adapters/`,
  `knowledge-graph/`. `frontend/src/App.jsx` is 1,266 lines of state and
  hooks; `screens/`, `handlers/`, `chat/`, `session/`, `profile/` and
  `components/` hold the rest. Largest hand-written files now:
  `server.js` 1,396, `App.jsx` 1,266, `activities/ec-strength-vectorizer.js`
  1,145 (one 459-line function), `colleges/positioning-engine.js` 1,034,
  `storage/rag-engine.js` 990.
- **The CDS cache covers 298 schools** (parser version 6; 118 on 2025-26
  documents, 141 on 2024-25). Unchanged this session; the server re-ingests
  the seed at boot in about two seconds.
- **Knowledge graph and Obsidian vault (local, not in git).** graphify
  0.8.43 built `graphify-out/` from 330 files (the 300 parsed CDS records
  and other data are excluded by `.graphifyignore`): 2,806 nodes, 6,474
  edges, 123 labelled communities, `graph.html`, `GRAPH_REPORT.md`. It was
  built BEFORE `8b5110a` moved the modules into folders, so its
  `source_file` paths are the flat ones; see *Open items*. The owner's
  vault folder (`Obsidian Vault/Collegeapp-AI` under the OneDrive documents
  folder) holds that export: 2,919 generated notes beside six hand-written
  change summaries that were left untouched; the June export it replaced
  (1,737 generated files) was moved, not deleted, to
  `Obsidian Vault archive/Collegeapp-AI graphify export 2026-06-19` beside
  the vault.
- **Standing authorizations from the user:** push straight to `main`;
  create and delete throwaway `probe-*@example.test` accounts on
  production for live checks. Never ask for or use the counselor's
  password or a real student's, and record nothing from the owner's own
  account here.
- **Deferred by the user (2026-09-07):** the University of Wyoming College
  Fit data-source precedence — "Do not pursue until asked."
- **Node on this machine** is 25.9 with no version manager; the packages
  declare `>=22.13 <23` (`.nvmrc`, `.node-version`, CI and Render run
  22.22), so every local `npm install` warns `EBADENGINE`.

## What changed, newest first

The user's asks in this session, verbatim: "/graphify organize the current
repo state and make sure that the parsed cache goes to the SSD, not stay on
RAM" — "Also, use these to make my obsidian graph. Also, split monolithic
files" — (with a phone screenshot of the open sidebar) "This tab doesn't
close in the smartphone browser settings. Make a close button please over
here. Also, I want to split up files in the backend and frontend by general
function of the files making it easy to maintain and also, to easy to
reduce tech debt. Also, I got obsidian connected."

**Modules sit in folders by function (2026-09-21)** — `8b5110a`. 108 files
moved with `git mv` (the folder list is under *Where things stand*);
`scripts/refactor/move-modules.mjs` rewrote the 447 relative path literals
that named them in every tracked module (imports, dynamic imports,
re-exports, eight file reads in tests). Six data paths built from
`__dirname` in `cds/` gained a `".."` by hand. The tool's first version
also treated `"."` and `".."` as paths, so `host.split(".")` became
`split("..")` in every moved file; seven tests failed (registrable
domains, GPA parsing), the uncommitted move was discarded and redone, and
strings made only of dots and slashes are never touched now. Checked by
diffing every moved backend file against its old self (import paths, two
dynamic imports and the six fixes, nothing else) and by the student bundle
being byte-identical before and after (`main-C7fIM242.js`). Two tests that
pinned an import path by its text name the new folder.

**The sidebar drawer closes on a phone (2026-09-20)** — `234c107`. Under
768px the sidebar is a fixed drawer above everything and the only control
that closed it, the header toggle, sat underneath it. `screens/Sidebar.jsx`
carries the shared × ("Close sidebar") at every width, and under the phone
media query a dimmed backdrop (`.cc-sidebar-backdrop` in `app-shared.js`)
closes it on a tap. Pinned in `App.dashboard.test.jsx`.

**server.js helpers and the 1,300-line modules (2026-09-20)** — `470cd2a`.
1,840 lines of helper functions moved verbatim into nine `server/<area>.js`
modules (auth, model-calls, verified-data with `regulatedChatGate`,
narrative-calendar, chat-attachments, student-data, positioning with
`runPositioning`, ec-ranking, baseline-colleges). A reference to a server
binding became `deps.<name>`; each module keeps `deps` in one variable set
by `bind<Area>(routeDeps)`, and `routeDeps` with the bind calls now sits
right under the imports (getters are lazy; an imported helper is callable
from the first line like the hoisted function it replaces). Functions were
not re-indented, so prompt templates keep their text. `routes/ec.js` (24
routes) became four modules registered in the original order. Re-exporting
splits, importers unchanged: `rag-schema.js`, `directionality-vectorizer.js`
+ `vector-utils.js`, `ec-strength-schema.js`, `cds-pdf-text.js` /
`cds-pdf-c7.js` / `cds-pdf-c1.js`, `policy-scout-extract.js` (holds
`SCOUT_VERSION`, unchanged) / `policy-scout-fetch.js`.

**App.jsx splits into the modules it was made of (2026-09-20)** —
`deb7baf`. 5,078 → 1,266 lines. Module-level code moved as closed sets,
bottom layer first (vault-storage, server-session, profile-analysis,
agent-prompts, agent-tools, chat-files, chat-client, markdown,
chat-orchestrator); the chat `<main>` is `ChatScreen.jsx` (37 props);
App()'s large `useCallback` bodies are `name(ctx, ...params)` functions in
chat-send, auth-handlers, survey-handlers, school-handlers, with App
keeping each hook and dependency array. One default parameter read an App
binding before `ctx` was destructured (`base = data`); it reads `ctx.data`
and the tool makes that rewrite itself now. New test: a course question
goes through the keyword gate to the academics agent and the reply
renders (no frontend test sent a chat message before). Backend tests that
pinned App.jsx by its text read every frontend module through
`tests/helpers/frontend-source.mjs`.

**Tools and docs (2026-09-20)** — `9c15000`. `backend/scripts/refactor/`
gained module-graph, extract-module, extract-helpers, split-route-module,
extract-callback, prune-bare-imports (and move-modules in `8b5110a`); its
README says which to reach for and in what order. `CLAUDE.md` and
`RUNBOOK.md` describe the layout as it is. `.graphifyignore` keeps data
out of the knowledge graph.

**Earlier sessions, compressed** (long form: `git show 812cdeb:SESSION-HANDOFF.md`).
2026-09-16, the tech-debt plan: CI job timeouts and SIGKILL teardown
(`957205c`), CRLF renormalized (`d120ab5`), the refresh hold-back guard
(`db883b0`), CDS PDFs out of git (`c08c12c`), RUNBOOK and `.nvmrc`
(`3e9f57f`), Express 5 / React 19 / better-sqlite3 13 / pdf-parse 2 /
tesseract.js 7 / eslint 10 (`bd5650e`, `6a276b9`, `50f5d8a`), the route
families out of server.js (`5ce0056`), Sidebar, Survey, Login and
CreateAccount out of App.jsx (`697a7c0`, `dbdc6b8`), the section reader's
missed layouts and a whole-index re-parse (`b0c035b`). 2026-09-15/16, CDS:
College Fit reads the 2025-26 documents (`72f2509`), the workbook C7 read
and the newer-cycle guard (`ef1d56e`), the remaining CDS sections reach the
model (`40b1ee6`, `2f287de`), × close controls (`0af239e`), chat
attachments filed under Documents and the collapsible sidebar (`dacc220`).
2026-09-13: single fetches for Course plan, calendar and Spike Finder
(`3a8fdc3`, `9ec5edc`), research output as achievement (`0caa68e`), chat
PDF uploads and four UI defects (`58b28fb`). 2026-09-11: course rigor in
College Fit (`fa6c5b1`, `6a29565`, `651f7ac`, `95f5116`). 2026-09-09: chat
files read into the activities they name (`b734c6c`), the priorities matrix
reads the whole record (`4eae5cc`), audits clean (`cd15135`, `ba07b4e`).
Before that: the CDS parser's ACT bands and GPA tables (`c33004f`), policy
scout deadline tables and the official-source gate (`c4c5bb0` and earlier).

## Verified live, and not

- **After `9c15000` (14:50 UTC 2026-09-20, bundle `main-BFi5gbxM.js`):** a
  throwaway account registered, granted the three consents and synced a
  small profile; `/api/positioning/targets` returned Indiana University
  Bloomington (2024-25) and Middlebury (2025-26) from the store;
  `POST /api/chat` answered the Indiana tuition and wait-list question
  "10,622 USD; 40,369 USD; 7,524" with `verifiedData: true`; the GETs
  `/api/ec/vectors`, `/api/ec/narrative/active`, `/api/ec/strength`,
  `/api/ec/spike`, `/api/students/profile`, `/export`, `/deadlines`,
  `/budget` and `/api/baselines/status` returned 200 (`/api/ec/cache-memory`
  410, the administrator-only answer it gave before); `DELETE
  /api/students` 200 and the token answered 401 afterwards.
- **After `8b5110a`:** the deploy's restart blip was 15:09:40–15:10:08 UTC
  2026-09-20 (the bundle is identical to `234c107`'s, so only the blip
  marks it), and the probe seventeen seconds later passed in full, chat
  included ("10,622 USD; 40,369 USD; 7,524", `verifiedData: true`). At
  09:28 UTC 2026-09-21, certainly on `8b5110a`: register 201, the three
  consents, sync 200, positioning 200 (Indiana 2024-25, Middlebury 2025-26),
  the `/api/ec` and student GETs 200, delete 200, token 401 afterwards —
  but `POST /api/chat` answered 429 `{"error":"Provider returned
  error","code":"http_error"}` three times across two tiers. That is
  OpenRouter passing on its upstream provider's rate limit
  (`llm-adapters/openai.js` forwards the provider's status and message);
  the chat route tests pass against the mock on this code. Re-run the chat
  part of the probe before treating chat as verified on this commit.
- **Not verified:** nothing was looked at in a browser. The sidebar's close
  button and backdrop, ChatScreen and the moved handlers are covered by
  the dashboard tests (sign-in, in-place edits, a chat send, the drawer
  closing) and by the production bundle being served; the sidebar exists
  only after sign-in, which a session may not do. The owner reported the
  drawer problem from a phone and should confirm the fix there.

## Open items and things to watch

- **The knowledge graph predates the folder move.** Rebuild it before
  relying on paths: run `/graphify` (or `/graphify . --update`) from the
  repository root — AST extraction of the code is free and takes about 20
  seconds; the 21 docs are cached by content hash, so only the four edited
  since (CLAUDE.md, RUNBOOK.md, the tools README, this file) need a
  subagent. Then re-export with `graphify export obsidian` and copy into
  the vault folder the way this session did: move only files that carry
  graphify frontmatter or a `_COMMUNITY_` prefix (and `graph.canvas`) to an
  archive outside the vault, never the six hand-written notes (`index.md`,
  `strategy-council.md`, `embedded-llm-stack.md`,
  `seasonal-retrieval-first.md`, `logseq-pii-vault.md`,
  `chat-graph-vault-context.md`). Community colours are written to
  `Collegeapp-AI/.obsidian/graph.json`, which Obsidian reads only when that
  folder is opened as its own vault; the main vault's colour groups were
  left alone.
- **graphify never caches a JavaScript parse per file** (`.js`, `.jsx`,
  `.mjs` bypass its AST cache because their import resolution depends on
  other files). What persists on disk is `graph.json` + `manifest.json`
  (which `--update` builds on), `cache/semantic/` for the docs and
  `cache/ast/` for JSON; this session also kept the whole AST extraction
  as `graphify-out/cache/ast-extraction.json`. Everything is on the NVMe
  system drive; there is no RAM disk on this machine.
- **Next splits, if wanted:** `server.js` still holds the schedulers and
  the boot sequence (about 1,400 lines); `App.jsx` holds 1,266 lines of
  state, effects and small callbacks that could become custom hooks (not
  mechanical); `vectorizeECStrength` is one 459-line function;
  `chat-orchestrator.js`'s `orchestrateStages` is 383. `routeDeps` is a
  flat bag of about 120 getters.
- **Garbled banner comments in `storage/rag-engine.js` and
  `storage/rag-schema.js`** (an old encoding accident, present at
  `812cdeb` too; the file also starts with a BOM). Cosmetic.
- **`extract-routes.mjs` re-indented the route handlers on 2026-09-16**,
  so any multi-line template literal inside a route gained two spaces per
  line. Not checked this session; tests and live probes have passed since.
  `extract-helpers.mjs` does not re-indent.
- **CDS data:** five records carry no C1 counts, 104 no C7 weights;
  Columbia, Caltech, Northwestern and UChicago are on older cycles; JHU's
  document must be fetched by hand each cycle (Cloudflare);
  `scripts/refresh-cds.mjs` fails against this machine's old local
  database, so refreshes run against a scratch database (RUNBOOK.md).
- **Carried over, one line each** (details in the 812cdeb handoff): the
  new CDS sections reach the model but no UI renders them; tier floors
  still require leadership ≥ 0.2 for "Developing"; strength rows recompute
  only on sync or the recompute route; tool panels open inline in the chat
  column; "Suggest ECs for me" was reported blocked once and not
  reproduced; the rigor units figure is rendered nowhere; the fit refresh
  is wired but not tested end to end; the rigor expectation is a GPA proxy;
  the server guesses locale from Accept-Language when the app sends none;
  chat evidence is keyed by activity name; prestige rationales are
  English-only; parser extras are unvalidated; the small tier sometimes
  returns an empty reply.
- **Untracked files to decide about:** `AGENTS.md` (a copy of an older
  CLAUDE.md) and `backend/kor.traineddata`.

## Quick verification recipes

Gates: `cd backend && npm test && npm run lint && node --check server.js`;
`cd frontend && npx vitest run && npm run build`. CI adds `npm audit
--audit-level=high` and the web-launcher build.

After any move of code between files: `node
backend/scripts/refactor/undef-check.mjs <files>` (unresolved identifiers),
then the gates. After `move-modules.mjs`: read its `--log` output, diff a
few moved files against `git show HEAD:<old path>`, and compare the
`assets/main-*.js` hash of `npm run build` before and after (a pure move
leaves it identical).

Live probe (Node 22+, a `.mjs` in a scratch folder, `BASE` the site): print
the account name first; register `probe-…@example.test` with grade 11, CA,
`example.edu`, `ageAttestation: true`; grant `data_processing`,
`ai_interaction`, `cross_border_transfer` through `POST /api/consent/grant`
(`grantedBy: "student"`); `POST /api/students/sync` a small profile; `POST
/api/positioning/targets` with two school names and read `yearLabel`;
`POST /api/chat` with a `request_id` (a UUID — the route answers 400
without one) and a numbers-only question about a school in the store; a GET
from each `/api/ec` module; `DELETE /api/students` with retries, then
confirm the token answers 401. The fuller recipe for the chat-evidence and
values paths is in the 812cdeb handoff.

Deploy markers: `/` carries `assets/main-*.js`; `/admin.html` carries
`assets/admin-*.js`; a backend-only deploy shows only as a brief
`/api/health` blip two to eight minutes after CI succeeds. Refreshing the
CDS cache: RUNBOOK.md.

## Tooling notes

- The Bash tool mangles backslashes and apostrophes inside heredocs and
  `node -e` / `python -c` strings (`"\n"` arrives as a real newline, and a
  file written that way does not parse). Write scripts, patches and commit
  messages with the Write tool and run or `-F` them. A `python - <<EOF`
  pipeline hung for its whole timeout; same remedy.
- Parallel Bash calls share one working directory and a `cd` in one moves
  the others — use absolute paths.
- Stage explicit paths (or `git add -u` when every tracked change is
  yours); never the two untracked files. Commit messages end with
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- CI watch: `gh run watch <id> --exit-status`; a background `until` loop on
  the bundle hash or on `/api/health` notifies when a deploy lands.
- A UI test that passes alone but times out in the full `npx vitest run`
  is queueing behind other files: give it the time it takes.
- jsdom has no `scrollIntoView` (`frontend/src/test-setup.js` shims it) and
  evaluates no media queries, so a phone-only control must be testable
  without them.
- Some backend files start with a UTF-8 BOM; insert imports after line 1.
- `useCallback` dependency arrays evaluate at render, so a state variable
  must be declared above the callback that lists it.
- graphify: subagents extracting the docs took 10 and 19 minutes; the AST
  pass about 20 seconds. Its Obsidian export writes one note per node
  (about 2,900 here), so export to `graphify-out/obsidian` first and copy.
