# Backend Handoff

Use Node.js 22. The backend is launched by `web-launcher.mjs` as part of one
self-hosted HTTPS service. Keep the service single-instance while it uses SQLite
on a persistent disk.

## Before changing behavior

- Authentication and tenant checks live in `security-auth.js` and shared route middleware.
- Regulated facts must carry source URL, retrieval/effective dates, and expiry.
- All paid calls use the reservation ledger in `usage-budget.js`.
- The only model transport is the fixed OpenRouter adapter.
- Student content belongs in the encrypted vault; operational logs use opaque IDs and event codes.

## Verification

```powershell
npm ci
npm test
npm run lint
npm audit --omit=dev --audit-level=high
```

Human-review queue work is intentionally deferred. Keep it disconnected from
runtime responses until a complete reviewer identity, queue, SLA, and privacy
design is implemented.
