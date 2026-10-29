// Harness for testing the Supabase Edge Function (`api`) under Node: the real
// Hono app and SQL against a local Postgres that mimics Supabase (an
// auth.users table + anon/authenticated roles). Supabase Auth is faked.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../supabase/functions/_shared/app.mjs';
import { createDb } from '../../supabase/functions/_shared/db.mjs';

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-gemini-key';

const ROOT = path.join(import.meta.dirname, '..', '..');
const URL = process.env.TEST_SUPABASE_DB_URL || 'postgresql:///forgefit_sb_test?host=/tmp';

export const db = createDb(URL, { max: 5 });

export async function resetDb() {
  await db.query(`
    DROP SCHEMA IF EXISTS app CASCADE;
    DROP SCHEMA IF EXISTS auth CASCADE;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    END $$;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
  `);
  const dir = path.join(ROOT, 'supabase', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await db.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
}

// ---- fake Supabase Auth ----
const tokens = new Map();     // token -> { id, email }
const passwords = new Map();  // email -> { id, password }
export const authAdmin = {
  async passwordLogin(email, password) {
    const u = passwords.get(email);
    if (!u || u.password !== password) return null;
    const token = 'tok_' + randomUUID();
    tokens.set(token, { id: u.id, email });
    return { access_token: token, refresh_token: 'r_' + token, expires_in: 3600, token_type: 'bearer', user: { id: u.id, email } };
  },
  async deleteUser(id) {
    await db.query('DELETE FROM auth.users WHERE id = $1', [id]);
    for (const [t, u] of tokens) if (u.id === id) tokens.delete(t);
  },
};
export const verifyUser = async (token) => tokens.get(token) || null;

export const app = createApp({ db, verifyUser, authAdmin, limits: false });

/** Calls the app. Returns { status, body }. */
export async function call(method, urlPath, { token, body, headers, form } = {}) {
  const init = { method, headers: { ...(headers || {}) } };
  if (token) init.headers.authorization = 'Bearer ' + token;
  if (form) init.body = form;
  else if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await app.request('/api' + urlPath, init);
  let json = null;
  try { json = await res.json(); } catch (e) { /* empty */ }
  return { status: res.status, body: json };
}

/** A signed-in Supabase user (email verified) without a ForgeFit account yet. */
export async function verifiedUser(email) {
  const id = randomUUID();
  email = (email || `u_${id.slice(0, 8)}@example.com`).toLowerCase();
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, email]);
  const token = 'tok_' + randomUUID();
  tokens.set(token, { id, email });
  return { id, email, token };
}

let n = 0;
/** A fully set-up account: verified email + password + username. */
export async function createUser(prefix = 'user') {
  n += 1;
  const u = await verifiedUser();
  u.username = `${prefix}${n}`.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
  u.password = 'correct-horse-1';
  passwords.set(u.email, { id: u.id, password: u.password });
  const r = await call('POST', '/account/setup', { token: u.token, body: { username: u.username, name: 'Test ' + prefix } });
  if (r.status !== 201) throw new Error('setup failed: ' + JSON.stringify(r.body));
  return u;
}

export const sync = (token, ops) => call('POST', '/data/sync', { token, body: { ops } });
export const state = async (token) => (await call('GET', '/data', { token })).body.state;

/**
 * Minimal supertest-style adapter so the server tests written for the old
 * Express API run unchanged against this app:
 *   await request(app).post('/api/x').set({...}).send({...})  ->  { status, body }
 */
export function request(theApp) {
  const make = (method) => (p) => {
    const st = { headers: {}, body: undefined, form: null };
    const chain = {
      set(h, val) { if (typeof h === 'string') st.headers[h.toLowerCase()] = val; else Object.entries(h).forEach(([k, x]) => { st.headers[k.toLowerCase()] = x; }); return chain; },
      send(b) { st.body = b; return chain; },
      attach(field, buf, { filename, contentType }) {
        st.form = st.form || new FormData();
        st.form.append(field, new Blob([buf], { type: contentType }), filename);
        return chain;
      },
      then(resolve, reject) {
        const init = { method, headers: { ...st.headers } };
        if (st.form) init.body = st.form;
        else if (st.body !== undefined) { init.body = typeof st.body === 'string' ? st.body : JSON.stringify(st.body); init.headers['content-type'] = 'application/json'; }
        return theApp.request(p, init).then(async (res) => {
          let body = null;
          try { body = await res.json(); } catch (e) { /* empty */ }
          return { status: res.status, body };
        }).then(resolve, reject);
      },
    };
    return chain;
  };
  return { get: make('GET'), post: make('POST'), patch: make('PATCH'), delete: make('DELETE') };
}
export const auth = (token) => ({ Authorization: 'Bearer ' + token });
