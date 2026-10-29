// ForgeFit API — Supabase Edge Function. All routes live in ../_shared/app.mjs
// (shared with the Node test suite); this file only wires up the environment.
import { createApp } from '../_shared/app.mjs';
import { createDb } from '../_shared/db.mjs';
import { createSupabaseAuth } from '../_shared/supabase-auth.mjs';

const env = (k: string) => Deno.env.get(k) ?? '';

const db = createDb(env('SUPABASE_DB_URL'), { max: 3 });
const auth = createSupabaseAuth({
  url: env('SUPABASE_URL'),
  anonKey: env('SUPABASE_ANON_KEY'),
  serviceKey: env('SUPABASE_SERVICE_ROLE_KEY'),
});

const app = createApp({
  db,
  verifyUser: auth.verifyUser,
  authAdmin: auth,
  limits: { ai: Number(env('AI_HOURLY_LIMIT') || 60), login: 10 },
});

Deno.serve(app.fetch);
