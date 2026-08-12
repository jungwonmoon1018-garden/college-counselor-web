# Website deployment

The website serves the React student app, counselor administrator page, Express
API, and simulation service directly from one native Node.js process tree.

## Required platform configuration

Configure these values in the hosting platform, not in the repository:

- `WEB_CONFIG_KEY`: at least 32 random characters. This wraps the encrypted
  counselor configuration file and must not be rotated without first migrating it.
- `WEB_ADMIN_BOOTSTRAP_TOKEN`: at least 24 random characters. The counselor uses
  it once when creating the first administrator account.
- `DATA_DIR`: an absolute persistent mounted directory.
- `PUBLIC_APP_URL`: the final HTTPS origin when the platform uses a custom domain.
  Same-origin deployments also work without it.

`render.yaml` supplies a native Node.js Render Blueprint with generated platform
secrets and a persistent disk mounted at `/opt/render/project/src/backend/data`.
The app uses SQLite and local encrypted files, so run one service instance rather
than horizontally scaling it.

## Counselor first run

1. Open `/admin.html` on the deployed HTTPS site.
2. Enter the platform's `WEB_ADMIN_BOOTSTRAP_TOKEN` and create a password of at
   least 12 characters.
3. Store the one-time recovery code offline.
4. Enter a 64-character hexadecimal vault encryption key. This is a distinct
   counselor-held key and is immutable after it is saved.
5. Enter the OpenRouter API key and the IPEDS / College Scorecard API key.
6. Review the Low, Mid, and High OpenRouter model choices and save them.

Student API access remains closed until all three counselor secrets are valid.
The browser receives configuration status only, never a stored secret value.

## Current reviewed OpenRouter choices

The model registry was checked against OpenRouter on 2026-08-12. The default
mapping is Low = Google Gemma 4 26B A4B, Mid = DeepSeek V4 Flash 0731, and
High = OpenAI GPT-5.6 Luna. Other reviewed choices remain available in the
counselor screen.
The backend also refreshes OpenRouter's live catalog daily and shows current
availability in the counselor screen.

Source pages: [Gemma 4 26B A4B](https://openrouter.ai/google/gemma-4-26b-a4b-it),
[DeepSeek V4 Flash 0731](https://openrouter.ai/deepseek/deepseek-v4-flash-0731),
and [GPT-5.6 Luna](https://openrouter.ai/openai/gpt-5.6-luna).

## Direct Node.js deployment

Render builds the frontend, installs the backend production dependencies, and
starts the web launcher with the root package scripts. The equivalent local
PowerShell flow is:

```powershell
npm run build:web
$env:WEB_CONFIG_KEY = '<at least 32 random characters>'
$env:WEB_ADMIN_BOOTSTRAP_TOKEN = '<at least 24 random characters>'
$env:WEB_COOKIE_SECURE = '0'
npm start
```

Use `WEB_COOKIE_SECURE=0` only for plain local HTTP. Hosted deployments should
keep the secure-cookie default.

Back up the persistent data directory together with the platform-managed
`WEB_CONFIG_KEY`. Losing either the vault encryption key or wrapping key makes
the corresponding encrypted data unrecoverable.

## 2025-26 CDS research

The searchable source index includes 2025-26 official university publications
where they could be verified. The dated research record is
`backend/tools/cds-cache/2025-26-web-research.json`; institutions whose official
pages still exposed only 2024-25 on the research date are recorded explicitly
instead of receiving guessed document URLs.
