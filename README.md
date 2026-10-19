# ReferralOS

**One Platform. Every Referral Path.**

ReferralOS is an independent employee referral platform. It supports different, per-job referral workflows and keeps external actions clearly separate from activity that ReferralOS can verify. A production service can run the complete authenticated workflows on one persistent SQLite volume; it must run as a single application instance.

## Requirements

- Node.js 24 or newer and npm.
- Windows, macOS, or Linux with a supported Node.js build that includes `node:sqlite`.
- No database server or cloud account is required for local development.

## Install and run

From the repository root:

```powershell
Copy-Item .env.example .env
npm install
npm run db:migrate
npm run db:seed
npm run dev
```

Open `http://127.0.0.1:5173`. The Vite frontend proxies `/api` calls to the Express API at `http://127.0.0.1:4000`. The SQLite database is stored at `data/referralos.sqlite`; uploaded resumes are stored privately in `data/private-resumes` and are not served as static files.

Sample listings use reserved `.example` / `.example.test` domains and are marked **DEMO LISTING**. They are fictional examples, not current vacancies, verified companies, or official partnerships. Their example contact addresses do not deliver email.

## Accounts and roles

Register a candidate account, employee/referrer account, or both. A work email is optional. If supplied, it must be a non-personal address and the employee can request a single-use, time-limited verification link. Verification confirms access to that email address only; it does not establish employment or authority to represent a company. New affiliations are pending by default, but pending status does not block job publishing; an affiliation marked rejected or revoked does. Work-email verification is not a requirement for registration or job publishing. Public registration cannot assign administrator privileges. Password reset is not implemented.

For the first local administrator, register an account, then run:

```powershell
npm run admin:grant -- your-email@example.com
```

The command requires the operator to confirm the exact account email in the terminal. It is a local CLI operation, not a public API route. Sign out and back in after an admin role is granted.

## Database operations

```powershell
npm run db:migrate
npm run db:seed
```

Migrations are ordered SQL files under `apps/api/migrations`. Seeding is idempotent and adds six clearly marked fictional jobs representing all six workflow templates. It does not create a usable demo login.

## Build and tests

```powershell
npm test
npm run build
```

Tests use temporary SQLite files and Node's built-in test runner. The app itself stores all account, job, workflow, bookmark, referral, notification, report, verification, and audit data in SQLite.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | Set `production` to enable secure-only session cookies. |
| `DEMO_MODE` | `false` | Must be explicitly set to `false` for a live production service. `true` enables the optional read-only pilot and blocks registration and state-changing/private-data workflows. |
| `PORT` | `4000` | Express API port. |
| `HOST` | `127.0.0.1` in development; `0.0.0.0` in production | Interface for the API listener. Railway deployment should bind to `0.0.0.0`; Railway supplies `PORT`. |
| `APP_ORIGINS` | `http://127.0.0.1:5173` | Comma-separated exact browser origins allowed for cookie-authenticated writes. `APP_ORIGIN` remains supported as a single-origin compatibility setting. |
| `DATABASE_PATH` | `./data/referralos.sqlite` | SQLite database file. Production: use a path such as `/data/referralos.sqlite` on the mounted persistent volume. |
| `RESUME_STORAGE_DIR` | `./data/private-resumes` | Private resume directory; production example `/data/private-resumes`, outside all web/static roots. |
| `JOB_IMPORT_STORAGE_DIR` | `./data/private-job-imports` | Private screenshot source directory; production example `/data/private-job-imports`, outside all web/static roots. |
| `SESSION_DAYS` | `7` | Session lifetime, clamped to 1–30 days. |
| `PERSONAL_EMAIL_DOMAINS` | Common consumer domains | Comma-separated personal email domains rejected for employee work email. |
| `COMPANY_DOMAIN_MAPPINGS` | `{}` | Optional JSON object from company names to allowed domains, e.g. `{"Acme Ltd":["acme.example"]}`. Domain matching does not prove employment. |
| `EMAIL_VERIFICATION_MINUTES` | `30` | Work-email token lifetime, clamped to 5–1440 minutes. |
| `PUBLIC_APP_URL` | First `APP_ORIGINS` origin | Public app base used in verification links; configure a real domain at deployment. |
| `EMAIL_PROVIDER` | `console` in development; unconfigured in production | Production work-email verification delivery requires `resend`. There is no production console fallback. |
| `EMAIL_FROM` | Unset | Sender address verified with Resend; required for verification email delivery. |
| `RESEND_API_KEY` | Unset | Resend API secret; configure only in Railway's server-side secret variables. |
| `SCREENSHOT_OCR_URL` | Unset | Optional OCR.space endpoint. Use `https://api.ocr.space/parse/image`; production requires HTTPS. |
| `SCREENSHOT_OCR_API_KEY` | Unset | OCR.space secret, sent only in the server-side `apikey` header. Configure as a deployment secret. |

The frontend build is emitted to `apps/web/dist`. Express serves that directory and the `/api` endpoints from the same origin. The server runs SQLite migrations before it starts accepting requests. Configure and mount a persistent Railway volume at `/data` before the first production boot, then set the database and both private storage paths to `/data/...`. Without that volume, SQLite data and uploads are ephemeral and can be lost on redeploy/restart. This SQLite deployment must use one application instance; horizontal scaling is unsupported. Automated off-host backups are not configured.

### Demo mode (optional)

For an optional read-only presentation, set `DEMO_MODE=true` on the server and restart. The API keeps exact-origin validation, CSRF, authentication, authorization, and rate limits enabled, while blocking registration, application writes, OCR, and private file/account data. For a live production launch, explicitly set `DEMO_MODE=false`; this is also the application default when the variable is absent. Restart after changing the setting. Do not use demo mode as a substitute for configuring production email or storage.

`GET /api/health` is a liveness check and confirms only that the HTTP process responds. `GET /api/ready` performs a minimal SQLite `SELECT 1`; it returns `{ "status": "ready" }` on success or a generic 503 `{ "status": "unavailable" }` on failure. The endpoint does not return paths or database errors.

## Security and integration boundaries

- Passwords use Node's scrypt implementation; sessions use opaque, hashed tokens in SQLite and HttpOnly, SameSite cookies. Production cookies are Secure.
- Mutating API requests require a same-origin check and a double-submit CSRF token. Login and registration are rate limited. API responses do not expose full candidate profiles.
- Resume upload accepts PDF files up to 5 MB and checks the PDF signature. Resume files are private. An employee can download a candidate's resume only after accepting that candidate's referral request and only when the candidate has enabled resume sharing.
- Referral links, forms, email addresses, and application completion are employee-provided or user-reported. Clicking an external link never marks an application as submitted. ReferralOS does not connect to company hiring systems or submit referrals.
- Development work-email verification previews are local-only and available to the signed-in employee. To deliver work-email verification in production, configure `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, a Resend-verified `EMAIL_FROM`, and the correct `PUBLIC_APP_URL`. If any are missing or Resend does not accept the request, the API reports that verification email was not sent; candidate registration/login and employee registration without a work email still work, and no development preview is used in production. If no provider or verified sender is configured, work-email verification delivery is unavailable. The app does not send general account-registration confirmation or password-reset email; password reset is not implemented. Work-email verification is optional and does not establish company affiliation or block publishing for a pending affiliation.

## Railway production setup (manual; no deployment performed)

1. Create one Railway service for this repository. Set the build command to `npm run build` and the start command to `npm start`. Startup creates the configured directories, applies pending SQLite migrations, performs maintenance, then listens on Railway's `PORT`. Do not run multiple replicas with this SQLite configuration.
2. Attach a Railway persistent volume mounted at `/data` **before the first production boot**. Set `DATABASE_PATH=/data/referralos.sqlite`, `RESUME_STORAGE_DIR=/data/private-resumes`, and `JOB_IMPORT_STORAGE_DIR=/data/private-job-imports`. Keep the database and private files off the static web root. Do not deploy with these paths on ephemeral container storage.
3. Configure `NODE_ENV=production`, `DEMO_MODE=false`, and `HOST=0.0.0.0`. Let Railway supply `PORT`. Once the final HTTPS domain exists, set `APP_ORIGINS` to that exact origin (scheme and host only, no path) and `PUBLIC_APP_URL` to the same HTTPS base URL. Do not use a wildcard origin.
4. For actual work-email verification delivery, configure Resend with `EMAIL_PROVIDER=resend`, `EMAIL_FROM` set to a sender/domain verified in Resend, and `RESEND_API_KEY` as a Railway secret. Test delivery before inviting employees. If this is not configured, the app still supports candidate accounts and login, but cannot send employee work-email verification. No password-reset email flow exists.
5. To enable screenshot OCR, configure `SCREENSHOT_OCR_URL=https://api.ocr.space/parse/image` and `SCREENSHOT_OCR_API_KEY` as a Railway secret. The employee must explicitly consent before screenshots are sent to OCR.space. OCR transcribes text for manual review; it does not populate verified employer facts. Without these variables, employees can create drafts and enter details manually, but extraction is unavailable.
6. Build and start with the commands above. Check `/api/health` for process liveness and `/api/ready` for SQLite readiness. Secure cookies require HTTPS in production. Check logs and test registration, login/logout, bookmarks, job posting, referral request/status/message flows, private resume authorization, import drafts, and email/OCR only after their providers are configured.

This repository does not configure backups. Before accepting valuable user data, establish and test encrypted backups of the SQLite database and private upload directories, and document restore operations. SQLite supports one app instance here; multi-instance hosting or higher availability requires a separately completed database/storage migration. Review moderation, retention, incident response, legal policy text, and privacy obligations before inviting the public.

## Project layout

```text
apps/
  api/       Express routes, validation, security, SQLite migrations, and API tests
  web/       React + TypeScript + Vite pages and responsive components
data/        Local SQLite database and private local resumes (ignored by git)
```

## Screenshot-to-job drafts

Employee accounts can upload up to five PNG/JPEG images (6 MB each) to a private job draft. The server validates MIME type and image signatures, stores files under JOB_IMPORT_STORAGE_DIR with random names outside the web root, and retains temporary source images for up to 30 days. The server deletes expired source images every six hours and records an audit event. Draft data remains private and is excluded from public search until the employee confirms review and explicitly publishes. Discarding a draft deletes its remaining source images.

OCR.space can be used for text transcription by setting SCREENSHOT_OCR_URL to `https://api.ocr.space/parse/image` (or another trusted HTTPS OCR.space endpoint) and SCREENSHOT_OCR_API_KEY on the server. The adapter sends each image as multipart form data with the API key in the `apikey` header. The user must explicitly consent before screenshots leave the server. OCR.space returns recognized text, not structured job fields; ReferralOS places that text in the editable description evidence and leaves other fields empty for review. Provider failures are logged only as a failure category and HTTP status, and the API does not return provider response content or credentials. Extraction remains disabled when either setting is missing, and all OCR calls are blocked when `DEMO_MODE=true`.

### Railway proxy and rate-limit note

The API keeps Express proxy trust disabled; login and registration rate limits therefore use the direct socket/request IP, and do not trust client-supplied `X-Forwarded-For` or `X-Real-IP` headers. Railway documents an `X-Real-IP` request header, but this checkout has not verified through a Railway deployment whether that header is overwritten at the edge and cannot be spoofed by a client. Until that trust boundary is verified with Railway, requests sharing the proxy-facing address may share a rate-limit bucket. Limits are not loosened to compensate.

