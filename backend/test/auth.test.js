const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { app, db, request, resetDb, createUser, auth } = require('./helpers');

before(resetDb);
after(() => db.close());

test('signup creates an account and returns a working session', async () => {
  const u = await createUser('signup');
  const me = await request(app).get('/api/auth/me').set(auth(u.token));
  assert.equal(me.status, 200);
  assert.equal(me.body.username, u.username);
  assert.equal(me.body.email, u.email);
  assert.equal(me.body.password_hash, undefined, 'never expose the hash');
});

test('signup rejects a duplicate email and a wrong OTP', async () => {
  const u = await createUser('dupe');
  const again = await request(app).post('/api/auth/signup/start').send({ name: 'X', email: u.email });
  assert.equal(again.status, 400);

  const email = 'otp-check@example.com';
  await request(app).post('/api/auth/signup/start').send({ name: 'X', email });
  const bad = await request(app).post('/api/auth/signup/verify').send({ email, code: '000000' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Incorrect code/);
});

test('login works with username or email, and rejects a wrong password', async () => {
  const u = await createUser('login');
  const byName = await request(app).post('/api/auth/login').send({ username: u.username, password: u.password });
  assert.equal(byName.status, 200);
  const byEmail = await request(app).post('/api/auth/login').send({ username: u.email.toUpperCase(), password: u.password });
  assert.equal(byEmail.status, 200);
  const wrong = await request(app).post('/api/auth/login').send({ username: u.username, password: 'nope-nope' });
  assert.equal(wrong.status, 401);
});

test('protected routes reject missing, malformed and forged tokens', async () => {
  assert.equal((await request(app).get('/api/data')).status, 401);
  assert.equal((await request(app).get('/api/data').set(auth('not-a-jwt'))).status, 401);
  const jwt = require('jsonwebtoken');
  const forged = jwt.sign({ type: 'session', sub: 1, ep: 0 }, 'some-other-secret');
  assert.equal((await request(app).get('/api/data').set(auth(forged))).status, 401);
  // A v1-era token (same secret, no issuer) must not resolve to a v2 user.
  const v1 = jwt.sign({ type: 'session', sub: 1 }, process.env.JWT_SECRET, { expiresIn: '30d' });
  assert.equal((await request(app).get('/api/data').set(auth(v1))).status, 401);
  // A signup-verification token is not a session token.
  const { signToken } = require('../src/middleware');
  const wrongType = signToken({ type: 'signup_verified', email: 'a@b.co' }, '5m');
  assert.equal((await request(app).get('/api/data').set(auth(wrongType))).status, 401);
});

test('change-password requires the current password and signs out other sessions', async () => {
  const u = await createUser('chpw');
  const bad = await request(app).post('/api/auth/change-password').set(auth(u.token))
    .send({ currentPassword: 'wrong', newPassword: 'brand-new-pass' });
  assert.equal(bad.status, 400);

  const ok = await request(app).post('/api/auth/change-password').set(auth(u.token))
    .send({ currentPassword: u.password, newPassword: 'brand-new-pass' });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);

  assert.equal((await request(app).get('/api/auth/me').set(auth(u.token))).status, 401, 'old session revoked');
  assert.equal((await request(app).get('/api/auth/me').set(auth(ok.body.token))).status, 200, 'new session works');
  const login = await request(app).post('/api/auth/login').send({ username: u.username, password: 'brand-new-pass' });
  assert.equal(login.status, 200);
});

test('forgot-password flow resets the password and the reset token is single-use', async () => {
  const u = await createUser('forgot');
  const start = await request(app).post('/api/auth/forgot/start').send({ email: u.email });
  assert.ok(start.body.devCode);
  const verify = await request(app).post('/api/auth/forgot/verify').send({ email: u.email, code: start.body.devCode });
  assert.equal(verify.status, 200);
  const done = await request(app).post('/api/auth/forgot/complete').send({ resetToken: verify.body.resetToken, newPassword: 'reset-pass-1' });
  assert.equal(done.status, 200);
  const replay = await request(app).post('/api/auth/forgot/complete').send({ resetToken: verify.body.resetToken, newPassword: 'hijack-pass' });
  assert.equal(replay.status, 401);
  assert.equal((await request(app).post('/api/auth/login').send({ username: u.username, password: 'reset-pass-1' })).status, 200);
});

test('forgot/start does not reveal whether an email is registered', async () => {
  const res = await request(app).post('/api/auth/forgot/start').send({ email: 'nobody-here@example.com' });
  assert.equal(res.status, 200);
  assert.equal(res.body.devCode, undefined);
});

test('reset codes are never returned to the caller in production', async () => {
  const path = require.resolve('../src/email');
  const saved = process.env.NODE_ENV;
  delete require.cache[path];
  process.env.NODE_ENV = 'production';
  try {
    const { sendOtpEmail } = require('../src/email');
    assert.equal((await sendOtpEmail('a@b.co', '123456', 'reset')).exposeCode, false);
  } finally {
    process.env.NODE_ENV = saved;
    delete require.cache[path];
  }
});

test('account rename and username change enforce uniqueness', async () => {
  const a = await createUser('acctA');
  const b = await createUser('acctB');
  const taken = await request(app).patch('/api/auth/account').set(auth(a.token)).send({ username: b.username });
  assert.equal(taken.status, 400);
  const ok = await request(app).patch('/api/auth/account').set(auth(a.token)).send({ username: 'renamed_' + a.user.id, name: 'New Name' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.name, 'New Name');
  // Session survives a username change (tokens are keyed by user id).
  assert.equal((await request(app).get('/api/auth/me').set(auth(a.token))).body.username, 'renamed_' + a.user.id);
});

test('email change is verified by a code sent to the new address', async () => {
  const u = await createUser('email');
  const start = await request(app).post('/api/auth/email/start').set(auth(u.token)).send({ email: 'fresh-address@example.com' });
  assert.equal(start.status, 200);
  const bad = await request(app).post('/api/auth/email/verify').set(auth(u.token)).send({ email: 'fresh-address@example.com', code: '111111' });
  assert.equal(bad.status, 400);
  const ok = await request(app).post('/api/auth/email/verify').set(auth(u.token)).send({ email: 'fresh-address@example.com', code: start.body.devCode });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.email, 'fresh-address@example.com');
});

test('deleting the account removes all of its data', async () => {
  const u = await createUser('delete');
  await request(app).post('/api/data/sync').set(auth(u.token)).send({ ops: [
    { type: 'meal.upsert', data: { uid: 'm1', date: '2026-10-01', meal: 'Lunch', name: 'Rice', cal: 200, p: 4, c: 44, f: 1 } },
    { type: 'workout.upsert', data: { id: 'w1', date: '2026-10-01', day: 'Push', exercises: [{ exId: 'ex0', sets: [{ reps: 5, weight: 60 }] }] } },
  ] });
  const del = await request(app).delete('/api/auth/me').set(auth(u.token));
  assert.equal(del.status, 200);
  const left = await db.query(
    `SELECT (SELECT count(*) FROM meal_logs WHERE user_id = $1) + (SELECT count(*) FROM workout_logs WHERE user_id = $1) AS n`,
    [u.user.id]
  );
  assert.equal(left.rows[0].n, 0);
  assert.equal((await request(app).get('/api/auth/me').set(auth(u.token))).status, 401);
});

test('EMAIL_MODE=brevo sends through the Brevo API and never exposes the code', async () => {
  const path = require.resolve('../src/email');
  const saved = { mode: process.env.EMAIL_MODE, key: process.env.BREVO_API_KEY, from: process.env.EMAIL_FROM, fetch: globalThis.fetch };
  const calls = [];
  delete require.cache[path];
  process.env.EMAIL_MODE = 'brevo';
  process.env.BREVO_API_KEY = 'test-brevo-key';
  process.env.EMAIL_FROM = 'ForgeFit <no-reply@forgefit.test>';
  try {
    globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 201 }; };
    const { sendOtpEmail } = require('../src/email');
    const r = await sendOtpEmail('lifter@example.com', '482913', 'signup');
    assert.deepEqual(r, { delivered: true, exposeCode: false });
    assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email');
    assert.equal(calls[0].opts.headers['api-key'], 'test-brevo-key');
    const body = JSON.parse(calls[0].opts.body);
    assert.deepEqual(body.sender, { name: 'ForgeFit', email: 'no-reply@forgefit.test' });
    assert.deepEqual(body.to, [{ email: 'lifter@example.com' }]);
    assert.match(body.textContent, /482913/);

    globalThis.fetch = async () => ({ ok: false, status: 401 });
    await assert.rejects(sendOtpEmail('lifter@example.com', '111111', 'reset'), (e) => e.status === 502);
  } finally {
    Object.assign(process.env, { EMAIL_MODE: saved.mode, EMAIL_FROM: saved.from || '' });
    if (saved.key === undefined) delete process.env.BREVO_API_KEY; else process.env.BREVO_API_KEY = saved.key;
    globalThis.fetch = saved.fetch;
    delete require.cache[path];
  }
});

test('admin signup list requires ADMIN_SECRET', async () => {
  const saved = process.env.ADMIN_SECRET;
  try {
    delete process.env.ADMIN_SECRET;
    assert.equal((await request(app).get('/api/auth/admin/users')).status, 401, 'disabled when unset');
    process.env.ADMIN_SECRET = 'admin-test-secret-123';
    assert.equal((await request(app).get('/api/auth/admin/users').set('x-admin-secret', 'wrong')).status, 401);
    const ok = await request(app).get('/api/auth/admin/users').set('x-admin-secret', 'admin-test-secret-123');
    assert.equal(ok.status, 200);
    assert.ok(ok.body.count >= 1);
    assert.equal(ok.body.users[0].password_hash, undefined);
    assert.equal((await request(app).get('/api/auth/admin/users?secret=admin-test-secret-123')).status, 200);
  } finally {
    if (saved === undefined) delete process.env.ADMIN_SECRET; else process.env.ADMIN_SECRET = saved;
  }
});
