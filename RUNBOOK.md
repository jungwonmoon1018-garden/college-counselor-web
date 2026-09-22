# Runbook

The short operator sheet for College Counselor. `CLAUDE.md` says how to
change the code; `SESSION-HANDOFF.md` says what changed and why; this file
says how to run, ship, refresh, check and roll back. Every command runs
from the repository root unless it says otherwise.

## Runtime

Production runs on Render from `main`: Node 22.22 (`.node-version`,
`.nvmrc`; the packages declare `>=22.13 <23`), Express in `backend/`,
SQLite on the persistent disk under `backend/data/` (operational,
encrypted PII vault, vectors), one OpenRouter transport. The React app is
built by Vite and served by the backend. Health: `GET /api/health`.
Route handlers live in `backend/routes/<family>.js` (one file per
`/api/<family>` prefix, `/api/ec` in four; registered from `server.js`
through the `routeDeps` getters) and the helpers that read server state in
`backend/server/<area>.js` (bound to the same getters at the top of
`server.js`), together with the boot-time work: `server/schedulers.js` (when
the two scouts run), `server/jobs.js` (batch jobs, CDS refreshes, catalog
refresh timers), `server/pillars.js`, `server/boot.js` (listen) and
`server/shutdown.js`. `server.js` keeps configuration, the databases and
their statements, middleware and the calls, in boot order. The
domain modules sit in folders by function (`chat/`, `cds/`, `colleges/`,
`academics/`, `activities/`, `scouts/`, `storage/`, `security/`,
`simulation/`, `shared/`); only the entry points (`server.js`,
`web-launcher.mjs`, `simulation-sidecar.js`) stay at the top of `backend/`.
`frontend/src/App.jsx` holds the student app's core state and wires the
custom hooks in `src/hooks/` (forms, threads, College Fit, chat tools and
files, the session lifecycle, the auth handlers); the screens
(chat, sidebar, survey, login, create-account) are in `src/screens/`, the
handlers in `src/handlers/`, the chat transport, orchestrator, prompts and
crisis lexicon in `src/chat/`, the vault and server session in
`src/session/`, the profile reads in `src/profile/`.
The AST tools that made those moves are in `backend/scripts/refactor/`
(README there).
Locally on a machine without Node 22, install nvm-windows or Volta and
`nvm use` before `npm ci`, or accept that native modules (better-sqlite3)
are built for whatever Node runs `npm install`.

Memory: the Render instance (`plan: starter`) has 512 MB for the three
processes, which idle at about 240 MB together. `web-launcher.mjs` starts
the server with `--max-old-space-size=192 --max-semi-space-size=8` and the
sidecar with 96/4 (`NODE_FLAGS_SERVER` and `NODE_FLAGS_SIDECAR` replace
them); the server logs `[MEM] rss … (high …)` on each new high and hourly.
Documents are read one at a time for the whole process (the document lane
in `shared/file-extractors.js`), and tesseract.js's language data is
fetched from its CDN the first time a language is used and cached under
`backend/data/tessdata/` on the persistent disk (`TESSDATA_CACHE_DIR`
overrides). JSON bodies are 1 MB, 10 MB on the three base64 file routes.

## Ship

1. Backend: `cd backend && npm test && npm run lint && node --check server.js`.
2. Frontend: `cd frontend && npx vitest run && npm run build`.
3. Commit with explicit paths, push `main`. CI (`.github/workflows/ci.yml`)
   runs lint, syntax, tests and `npm audit --audit-level=high` for the
   backend, tests and build for the frontend, then the web-launcher build;
   each job times out at 15 minutes and the backend job normally takes
   about 40 seconds. A backend job past three minutes is a hang: cancel it
   (`gh run cancel <id>`), then read its partial log
   (`gh run view <id> --log --job <job-id>`).
4. Render redeploys after a green run, two to eight minutes later, with a
   few seconds of 502s. A frontend change shows as a new `assets/main-*.js`
   hash in `/`; a backend-only change shows only as the 502 blip, so verify
   it by behaviour (below).

## Check production

Use a throwaway `probe-*@example.test` account created through the API
and deleted afterwards; never a real student's or the counselor's. The
script shape is in `SESSION-HANDOFF.md` under *Quick verification
recipes*: register (grade 11, `example.edu`), grant the three consents
(`POST /api/consent/grant` with `data_processing`, `ai_interaction`,
`cross_border_transfer`), `POST /api/students/sync` a small profile, then
`POST /api/positioning/targets` (`searchCds: false`) and read
`dataProvenance` (`kind`, `yearLabel`, `verification`), `POST
/api/colleges/values`, one `POST /api/chat` question if the change touched
the verified-data block, and `DELETE /api/students` with retries. When a
change touched file reading or the middleware, add `POST
/api/files/extract-text` with a small PDF (the document lane), `GET
/api/cds/school/<slug>` with the token, and a 1.1 MB JSON body to any
route, which must answer 413.

## Refresh the Common Data Set cache

The server seeds `cds_records` at boot from `backend/tools/cds-cache/parsed/*.json`
(newer parser version or changed cycle label re-ingests). The daily
June-onward job re-downloads every school and keeps a newer stored cycle
over an older download (`kept_newer`) and a fuller stored record over a
thinner parse (`held_back`); a cached document whose stored row already
carries its cycle and parser version is not parsed again (`unchanged`),
and documents parse one at a time. To refresh by hand, run the pipeline against a
scratch SQLite database (the local `backend/data/counselor.db` predates the
schema): `initRAGTables` + `prepareRAGStatements` from
`storage/rag-engine.js`, `ingestBulk(stmts, names, { concurrency: 3, year:
"2025-26" })` from `cds/cds-ingest-pipeline.js`, then dump each usable
record with
`loadValidatedRecord` + `loadLatestValidation` to the parsed directory
(`scripts/export-parsed-cds.mjs` shows the shape). Downloads land in
`backend/data/cds-cache/pdfs/`, cached by slug and cycle. JHU's document
must be fetched by hand (Cloudflare blocks Node's fetch): curl with a
Chrome user agent, a referer and `Accept: application/pdf` into that
folder. Register new links with `npm run cds:add-cycle` or by editing
`backend/tools/cds-cache/index.json`. Before committing the parsed
directory: scan for implausible counts, compare the previously committed
records for lost fields, and run `npm test`.

## Roll back

Revert the commit on `main` (`git revert <sha>`), push, let CI deploy.
Data on the persistent disk is not rolled back by a deploy: a bad CDS
record is replaced by restoring the parsed file and redeploying: the
seeding re-ingests a record whose label or parser version differs from the
stored row. Student data lives only in the encrypted vault and is never
touched by a deploy.

## When something is wrong

- 502s longer than a minute after a deploy: Render's boot log (the seeding
  of ~300 CDS records takes a few seconds; a crash prints before it).
- `[UNHANDLED REJECTION]` in the log: logged and survived (pdfjs after a
  document teardown); the process no longer exits on it.
- A student reports a blocked chat: the counselor's audit log names the
  layer (`input_blocked`, `off_topic_blocked`, `essay_blocked`,
  `validation_failed`).
- College Fit shows the IPEDS baseline instead of the CDS: the record's
  validation status is `no_truth` or `inconsistent`; check the parsed file
  and the document's C1 layout.
- The service restarted for memory, or `[MEM] rss` climbs past about
  380 MB: read the last `[MEM]` line and what the log shows around it (an
  OCR ingest, a scanned upload, the daily refresh). The hourly line's
  `high` rising with no request behind it is a leak; a spike that falls
  back within two minutes is the OCR worker being released.
- OCR answers `ocr_failed` right after a deploy: the language data is
  fetched from jsDelivr on first use into `data/tessdata/`; check outbound
  access and that directory.
