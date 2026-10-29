// The ForgeFit API (one Supabase Edge Function, `api`). Same routes and
// behaviour as the old Express server, with Supabase Auth for identity.
//
// Identity always comes from the verified access token — never from the
// request body — and every query is scoped to that user.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import * as v from './validate.mjs';
import * as store from './store.mjs';
import { importForUser } from './importer.mjs';
import * as gemini from './gemini.mjs';
import * as ai from './ai.mjs';

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const KB = 1024;

function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  e.expose = true;
  Object.assign(e, extra || {});
  return e;
}

async function readJson(c, maxBytes) {
  const len = Number(c.req.header('content-length') || 0);
  if (len > maxBytes) throw httpError(413, 'Request is too large.');
  const text = await c.req.text();
  if (text.length > maxBytes) throw httpError(413, 'Request is too large.');
  if (!text) return {};
  try { return JSON.parse(text); } catch (e) { throw httpError(400, 'Malformed JSON.'); }
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * @param {object} deps
 * @param {object} deps.db          { query, tx }
 * @param {Function} deps.verifyUser  token -> { id, email } | null
 * @param {object} deps.authAdmin   { passwordLogin(email, pw), deleteUser(id) }
 * @param {object} [deps.limits]    { ai: per-hour, login: per-15-min }; false disables (tests)
 */
export function createApp({ db, verifyUser, authAdmin, limits = { ai: 60, login: 10 } }) {
  const app = new Hono().basePath('/api');

  app.use('*', cors({
    origin: '*',
    allowHeaders: ['authorization', 'apikey', 'content-type', 'x-client-info'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  }));

  app.onError((err, c) => {
    if (err instanceof v.ValidationError || err.expose) {
      return c.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status || 400);
    }
    // Never log request bodies: they can hold personal data or photos.
    console.error(`[error] ${c.req.method} ${c.req.path}:`, err && (err.code || ''), err && err.message);
    return c.json({ error: 'Something went wrong on our side. Please try again.' }, 500);
  });
  app.notFound((c) => c.json({ error: 'Not found.' }, 404));

  /* ---------- rate limits (fixed windows stored in Postgres) ---------- */
  async function allow(key, windowSec, max) {
    if (!limits || !max) return true;
    const r = await db.query(
      `INSERT INTO app.rate_limits (key, window_start, count)
       VALUES ($1, to_timestamp(floor(extract(epoch from now()) / $2) * $2), 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = app.rate_limits.count + 1
       RETURNING count`,
      [key, windowSec]
    );
    if (Math.random() < 0.02) db.query("DELETE FROM app.rate_limits WHERE window_start < now() - interval '1 day'").catch(() => {});
    return r.rows[0].count <= max;
  }

  /* ---------- auth guards ---------- */
  const requireUser = async (c, next) => {
    const header = c.req.header('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const user = token ? await verifyUser(token) : null;
    if (!user) return c.json({ error: 'Your session has ended. Please log in again.' }, 401);
    c.set('user', user);
    await next();
  };
  const requireAccount = async (c, next) => {
    const user = c.get('user');
    const { rows } = await db.query('SELECT username, email, name FROM app.accounts WHERE id = $1', [user.id]);
    if (!rows[0]) return c.json({ error: 'Finish setting up your account first.', code: 'ACCOUNT_SETUP_REQUIRED' }, 409);
    c.set('account', rows[0]);
    await next();
  };
  const publicAccount = (a) => a && ({ username: a.username, email: a.email, name: a.name });

  /* ---------- health ---------- */
  app.get('/health', async (c) => {
    let database = 'ok';
    try { await db.query('SELECT 1'); } catch (e) { database = 'unavailable'; }
    return c.json({ ok: database === 'ok', service: 'forgefit-api', database, ai: gemini.configured() ? 'configured' : 'not-configured', time: new Date().toISOString() }, database === 'ok' ? 200 : 503);
  });

  /* ---------- sign in by username or email ---------- */
  app.post('/auth/login', async (c) => {
    const body = await readJson(c, 4 * KB);
    const login = v.text(body.username, 'username', { max: 254 }).toLowerCase();
    const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
    if (!(await allow('login:' + login, 15 * 60, limits && limits.login))) {
      throw httpError(429, 'Too many login attempts. Please try again later.');
    }
    let email = login;
    if (!login.includes('@')) {
      const { rows } = await db.query('SELECT email FROM app.accounts WHERE username = $1', [login]);
      email = rows[0] ? rows[0].email : null;
    }
    // Same answer for an unknown username and a wrong password.
    const session = email && password ? await authAdmin.passwordLogin(email, password) : null;
    if (!session) throw httpError(401, 'Incorrect username or password.');
    const { rows } = await db.query('SELECT username, email, name FROM app.accounts WHERE id = $1', [session.user.id]);
    return c.json({ ok: true, session, account: publicAccount(rows[0]) || null });
  });

  /* ---------- account ---------- */
  app.get('/account', requireUser, async (c) => {
    const { rows } = await db.query('SELECT username, email, name FROM app.accounts WHERE id = $1', [c.get('user').id]);
    return c.json({ ok: true, account: publicAccount(rows[0]) || null });
  });

  // Last signup step: choose a username (the email is already verified by Auth).
  app.post('/account/setup', requireUser, async (c) => {
    const user = c.get('user');
    const body = await readJson(c, 4 * KB);
    const username = String(body.username || '').trim().toLowerCase();
    const name = String(body.name || '').trim().slice(0, 80) || username;
    if (!USERNAME_RE.test(username)) throw httpError(400, 'Username: 3-20 characters, letters/numbers/underscore only.');
    const existing = await db.query('SELECT username, email, name FROM app.accounts WHERE id = $1', [user.id]);
    if (existing.rows[0]) {
      if (existing.rows[0].username === username) return c.json({ ok: true, account: publicAccount(existing.rows[0]) });
      throw httpError(409, 'This account is already set up.');
    }
    try {
      const { rows } = await db.query(
        'INSERT INTO app.accounts (id, username, email, name) VALUES ($1, $2, $3, $4) RETURNING username, email, name',
        [user.id, username, user.email, name]
      );
      return c.json({ ok: true, account: publicAccount(rows[0]) }, 201);
    } catch (e) {
      if (e.code === '23505') throw httpError(400, 'That username is already taken.');
      throw e;
    }
  });

  app.patch('/account', requireUser, requireAccount, async (c) => {
    const user = c.get('user');
    const account = c.get('account');
    const body = await readJson(c, 4 * KB);
    const updates = {};
    if (body.name !== undefined) {
      const name = String(body.name || '').trim().slice(0, 80);
      if (!name) throw httpError(400, 'Name cannot be empty.');
      updates.name = name;
    }
    if (body.username !== undefined) {
      const username = String(body.username || '').trim().toLowerCase();
      if (!USERNAME_RE.test(username)) throw httpError(400, 'Username: 3-20 chars, letters/numbers/underscore only.');
      if (username !== account.username) updates.username = username;
    }
    const keys = Object.keys(updates);
    if (!keys.length) return c.json({ ok: true, user: publicAccount(account) });
    try {
      const { rows } = await db.query(
        `UPDATE app.accounts SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now()
         WHERE id = $1 RETURNING username, email, name`,
        [user.id, ...keys.map((k) => updates[k])]
      );
      return c.json({ ok: true, user: publicAccount(rows[0]) });
    } catch (e) {
      if (e.code === '23505') throw httpError(400, 'That username is already taken.');
      throw e;
    }
  });

  // Permanently deletes the account; every ForgeFit table cascades from auth.users.
  app.delete('/account', requireUser, async (c) => {
    await authAdmin.deleteUser(c.get('user').id);
    return c.json({ ok: true });
  });

  /* ---------- app data ---------- */
  app.get('/data', requireUser, requireAccount, async (c) => {
    const state = await store.loadState(db, c.get('user').id);
    return c.json({ ok: true, state, serverTime: new Date().toISOString() });
  });

  app.post('/data/sync', requireUser, requireAccount, async (c) => {
    const body = await readJson(c, 1024 * KB);
    const ops = v.arr(body && body.ops, 'ops', 500);
    const userId = c.get('user').id;
    await db.tx(async (tx) => {
      for (let i = 0; i < ops.length; i++) await store.applyOp(tx, userId, ops[i], i);
    });
    return c.json({ ok: true, applied: ops.length, serverTime: new Date().toISOString() });
  });

  app.post('/data/import', requireUser, requireAccount, async (c) => {
    const body = v.obj(await readJson(c, 5 * 1024 * KB), 'body');
    const result = await importForUser(db, c.get('user').id, body.data, body.source);
    return c.json({ ok: true, ...result });
  });

  app.get('/data/imports', requireUser, requireAccount, async (c) => {
    const { rows } = await db.query(
      'SELECT id, source, counts, created_at FROM app.data_imports WHERE user_id = $1 ORDER BY id DESC LIMIT 20',
      [c.get('user').id]
    );
    return c.json({ ok: true, imports: rows });
  });

  /* ---------- AI (Gemini key stays on the server) ---------- */
  const aiLimit = async (c, next) => {
    if (!(await allow('ai:' + c.get('user').id, 3600, limits && limits.ai))) {
      throw httpError(429, 'You’ve hit the hourly AI limit. Try again later.');
    }
    await next();
  };

  // The photo is held in memory for this request only, sent once to Gemini,
  // then dropped. It is never written to disk, the database, or the logs.
  app.post('/ai/food-photo', requireUser, requireAccount, aiLimit, async (c) => {
    const len = Number(c.req.header('content-length') || 0);
    if (len > ai.MAX_PHOTO_BYTES + 64 * KB) throw httpError(413, 'That photo is too large (max 8 MB).');
    let form;
    try { form = await c.req.formData(); } catch (e) { throw httpError(400, 'Couldn’t read the upload.'); }
    const file = form.get('photo');
    if (!file || typeof file === 'string') throw httpError(400, 'Attach a photo of your meal.');
    if (file.size > ai.MAX_PHOTO_BYTES) throw httpError(413, 'That photo is too large (max 8 MB).');
    if (!ai.PHOTO_TYPES.includes(file.type)) throw httpError(400, 'Unsupported file type. Use a JPEG, PNG, WebP or HEIC photo.');
    let bytes = new Uint8Array(await file.arrayBuffer());
    const mime = ai.sniffImage(bytes);
    if (!mime) throw httpError(415, 'That file isn’t a supported image. Use a JPEG, PNG, WebP or HEIC photo.');
    const rawNote = form.get('note');
    const note = typeof rawNote === 'string' ? rawNote.trim().slice(0, 200) : '';
    let raw;
    try {
      raw = await gemini.generateJson({
        schema: ai.PHOTO_SCHEMA,
        temperature: 0.2,
        signal: c.req.raw.signal,
        contents: [{
          role: 'user',
          parts: [
            { inline_data: { mime_type: mime, data: toBase64(bytes) } },
            { text: ai.PHOTO_PROMPT + (note ? `\nThe user adds this context: "${note.replace(/"/g, "'")}"` : '') },
          ],
        }],
      });
    } finally {
      bytes = null; // drop the photo as soon as the upstream call is done
    }
    return c.json({ ok: true, estimate: ai.normalisePhotoEstimate(raw) });
  });

  app.post('/ai/food-search', requireUser, requireAccount, aiLimit, async (c) => {
    const body = await readJson(c, 64 * KB);
    const query = v.text(body.query, 'query', { max: 100 });
    const raw = await gemini.generateJson({
      schema: ai.SEARCH_SCHEMA,
      temperature: 0.2,
      contents: [{ role: 'user', parts: [{ text: `For the food "${query.replace(/"/g, "'")}", list up to 5 closely related food items with typical nutrition per 100 g: name, cal (kcal), p (protein g), c (carbs g), f (fat g). Give realistic best estimates.` }] }],
    });
    const results = (Array.isArray(raw) ? raw : []).slice(0, 5)
      .filter((r) => r && r.name)
      .map((r) => ({
        name: String(r.name).slice(0, 80),
        cal: Math.round(ai.clamp(r.cal, 0, 1000)),
        p: ai.round1(ai.clamp(r.p, 0, 100)), c: ai.round1(ai.clamp(r.c, 0, 100)), f: ai.round1(ai.clamp(r.f, 0, 100)),
      }));
    return c.json({ ok: true, results });
  });

  app.post('/ai/coach', requireUser, requireAccount, aiLimit, async (c) => {
    const body = await readJson(c, 64 * KB);
    const message = v.text(body.message, 'message', { max: 2000 });
    const context = v.text(body.context || '', 'context', { max: 6000, min: 0, optional: true }) || '';
    const history = v.arr(body.history || [], 'history', 12).map((m, i) => ({
      role: m && m.who === 'user' ? 'user' : 'model',
      parts: [{ text: v.text(String((m && m.text) || '').replace(/<[^>]*>/g, ''), `history[${i}].text`, { max: 4000 }) }],
    }));
    while (history.length && history[0].role !== 'user') history.shift();
    history.push({ role: 'user', parts: [{ text: message }] });
    const reply = await gemini.generate({ system: `${ai.COACH_PERSONA}\n\nUser data:\n${context}`, contents: history, temperature: 0.7 });
    return c.json({ ok: true, reply: reply.trim().slice(0, 4000) });
  });

  return app;
}
