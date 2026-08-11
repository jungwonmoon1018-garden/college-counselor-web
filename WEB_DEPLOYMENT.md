# Website deployment

The website build serves the existing React student app, counselor administrator
page, Express API, and simulation service from one container. It keeps the
desktop flow intact.

## Required platform configuration

Configure these values in the hosting platform, not in the repository:

- `WEB_CONFIG_KEY`: at least 32 random characters. This wraps the encrypted
  counselor configuration file and must not be rotated without first migrating it.
- `WEB_ADMIN_BOOTSTRAP_TOKEN`: at least 24 random characters. The counselor uses
  it once when creating the first administrator account.
- `DATA_DIR`: a persistent mounted directory, such as `/data`.
- `PUBLIC_APP_URL`: the final HTTPS origin when the platform uses a custom domain.
  Same-origin deployments also work without it.

`render.yaml` supplies a one-service Render Blueprint with generated platform
secrets and a persistent disk. The app uses SQLite and local encrypted files, so
run one service instance rather than horizontally scaling it.

## Counselor first run

1. Open `/admin.html` on the deployed HTTPS site.
2. Enter the platform's `WEB_ADMIN_BOOTSTRAP_TOKEN` and create a password of at
   least 12 characters.
3. Store the one-time recovery code offline.
4. Enter a 64-character hexadecimal vault encryption key. This is a distinct
   counselor-held key and is immutable after it is saved.
5. Enter the OpenRouter API key and the IPEDS / College Scorecard API key.
6. Review the Small, Medium, and Large OpenRouter model choices and save them.

Student API access remains closed until all three counselor secrets are valid.
The browser receives configuration status only, never a stored secret value.

## Current reviewed OpenRouter choices

The model registry was checked against OpenRouter on 2026-08-11. The reviewed
choices are DeepSeek V4 Flash 0731 and V4 Pro, OpenAI GPT-5.6 Luna, Terra, and Sol,
Anthropic Claude Sonnet 5, and Google Gemini 3.6 Flash and 3.5 Flash Lite.
The backend also refreshes OpenRouter's live catalog daily and shows current
availability in the counselor screen.

Source pages: [DeepSeek](https://openrouter.ai/deepseek),
[OpenAI](https://openrouter.ai/openai),
[Anthropic](https://openrouter.ai/anthropic), and
[Google](https://openrouter.ai/google).

## Local container check

Build the image, mount a persistent Docker volume at `/data`, and provide the two
platform values as environment variables. For plain local HTTP only, set
`WEB_COOKIE_SECURE=0`; hosted deployments should keep the default secure cookie.

Back up the persistent data directory together with the platform-managed
`WEB_CONFIG_KEY`. Losing either the vault encryption key or wrapping key makes
the corresponding encrypted data unrecoverable.

## 2025–26 CDS research

The searchable source index includes 2025–26 official university publications
where they could be verified. The dated research record is
`backend/tools/cds-cache/2025-26-web-research.json`; institutions whose official
pages still exposed only 2024–25 on the research date are recorded explicitly
instead of receiving guessed document URLs.
