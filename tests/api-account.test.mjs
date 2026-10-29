// Accounts on the Supabase version: finishing signup (username), sign-in by
// username or email, account changes, deletion, and rate limits.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../supabase/functions/_shared/app.mjs';
import { db, resetDb, call, verifiedUser, createUser, sync, state, authAdmin, verifyUser } from './helpers/api.mjs';

before(resetDb);
after(() => db.close());

test('a verified email must choose a username before using the app', async () => {
  const u = await verifiedUser('new.person@example.com');
  const data = await call('GET', '/data', { token: u.token });
  assert.equal(data.status, 409);
  assert.equal(data.body.code, 'ACCOUNT_SETUP_REQUIRED');
  assert.equal((await call('GET', '/account', { token: u.token })).body.account, null);

  assert.equal((await call('POST', '/account/setup', { token: u.token, body: { username: 'No Spaces!' } })).status, 400);
  const ok = await call('POST', '/account/setup', { token: u.token, body: { username: 'New_Person', name: 'New Person' } });
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.body.account, { username: 'new_person', email: 'new.person@example.com', name: 'New Person' });

  // Retrying the same step is harmless; picking another name later isn't allowed here.
  assert.equal((await call('POST', '/account/setup', { token: u.token, body: { username: 'new_person' } })).status, 200);
  assert.equal((await call('POST', '/account/setup', { token: u.token, body: { username: 'someone_else' } })).status, 409);

  const s = (await call('GET', '/data', { token: u.token })).body.state;
  assert.equal(s.username, 'new_person');
  assert.equal(s.onboarded, false);
});

test('usernames are unique', async () => {
  const a = await createUser('taken');
  const b = await verifiedUser();
  const r = await call('POST', '/account/setup', { token: b.token, body: { username: a.username } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /already taken/);
});

test('sign in works with the username or the email, and never says which part was wrong', async () => {
  const u = await createUser('login');
  const byName = await call('POST', '/auth/login', { body: { username: u.username.toUpperCase(), password: u.password } });
  assert.equal(byName.status, 200);
  assert.ok(byName.body.session.access_token);
  assert.equal(byName.body.account.username, u.username);

  const byEmail = await call('POST', '/auth/login', { body: { username: u.email.toUpperCase(), password: u.password } });
  assert.equal(byEmail.status, 200);

  const wrong = await call('POST', '/auth/login', { body: { username: u.username, password: 'nope' } });
  const unknown = await call('POST', '/auth/login', { body: { username: 'nobody_here', password: 'nope' } });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(wrong.body.error, unknown.body.error);

  // The token it returns works for the data API.
  assert.equal((await call('GET', '/data', { token: byName.body.session.access_token })).status, 200);
});

test('repeated failed sign-ins for a username are rate limited', async () => {
  const limited = createApp({ db, verifyUser, authAdmin, limits: { login: 3, ai: 60 } });
  const u = await createUser('brute');
  const attempt = () => limited.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u.username, password: 'guess' }) });
  for (let i = 0; i < 3; i++) assert.equal((await attempt()).status, 401);
  const blocked = await attempt();
  assert.equal(blocked.status, 429);
});

test('protected routes reject missing or unknown tokens', async () => {
  for (const [m, p] of [['GET', '/data'], ['POST', '/data/sync'], ['GET', '/account'], ['PATCH', '/account'], ['DELETE', '/account'], ['POST', '/ai/coach']]) {
    assert.equal((await call(m, p)).status, 401, `${m} ${p} without a token`);
    assert.equal((await call(m, p, { token: 'forged' })).status, 401, `${m} ${p} with a bad token`);
  }
});

test('name and username can be changed; usernames stay unique', async () => {
  const a = await createUser('acctA');
  const b = await createUser('acctB');
  assert.equal((await call('PATCH', '/account', { token: a.token, body: { username: b.username } })).status, 400);
  const ok = await call('PATCH', '/account', { token: a.token, body: { username: 'renamed_a', name: 'New Name' } });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.user.username, ok.body.user.name], ['renamed_a', 'New Name']);
  const login = await call('POST', '/auth/login', { body: { username: 'renamed_a', password: a.password } });
  assert.equal(login.status, 200, 'the new username works for sign-in');
});

test('a changed login email (via Supabase Auth) is reflected in the account', async () => {
  const u = await createUser('mail');
  await db.query('UPDATE auth.users SET email = $2 WHERE id = $1', [u.id, 'changed@example.com']);
  assert.equal((await call('GET', '/account', { token: u.token })).body.account.email, 'changed@example.com');
});

test('deleting the account removes all of its data and ends the session', async () => {
  const u = await createUser('delete');
  await sync(u.token, [
    { type: 'meal.upsert', data: { uid: 'm1', date: '2026-10-01', meal: 'Lunch', name: 'Rice', cal: 200, p: 4, c: 44, f: 1 } },
    { type: 'workout.upsert', data: { id: 'w1', date: '2026-10-01', day: 'Push', exercises: [{ exId: 'ex0', sets: [{ reps: 5, weight: 60 }] }] } },
    { type: 'savedFood.upsert', data: { id: 'sf1', n: 'Oats', cal: 300, p: 10 } },
  ]);
  assert.equal((await state(u.token)).workoutLogs.length, 1);
  assert.equal((await call('DELETE', '/account', { token: u.token })).status, 200);
  const left = await db.query(
    `SELECT (SELECT count(*) FROM app.meal_logs WHERE user_id = $1) + (SELECT count(*) FROM app.workout_logs WHERE user_id = $1)
          + (SELECT count(*) FROM app.saved_foods WHERE user_id = $1) + (SELECT count(*) FROM app.accounts WHERE id = $1) AS n`,
    [u.id]
  );
  assert.equal(left.rows[0].n, 0);
  assert.equal((await call('GET', '/data', { token: u.token })).status, 401);
});

test('AI calls are limited per user per hour', async () => {
  const limited = createApp({ db, verifyUser, authAdmin, limits: { login: 10, ai: 2 } });
  const u = await createUser('ailimit');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) });
  try {
    const ask = () => limited.request('/api/ai/coach', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + u.token }, body: JSON.stringify({ message: 'hi' }) });
    assert.equal((await ask()).status, 200);
    assert.equal((await ask()).status, 200);
    assert.equal((await ask()).status, 429);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('health reports the database and AI configuration', async () => {
  const r = await call('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.database, 'ok');
});

test('CORS lets the Android app call the API', async () => {
  const { app } = await import('./helpers/api.mjs');
  const res = await app.request('/api/data', { method: 'OPTIONS', headers: { Origin: 'https://localhost', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.ok(res.status === 204 || res.status === 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});
