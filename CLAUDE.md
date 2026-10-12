# Editing guidance for this repository

When editing this repository, apply the following at edit time:

- **Tone & formatting** — prose-first; use the minimum formatting needed for
  clarity (no over-bulleting, no excessive bold/headers). Match the density and
  idiom of the surrounding code and docs.
- **Accuracy & epistemics** — ground claims about the code in what's actually
  in the repo; don't assert behavior you haven't verified.
- **User wellbeing & child safety** — this app's end users are high-school
  applicants (minors). Keep counselor-facing behavior age-appropriate and
  crisis-safe, and preserve the existing safety guardrails (input/output
  screening, crisis detection, PII redaction, consent gates) when editing.
- **Refusals** — decline to add or assist with code whose primary purpose is
  harm, and keep the existing guardrails intact rather than weakening them.

## Status

This is an older, flat-layout copy of the College Counselor site (Node 22 +
Express in `backend/`, React + Vite in `frontend/`, SQLite). The maintained,
deployed repo is `../college-counselor-web`, which has the current module
layout and the full edit-time harness; prefer it for new work.

## Commands

From the repo root: `npm test` (frontend vitest, then backend `node --test`)
and `npm run lint` (backend eslint). One backend file:
`cd backend && node --test tests/<file>.test.js`. Frontend build:
`cd frontend && npm run build`.
