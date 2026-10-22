# ForgeFit

Gym and diet coach: workout splits, set-by-set logging (regular, drop and unilateral sets), progress charts, macro tracking (food library, online search, custom foods, **estimates from a food photo**), diet-plan checklists, steps, and an AI coach that reads your real data. It ships as a web app/PWA (Netlify) and an Android app (Capacitor), backed by an API with a PostgreSQL database.

```
index.html      the whole web app (vanilla JS, no build step) — edit this copy
sw.js           service worker (offline app shell; never caches API calls)
manifest.json   PWA manifest
icons/          app icons (monochrome)
www/            deployable copy of the web app (Netlify + Capacitor webDir)
android/        Capacitor Android project
backend/        ForgeFit API (Express + PostgreSQL) — see backend/README.md
tests/          client-side unit tests (sync/import logic)
DEPLOYMENT.md   production setup, data migration, backups and rollback
```

## Develop

```bash
# API (needs Postgres; see backend/README.md)
cd backend && cp .env.example .env && npm install && npm start      # :4000

# Web app
python3 -m http.server 5173                                          # from the project root
# then, once, in the browser console on http://localhost:5173:
#   localStorage.setItem('forgefit_api_base', 'http://localhost:4000')
```

`.claude/launch.json` has both as `api` and `web`.

## Test

```bash
createdb forgefit_test   # once
npm test                 # client sync tests + backend suite (auth, authorization, persistence, import, photo estimates)
```

## Ship

```bash
npm run sync:web          # copy index.html, sw.js, manifest.json, icons into www/
npm run android:copy      # …and into the Android project
```

Deploy the **`www/` folder** to Netlify (not the project root). Build the APK from `android/`. Full steps, environment variables, database migrations, backups and rollback are in [DEPLOYMENT.md](DEPLOYMENT.md).

## Where data lives

All account data is stored in PostgreSQL through the API. Each user can only access their own records. The app keeps an offline copy plus a queue of unsaved changes, and only reports “saved” once the server confirms. Data from older on-device-only versions is offered for a one-time, duplicate-safe import after login, and the original device copy is kept until the user removes it.
