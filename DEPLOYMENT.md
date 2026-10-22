# Deploying ForgeFit v2 (SQL-backed)

ForgeFit has three parts:

| Part | Where it runs | Source |
|---|---|---|
| Web app / PWA | Netlify (static) | `www/` (mirror of root `index.html`, `sw.js`, `manifest.json`, `icons/`) |
| Android app | Capacitor wrapper | `android/` (gets `www/` via `npx cap copy android`) |
| API | Render web service | `backend/` |
| Database | **PostgreSQL** (Render Postgres, or Neon/Supabase) | `backend/migrations/` |

## Why PostgreSQL

The existing API used SQLite on Render. Render's filesystem is ephemeral: the SQLite file is wiped on every deploy or restart unless a paid persistent disk is attached, and it can't be shared between instances. PostgreSQL is the simplest production-ready option for this setup. It's a managed service, Render offers it next to the existing web service, and Node's `pg` driver is a drop-in replacement. The code only needs a `DATABASE_URL`, so any Postgres host works.

- **Render Postgres** (recommended, same dashboard): create it in the same region as the API and use its *Internal Database URL*. Note that Render's free Postgres instances expire after 30 days, so use a paid instance (from ~$7/mo, with daily backups) for real users.
- **Neon** or **Supabase** have free tiers that don't expire. Use the pooled connection string with `sslmode=require`.

## 1. Create the database

Render → **New → PostgreSQL** → same region as `forgefit-backend` → create. Copy the *Internal Database URL*.

## 2. Deploy the API

Render currently builds `forgefit-backend` from the GitHub repo `Infinity787/ForgeFit` (your local clone is `~/Downloads/forgefit-backend`). Either:

- **(a)** copy the contents of `backend/` into that repo (replacing `server.js`, `src/`, `package*.json`, `README.md`, `.env.example`, `.gitignore`, adding `migrations/`, `scripts/` and `test/`), commit and push; or
- **(b)** push this whole project to a repo and set the Render service's **Root Directory** to `backend`.

Render settings: **Build** `npm ci`, **Start** `npm start`, **Health check path** `/api/health`.

Environment variables (Render → Environment). Never commit these:

```
NODE_ENV=production
DATABASE_URL=<internal database url>
JWT_SECRET=<at least 32 random characters: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))">
CORS_ORIGIN=https://<your-netlify-site>.netlify.app,https://localhost
EMAIL_MODE=smtp
SMTP_HOST=… SMTP_PORT=587 SMTP_SECURE=false SMTP_USER=… SMTP_PASS=…
EMAIL_FROM="ForgeFit <no-reply@yourdomain.com>"
GEMINI_API_KEY=<new key — see "Rotate keys" below>
```

On start, the server applies migrations automatically (`AUTO_MIGRATE=false` turns that off; then run `npm run migrate` from the Render shell before switching traffic). Check `https://<api>/api/health`: it should report `"database":"ok"` and `"ai":"configured"`.

## 3. Carry over existing accounts (optional)

If the old SQLite file still exists on the running Render instance (it's lost on redeploy), download it **before** deploying v2 (Render Shell → `cat data/forgefit.sqlite | base64`, or `scp` from an attached disk), then:

```bash
cd backend
npm install --no-save better-sqlite3
DATABASE_URL=<external database url> node scripts/migrate-sqlite-users.js forgefit.sqlite --dry-run
DATABASE_URL=<external database url> node scripts/migrate-sqlite-users.js forgefit.sqlite
```

Everyone signs in once after the upgrade: v1 session tokens are deliberately rejected, because their user ids refer to the old database. Their passwords still work if their account was carried over. Users whose accounts weren't carried over can simply sign up again with the same email. Their training data is on their device, not the old server, and the app offers to import it after login.

## 4. Deploy the web app

```bash
cp index.html sw.js manifest.json www/   # root is the editing copy; www/ is what ships
```

Netlify → your site → **Deploys** → drag the **`www/` folder** (not the project root, which now contains `backend/`). `www/` includes `_redirects` and `.well-known/` for the Android app link.

## 5. Build the Android app

```bash
export JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home ANDROID_HOME=~/Library/Android/sdk
npx cap copy android
cd android && ./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
```

Install with `adb install -r` (keeps the app's local data, including the old on-device copy that the import reads).

## How existing users' data moves over

Before v2, workouts, meals, routines and so on lived only in each device's `localStorage` (`forgefit_users_v1`). After updating:

1. The user logs in (or signs up, if they only ever had an on-device account).
2. The app detects device data that isn't in their account yet and shows **“Bring your existing data into your account” → Review & import** (also during onboarding, and under **Profile → Your data**).
3. The import runs on the server in one transaction. Existing account data always wins (profile, targets, diet plan aren't overwritten; missing routine days are added). Every record gets a stable id, and the payload's fingerprint is recorded in `data_imports`, so **running it twice, from two tabs at once, or from an overlapping backup file never creates duplicates**. Malformed legacy records are skipped and listed rather than failing the whole import.
4. **The original device copy is never modified or deleted automatically.** It stays in `forgefit_users_v1` as a backup. The user can download it or remove it from **Profile → Your data** once they've checked their account. Removing a copy that hasn't been imported asks for explicit confirmation.

Backup files (`Export backup` JSON) can be imported the same way: from the login screen (staged until login) or from **Profile → Import backup file**.

## Offline behaviour

The app keeps an offline copy of the signed-in account and a queue of unsaved changes (the difference between the working copy and the last server-confirmed copy). The top-bar status always shows the truth: **Saved**, **Saving…**, **N changes not saved** (offline: retries automatically with backoff, on reconnect, and on next launch), or **Couldn't save** (server rejected the data: the user can retry or discard local changes). Confirmation messages only say “saved” after the server confirms. Logging out with unsaved changes warns first and keeps them on the device.

## Backups

- **Render Postgres (paid)**: daily automatic backups with point-in-time recovery. Neon and Supabase have similar options.
- **Manual snapshot** (do this before every migration or risky deploy):
  ```bash
  pg_dump --format=custom --no-owner "$DATABASE_URL" > forgefit-$(date +%F).dump
  ```
- **Restore** into a fresh database:
  ```bash
  createdb forgefit_restore   # or create a new Render Postgres
  pg_restore --no-owner --dbname "$RESTORE_DATABASE_URL" forgefit-YYYY-MM-DD.dump
  ```

## Rollback

- **API code**: Render → Deploys → *Rollback* to the previous deploy. Migrations so far only add tables and columns, so the previous v2 build keeps working against the newer schema.
- **Back to v1 (SQLite) entirely**: redeploy the old API commit *and* the previous Netlify deploy/APK together. v1 only knows the accounts in its SQLite file (accounts created during v2 won't exist there). Users' original on-device data was never deleted by v2, so v1 clients still see it, but anything entered in v2 lives only in Postgres until you roll forward again.
- **Bad data/migration**: take a `pg_dump`, fix forward with a new migration file (never edit an applied one), or restore the last good dump into a new database and point `DATABASE_URL` at it.
- **Web app**: Netlify → Deploys → publish the previous deploy.

## Rotate keys (do this now)

- The previous app shipped a **Gemini API key inside `index.html`** (public on the website and inside the APK). It has been removed from the app. **Revoke it in Google AI Studio** and put a new key only in Render's `GEMINI_API_KEY`.
- `.codex/config.toml` in this folder contains a Stitch API key. Don't publish this folder as-is (deploy `www/` only), and rotate that key if the folder was ever uploaded.
- If the old API ran with `EMAIL_MODE=console`, it returned password-reset codes to whoever requested them. v2 never returns reset codes in production. Set up SMTP before launch.
