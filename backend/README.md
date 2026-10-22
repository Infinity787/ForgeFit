# ForgeFit API

Node.js/Express service behind the ForgeFit app. It provides:

- **Accounts**: email + one-time-code signup, username/email + password login, password reset, change password, change username/email, delete account. Sessions are JWTs.
- **App data in PostgreSQL**: profiles, targets, routines, custom exercises, workouts → exercises → sets, meals and macros, steps, diet plans and daily check-offs, and coach history.
- **Legacy import**: a one-time, idempotent import of data that older app versions kept only on the device.
- **AI, server-side only**: Coach chat, online food search, and **food-photo macro estimates** via Google Gemini. The API key never reaches the app.

See [`../DEPLOYMENT.md`](../DEPLOYMENT.md) for production deployment, migration and rollback.

## Run locally

```bash
brew install postgresql@16 && brew services start postgresql@16   # or any Postgres 13+
createdb forgefit_dev
cp .env.example .env      # defaults point at postgresql:///forgefit_dev
npm install
npm run migrate           # also runs automatically on `npm start`
npm start                 # http://localhost:4000
```

To point a locally served web app at it, open the app on `http://localhost:<port>` and run this in the browser console:
`localStorage.setItem('forgefit_api_base', 'http://localhost:4000')` (this override only works on localhost dev servers).

With `EMAIL_MODE=console`, verification codes print to the terminal and are returned to the app for testing. **Never use console mode in production.**

## Tests

The tests run against a real PostgreSQL database that is wiped on every run (default `forgefit_test`):

```bash
createdb forgefit_test
npm test                                   # or TEST_DATABASE_URL=postgres://... npm test
```

They cover signup/login/reset, session revocation, per-user authorization (one user can never read or change another's rows), validation and transactional rollback, the legacy import (idempotency, concurrent duplicates, overlap, partial bad data), and the food-photo endpoint (file validation, error mapping, no auto-logging), with Gemini stubbed.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string. TLS is enabled automatically for non-local hosts (`DATABASE_SSL=true/false` to override). |
| `JWT_SECRET` | yes (prod) | Long random string used to sign sessions. The server refuses to start in production without a strong one. |
| `NODE_ENV` | yes (prod) | Set to `production`. |
| `CORS_ORIGIN` | yes (prod) | Comma-separated allowed origins, e.g. `https://your-site.netlify.app,https://localhost` (`https://localhost` is the Android app). |
| `EMAIL_MODE` | yes (prod) | `smtp` in production; `console` only for local dev. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | with smtp | Any SMTP provider (Resend, Postmark, SendGrid, Brevo, Gmail app password…). |
| `GEMINI_API_KEY` | for AI | Google AI Studio key. Without it, AI endpoints return a clear “not configured” error; everything else works. |
| `GEMINI_MODEL` | no | Defaults to `gemini-2.5-flash`. |
| `AI_HOURLY_LIMIT` | no | AI requests per user per hour (default 60). |
| `AUTO_MIGRATE` | no | `false` to skip migrations on boot and run `npm run migrate` yourself. |
| `PORT`, `TRUST_PROXY`, `DATABASE_POOL_MAX` | no | Usually leave unset. |

## API

All bodies are JSON unless noted. Authenticated routes need `Authorization: Bearer <token>`. Errors are `{"error": "message"}`.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | Liveness, DB and AI configuration status. |
| POST | `/api/auth/signup/start` · `/signup/verify` · `/signup/complete` | Email → code → username/password. |
| POST | `/api/auth/login` | `{username, password}`; `username` may be the email. |
| POST | `/api/auth/forgot/start` · `/forgot/verify` · `/forgot/complete` | Reset tokens are single-use; resets sign out other sessions. |
| GET | `/api/auth/me` | Current user. |
| PATCH | `/api/auth/account` | `{name?, username?}`. |
| POST | `/api/auth/email/start` · `/email/verify` | Change email; the code goes to the new address. |
| POST | `/api/auth/change-password` | Returns a fresh token; other sessions are signed out. |
| DELETE | `/api/auth/me` | Deletes the account and all of its data (cascade). |
| GET | `/api/data` | The signed-in user's full app state. |
| POST | `/api/data/sync` | `{ops:[…]}`: up to 500 idempotent operations, applied in one transaction (all or nothing). |
| POST | `/api/data/import` | `{source, data}`: one-time import of on-device data. Safe to repeat. |
| GET | `/api/data/imports` | Import history. |
| POST | `/api/ai/food-photo` | `multipart/form-data` with `photo` (JPEG/PNG/WebP/HEIC, ≤ 8 MB) and optional `note`. Returns an estimate only — nothing is logged. |
| POST | `/api/ai/food-search` | `{query}` → up to 5 foods with macros per 100 g. |
| POST | `/api/ai/coach` | `{message, context, history}` → `{reply}`. |

Sync operation types: `account.set`, `profile.set`, `targets.set`, `routine.set`, `customExercise.upsert|delete`, `workout.upsert|delete`, `meal.upsert|delete`, `steps.set`, `dietPlan.set`, `dietPlanCheck.set`, `coach.append`, `coach.clear`.

## Data model

Migrations live in [`migrations/`](migrations) and are applied in filename order, once each, under a Postgres advisory lock (`schema_migrations` records what ran).

- `users` (auth + `onboarded`, `split_type`, `session_epoch`), `otp_codes`, `used_tokens`
- `profiles`, `targets` — one row per user
- `custom_exercises`, `routine_days` → `routine_day_exercises`
- `workout_logs` → `workout_exercises` → `workout_sets` (`normal` / `dropset` with `drops` JSON / `unilateral` with left/right)
- `meal_logs` (with `source`: library, custom, online, photo, idea, import), `step_logs`
- `diet_plans` → `diet_plan_items`, `diet_plan_checks`
- `coach_messages`
- `data_imports` — import ledger, unique per (user, payload fingerprint)

Every user-owned table has `user_id … ON DELETE CASCADE`. Client-generated ids are unique per user (`UNIQUE (user_id, client_id)`), which makes retries and re-imports idempotent.

## Security and privacy

- Identity comes only from the verified session token. Every query is scoped by `user_id`; any ids in request bodies are looked up within that user's rows only.
- All input is validated server-side (types, ranges, lengths, dates, ids) before it reaches SQL, and all SQL is parameterised.
- Passwords use bcrypt. Password changes and resets bump `session_epoch`, which revokes older sessions immediately.
- Rate limits apply to login, OTP request/verify, and AI calls (per user). `trust proxy` is set so limits work behind Render's proxy.
- Logs never include request bodies, photos, tokens or OTP codes (in production). Error responses expose only messages written for users.
- **Food photos:** held in memory only for the duration of the request (never written to disk or the database, never logged), sent once to Google Gemini for analysis, then dropped. The app also resizes photos on the device before upload, which strips location and other metadata. Google's handling of API inputs follows the [Gemini API terms](https://ai.google.dev/gemini-api/terms): on a paid (billing-enabled) project, prompts and images aren't used to improve Google's products. On the free tier they may be. Enable billing on the key's project if that matters to you.

## Migrating accounts from the old SQLite backend

The previous version stored accounts in `data/forgefit.sqlite`. To carry them over (bcrypt hashes are reused, so passwords keep working):

```bash
npm install --no-save better-sqlite3
DATABASE_URL=postgres://... node scripts/migrate-sqlite-users.js /path/to/forgefit.sqlite --dry-run
DATABASE_URL=postgres://... node scripts/migrate-sqlite-users.js /path/to/forgefit.sqlite
```

The SQLite file is opened read-only, and existing Postgres users are never overwritten, so it's safe to re-run. Workout and meal data was never stored on the old server. It lives on users' devices and moves over through the in-app import.
