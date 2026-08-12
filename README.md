# College Counselor Web

College Counselor is an evidence-grounded, self-hosted college application
guidance website. It combines deterministic FAFSA and deadline rules,
student-specific planning tools, source-aware AI coaching, and explicit
uncertainty instead of admissions guarantees.

The React frontend, Express API, and simulation sidecar run as one native Node.js
service with a persistent encrypted data directory. OpenRouter receives redacted
text only after the student grants the external-processing consents.

## Packages

| Path | Purpose |
| --- | --- |
| `frontend/` | React student application and separate counselor administrator screen |
| `backend/` | Express API, web launcher, encrypted PII vault, evidence/rules engines, IPEDS integration |
| `render.yaml` | Native Node.js service and persistent-disk Blueprint |

The application deliberately has no student BYOK flow, arbitrary LLM endpoint,
general runtime web-search provider, student-accessible counselor
configuration, or parent-notification email endpoint.

## Trust model

- The service binds to the platform port and requires HTTPS, a persistent data
  directory, and same-origin access.
- Student accounts require email and password; passwords and recovery codes are
  stored as salted hashes.
- One counselor administrator configures only the vault encryption, OpenRouter,
  and IPEDS/College Scorecard keys.
- Counselor-entered secrets are encrypted with an independent platform-managed
  wrapping key and are never returned to a browser.
- Student content is encrypted at rest. Export and deletion cover all
  student-owned records, sessions, attachments, vectors, and cached files.
- Human review is not available in this release. The UI must never claim that an
  answer has been reviewed by a counselor.

## Cost limits

Paid model calls are capped per student per calendar month:

- Grades 9-11: USD 10
- Grade 12: USD 15

The server reserves the worst-case request cost before calling OpenRouter.
Unknown-price models and calls that would exceed the cap are rejected. Strategy
Council is explicit-only and shows its estimated maximum cost before starting.

## Development

Node.js 22.13 through 22.x is required. Deployments are pinned to Node 22.22.

```powershell
npm ci --prefix backend
npm ci --prefix frontend
npm test
npm run build:web
```

To run the production website locally over HTTP:

```powershell
$env:WEB_CONFIG_KEY = '<at least 32 random characters>'
$env:WEB_ADMIN_BOOTSTRAP_TOKEN = '<at least 24 random characters>'
$env:WEB_COOKIE_SECURE = '0'
npm start
```

Open `http://localhost:3001/admin.html` for counselor setup. See
[WEB_DEPLOYMENT.md](WEB_DEPLOYMENT.md) for the complete setup and deployment flow.
