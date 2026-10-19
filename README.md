# ReferralOS

**One Platform. Every Referral Path.**

ReferralOS is a local-first employee referral platform prototype. It supports different, per-job referral workflows and keeps external actions clearly separate from activity that ReferralOS can verify.

## Requirements

- Node.js 24 or newer and npm.
- Windows, macOS, or Linux with a supported Node.js build that includes `node:sqlite`.
- No database server or cloud account is required for local development.

## Install and run

From the `ReferralOS` project directory:

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

Register a candidate account, employee account, or both. Employee registration requires a non-personal work email. Work-email verification uses a single-use, time-limited link and proves access to the address only; it does not establish employment or company authorization. Company-affiliation moderation remains separate and does not block publishing once the work email is verified, unless an affiliation is rejected or revoked. Existing employee accounts must add and verify a work email before publishing. Public registration cannot assign the admin role.

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
| `DEMO_MODE` | `false` | Set `true` for the public read-only pilot. Browsing and sign-in remain available; account registration, applications, referrals, messages, profile updates, job changes, imports/OCR, reports, and private file access are blocked. |
| `PORT` | `4000` | Express API port. |
| `HOST` | `127.0.0.1` in development; `0.0.0.0` in production | Interface to bind the API listener to. Set to the platform-required bind address when deploying. |
| `APP_ORIGINS` | `http://127.0.0.1:5173` | Comma-separated exact browser origins allowed for cookie-authenticated writes. `APP_ORIGIN` remains supported as a single-origin compatibility setting. |
| `DATABASE_PATH` | `./data/referralos.sqlite` | SQLite database file. |
| `RESUME_STORAGE_DIR` | `./data/private-resumes` | Private resume directory; keep outside web roots. |
| `JOB_IMPORT_STORAGE_DIR` | `./data/private-job-imports` | Private screenshot source directory. Store on persistent private storage. |
| `SESSION_DAYS` | `7` | Session lifetime, clamped to 1–30 days. |
| `PERSONAL_EMAIL_DOMAINS` | Common consumer domains | Comma-separated personal email domains rejected for employee work email. |
| `COMPANY_DOMAIN_MAPPINGS` | `{}` | Optional JSON object from company names to allowed domains, e.g. `{"Acme Ltd":["acme.example"]}`. Domain matching does not prove employment. |
| `EMAIL_VERIFICATION_MINUTES` | `30` | Work-email token lifetime, clamped to 5–1440 minutes. |
| `PUBLIC_APP_URL` | First `APP_ORIGINS` origin | Public app base used in verification links; configure a real domain at deployment. |
| `EMAIL_PROVIDER` | `console` in development; unconfigured in production | `console` creates a local authenticated link preview. Production supports `resend` and never falls back to console. |
| `EMAIL_FROM` | Unset | Verified sender address for Resend. |
| `RESEND_API_KEY` | Unset | Secret Resend API key; configure only in deployment secrets. |
| `SCREENSHOT_OCR_URL` | Unset | OCR.space image endpoint, normally `https://api.ocr.space/parse/image`. Production must use HTTPS. |
| `SCREENSHOT_OCR_API_KEY` | Unset | OCR.space key, sent only in the server-side `apikey` header. |

The frontend build is emitted to `apps/web/dist`. The Express app serves that directory if present, so production can run `npm run build` followed by `npm start`. Configure a persistent disk for both SQLite and private resumes before hosting; production multi-instance deployments should move to managed PostgreSQL and private object storage.

### Public read-only pilot

Set `DEMO_MODE=true` on the server before starting it. The API remains protected by the same exact-origin validation, CSRF checks, authentication, authorization, and rate limits. The central demo guard rejects state-changing API requests, including screenshot extraction, and blocks private resume/import files and account-specific data. Login and logout remain enabled; registration is unavailable. Turn the pilot off by setting `DEMO_MODE=false` or removing the variable and restarting the service. Do not use demo mode as a substitute for configuring production email or storage.

`GET /api/health` is a liveness check and confirms only that the HTTP process responds. `GET /api/ready` performs a minimal SQLite `SELECT 1`; it returns `{ "status": "ready" }` on success or a generic 503 `{ "status": "unavailable" }` on failure. The endpoint does not return paths or database errors.

## Security and integration boundaries

- Passwords use Node's scrypt implementation; sessions use opaque, hashed tokens in SQLite and HttpOnly, SameSite cookies. Production cookies are Secure.
- Mutating API requests require a same-origin check and a double-submit CSRF token. Login and registration are rate limited. API responses do not expose full candidate profiles.
- Resume upload accepts PDF files up to 5 MB and checks the PDF signature. Resume files are private. An employee can download a candidate's resume only after accepting that candidate's referral request and only when the candidate has enabled resume sharing.
- Referral links, forms, email addresses, and application completion are employee-provided or user-reported. Clicking an external link never marks an application as submitted. ReferralOS does not connect to company hiring systems or submit referrals.
- Development verification previews are local-only and available to the signed-in employee. Production verification requires `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM`, and `PUBLIC_APP_URL`; the UI reports only that Resend accepted the delivery request and does not claim final inbox delivery. Password reset email and malware scanning are not implemented. Corporate identity verification, hosted database/storage credentials, and deployment credentials are not configured in this environment.

## Deployment checklist

- Set `NODE_ENV=production`, exact `APP_ORIGINS`, `PUBLIC_APP_URL`, `EMAIL_PROVIDER=resend`, `EMAIL_FROM`, and `RESEND_API_KEY` in hosting configuration.
- Build with `npm run build`; run `npm run db:migrate` before `npm start`.
- Mount durable private storage for `DATABASE_PATH` and `RESUME_STORAGE_DIR`. Back up SQLite regularly; do not place private resumes under the static web root.
- Terminate TLS at the host or reverse proxy so Secure cookies work. Use `/api/health` for liveness and `/api/ready` for SQLite readiness; never log request bodies or verification URLs.
- Verify sender-domain setup with Resend, configure the real public base URL, and test mail delivery with a non-production account.
- Review moderation, retention, incident response, legal policy text, and privacy obligations before public launch. No external deployment has been performed.
- Move to managed PostgreSQL and private object storage when write volume, multiple app instances, backup/RPO needs, or file volume exceed a single persistent-disk deployment.

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

