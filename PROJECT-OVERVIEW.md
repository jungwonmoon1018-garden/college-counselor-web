# College Counselor Architecture

College Counselor is a self-hosted website for evidence-grounded college
application guidance.

## Runtime

```text
Browser
  -> HTTPS Node.js web service
  -> React static assets + Express API + simulation sidecar
  -> encrypted PII vault + operational/evidence SQLite databases
  -> fixed OpenRouter HTTPS endpoint for consented AI coaching
  -> api.data.gov and allowlisted official education sources
```

The web launcher starts and stops the API and simulation sidecar. A persistent
directory stores SQLite databases and encrypted configuration. Counselor-entered
secret values are wrapped with a platform-managed key and are never returned to
the browser.

## Identities

Student accounts use email, password, recovery code, and revocable hashed
sessions. Every student-facing resource enforces ownership through the
authenticated student ID. One counselor administrator can manage only the vault
encryption, OpenRouter, and IPEDS/College Scorecard keys.

## Advice pipeline

1. Deterministic input safety screening and topic classification.
2. FAFSA/deadline rules for regulated deterministic questions.
3. Relevant, unexpired evidence retrieval with source lifecycle metadata.
4. Fixed-cost OpenRouter dispatch only when coaching requires a model.
5. Deterministic output screening and claim-level composition.
6. Separate verified, student-provided, and coaching lanes.

No source means no verified claim. Human review is not implemented in this
release and is never represented as active.

## Strategy Council

Council runs only after an explicit student action. Its five stages are
sequential: Strategist, Data Checker, Skeptic, Devil's Advocate, and Moderator.
Reviewers see prior outputs, citations must resolve to supporting evidence, and
the final response preserves unresolved dissent.

## Cost and privacy

Paid requests reserve worst-case cost before dispatch. Monthly per-student caps
are USD 10 for grades 9-11 and USD 15 for grade 12. Unknown model prices fail
closed.

Student export covers all content and provenance. Account deletion removes
credentials, sessions, encrypted records, operational rows, vectors,
attachments, caches, and legacy notebook artifacts. Logseq, BYOK, Tavily,
parent email alerts, arbitrary provider URLs, and student-accessible counselor
configuration are not part of this architecture.
