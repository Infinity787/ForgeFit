# ForgeFit

Gym and diet coach: workout splits with rest days, set-by-set logging (regular, drop and unilateral sets), a rest timer, progress charts, macro tracking (food library, saved foods, **estimates from a food photo**, including packaged products scaled to the amount you ate), diet-plan checklists, steps, and an AI coach that reads your real data.

It runs as an Android app (Capacitor) and as a website/PWA (Vercel). Both use the same Supabase backend: accounts and email codes through Supabase Auth, data in Postgres, and the API as a Supabase Edge Function.

```
index.html      the whole app (vanilla JS, no build step) — edit this copy
sw.js           service worker (offline app shell; never caches API calls)
manifest.json   PWA manifest
icons/          app icons
vercel.json     website headers for Vercel
www/            generated copy of the above: what Vercel and the Android app serve
android/        Capacitor Android project
supabase/       database migrations and the `api` Edge Function
tests/          app tests (jsdom) and API tests (Node + local Postgres)
update.sh       build the APK and install it on a USB-connected phone
```

## Develop

```bash
npm install
npm run sync:web
python3 -m http.server 5173 --directory www     # http://localhost:5173
```

The app talks to the Supabase project chosen by `FORGEFIT_BACKEND` in `index.html` (`production` or `staging`).

## Test

```bash
createdb forgefit_sb_test   # once (local Postgres)
npm test                    # app tests + API tests
```

## Ship

**Android:** `./update.sh` builds `ForgeFit.apk` and installs it on the connected phone.

**Website:** commit and push. Vercel deploys the `www/` folder automatically (Root Directory `www`, no build command). Run `npm run sync:web` before committing so `www/` has your changes.

**API / database:**

```bash
npx supabase link --project-ref <project-ref>
npx supabase db push                          # new migrations in supabase/migrations
npx supabase functions deploy api --use-api   # supabase/functions
```

Secrets (`GEMINI_API_KEY`) live in Supabase → Edge Functions → Secrets, never in the app.

## Where data lives

Account data is stored in Supabase Postgres in a private `app` schema that only the `api` function can reach. Each user can only access their own records. The app keeps an offline copy plus a queue of unsaved changes, and only reports “saved” once the server confirms.
