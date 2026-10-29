// Sign-up, sign-in, password reset/change and token refresh against a fake
// Supabase (Auth REST + the ForgeFit `api` function), driving the real UI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function emptyState(username, email) {
  return { username, email, name: 'New Person', backendAuth: true, onboarded: false, profile: null, targets: null, splitType: null, routine: {}, customExercises: [], workoutLogs: [], mealLogs: [], stepLogs: [], savedFoods: [], dietPlan: null, dietPlanChecks: {}, coachChat: [] };
}

/** Fake Supabase. `accounts` maps email -> account ({username,email,name}) or null. */
function fakeSupabase({ accounts = {}, passwords = {}, tokens = {} } = {}) {
  const calls = [];
  const sessions = new Map(Object.entries(tokens)); // access token -> email
  let n = 0;
  const session = (email) => {
    n += 1;
    const t = 'at' + n;
    sessions.set(t, email);
    return { access_token: t, refresh_token: 'rt' + n, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'uid-' + email, email, user_metadata: {} } };
  };
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    const headers = opts.headers || {};
    const token = (headers.Authorization || '').replace('Bearer ', '');
    calls.push({ path: u.pathname + u.search, method: opts.method || 'GET', body, token, apikey: headers.apikey });
    const json = (status, b) => ({ ok: status < 300, status, json: async () => b });
    const p = u.pathname;
    if (p.endsWith('/auth/v1/otp')) return json(200, {});
    if (p.endsWith('/auth/v1/recover')) return json(200, {});
    if (p.endsWith('/auth/v1/verify')) return body.token === '123456' ? json(200, session(body.email)) : json(403, { error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
    if (p.endsWith('/auth/v1/user') && opts.method === 'PUT') {
      if (body.password) passwords[sessions.get(token)] = body.password;
      return json(200, { id: 'x' });
    }
    if (p.endsWith('/auth/v1/token')) {
      if (u.search.includes('refresh_token')) return body.refresh_token === 'revoked' ? json(400, { error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' }) : json(200, session('lifter@example.com'));
      return passwords[body.email] === body.password ? json(200, session(body.email)) : json(400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
    }
    if (p.endsWith('/auth/v1/logout')) return json(204, {});
    // ---- ForgeFit api function ----
    const email = sessions.get(token);
    if (p.endsWith('/api/auth/login')) {
      const login = body.username;
      const em = login.includes('@') ? login : Object.keys(accounts).find((e) => accounts[e] && accounts[e].username === login);
      if (!em || passwords[em] !== body.password) return json(401, { error: 'Incorrect username or password.' });
      return json(200, { ok: true, session: session(em), account: accounts[em] || null });
    }
    if (p.endsWith('/api/account') && (opts.method || 'GET') === 'GET') return email ? json(200, { ok: true, account: accounts[email] || null }) : json(401, { error: 'Your session has ended. Please log in again.' });
    if (p.endsWith('/api/account/setup')) {
      if (Object.values(accounts).some((a) => a && a.username === body.username)) return json(400, { error: 'That username is already taken.' });
      accounts[email] = { username: body.username, email, name: body.name };
      return json(201, { ok: true, account: accounts[email] });
    }
    if (p.endsWith('/api/data')) {
      if (!email || !accounts[email]) return json(401, { error: 'Your session has ended. Please log in again.' });
      return json(200, { ok: true, state: emptyState(accounts[email].username, email) });
    }
    if (p.endsWith('/api/data/sync')) return email ? json(200, { ok: true }) : json(401, { error: 'Your session has ended.' });
    return json(404, { error: 'Not found.' });
  };
  return { fetch, calls, accounts, passwords };
}

async function launch(sb, storage = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented|Could not load/.test(e.message)) errors.push(e); });
  const dom = new JSDOM(HTML, {
    url: 'https://localhost/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      Object.entries(storage).forEach(([k, v]) => w.localStorage.setItem(k, v));
      w.fetch = sb.fetch;
      w.scrollTo = () => {};
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      w.HTMLCanvasElement.prototype.getContext = () => null;
    },
  });
  await tick(50);
  dom.window.__errors = errors;
  return dom.window;
}
const $ = (w, id) => w.document.getElementById(id);
const val = (w, id, v) => { $(w, id).value = v; };
const click = async (w, id) => { $(w, id).click(); await tick(60); };
const visible = (w, id) => !$(w, id).classList.contains('hidden');
const session = (w) => JSON.parse(w.localStorage.getItem('forgefit_session_v1') || 'null');

test('sign-up: email code, then username + password, then into the app', async () => {
  const sb = fakeSupabase();
  const w = await launch(sb);
  $(w, 'tabSignup').click();
  val(w, 'suName', 'New Person');
  val(w, 'suEmail', 'New@Example.com');
  await click(w, 'suSendCodeBtn');
  const otp = sb.calls.find((c) => c.path.endsWith('/auth/v1/otp'));
  assert.deepEqual([otp.body.email, otp.body.create_user, otp.body.data.name], ['new@example.com', true, 'New Person']);
  assert.ok(otp.apikey.startsWith('sb_publishable_'), 'Auth calls carry the publishable key');
  assert.ok(visible(w, 'signupStep2'));

  val(w, 'suOtp', '000000');
  await click(w, 'suVerifyOtpBtn');
  assert.match($(w, 'suOtpError').textContent, /expired or is incorrect/);

  val(w, 'suOtp', '123456');
  await click(w, 'suVerifyOtpBtn');
  assert.ok(visible(w, 'signupStep3'), 'new email → choose username + password');

  val(w, 'suUsername', 'new_person');
  val(w, 'suPass', 'secret-123');
  val(w, 'suPassConfirm', 'secret-123');
  await click(w, 'suCreateBtn');
  await tick(100);
  assert.equal(sb.passwords['new@example.com'], 'secret-123', 'password set in Supabase Auth');
  assert.deepEqual(sb.accounts['new@example.com'], { username: 'new_person', email: 'new@example.com', name: 'New Person' });
  const s = session(w);
  assert.deepEqual([s.mode, s.username, !!s.access_token, !!s.refresh_token], ['supabase', 'new_person', true, true]);
  assert.ok(visible(w, 'onboardView'), 'new accounts go to onboarding');
  assert.deepEqual(w.__errors, []);
});

test('sign-up with an email that already has an account just signs in', async () => {
  const sb = fakeSupabase({ accounts: { 'lifter@example.com': { username: 'lifter', email: 'lifter@example.com', name: 'L' } } });
  const w = await launch(sb);
  $(w, 'tabSignup').click();
  val(w, 'suName', 'L');
  val(w, 'suEmail', 'lifter@example.com');
  await click(w, 'suSendCodeBtn');
  val(w, 'suOtp', '123456');
  await click(w, 'suVerifyOtpBtn');
  await tick(100);
  assert.equal(session(w).username, 'lifter');
  assert.ok(!visible(w, 'signupStep3'));
});

test('a taken username is reported and can be changed', async () => {
  const sb = fakeSupabase({ accounts: { 'other@example.com': { username: 'taken_name', email: 'other@example.com', name: 'O' } } });
  const w = await launch(sb);
  $(w, 'tabSignup').click();
  val(w, 'suName', 'N'); val(w, 'suEmail', 'n@example.com');
  await click(w, 'suSendCodeBtn');
  val(w, 'suOtp', '123456');
  await click(w, 'suVerifyOtpBtn');
  val(w, 'suUsername', 'taken_name'); val(w, 'suPass', 'secret-1'); val(w, 'suPassConfirm', 'secret-1');
  await click(w, 'suCreateBtn');
  assert.match($(w, 'signupPassError').textContent, /already taken/);
  val(w, 'suUsername', 'free_name');
  await click(w, 'suCreateBtn');
  await tick(100);
  assert.equal(session(w).username, 'free_name');
});

test('log in by username or email; wrong password is reported', async () => {
  const sb = fakeSupabase({ accounts: { 'lifter@example.com': { username: 'lifter', email: 'lifter@example.com', name: 'L' } }, passwords: { 'lifter@example.com': 'pw-123456' } });
  const w = await launch(sb);
  val(w, 'loginUsername', 'lifter'); val(w, 'loginPass', 'nope');
  $(w, 'loginForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
  await tick(80);
  assert.match($(w, 'loginError').textContent, /Incorrect username or password/);

  val(w, 'loginUsername', 'LIFTER'); val(w, 'loginPass', 'pw-123456');
  $(w, 'loginForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
  await tick(150);
  assert.equal(session(w).username, 'lifter');
  assert.ok(w.document.getElementById('onboardView') && !w.document.getElementById('authView').classList.contains('hidden') === false);
});

test('an expiring access token is refreshed before calling the API', async () => {
  const sb = fakeSupabase({ accounts: { 'lifter@example.com': { username: 'lifter', email: 'lifter@example.com', name: 'L' } } });
  const old = { mode: 'supabase', username: 'lifter', email: 'lifter@example.com', name: 'L', access_token: 'stale', refresh_token: 'good', expires_at: Date.now() + 5000 };
  const w = await launch(sb, { forgefit_session_v1: JSON.stringify(old) });
  await tick(150);
  assert.ok(sb.calls.some((c) => c.path.includes('grant_type=refresh_token')));
  const dataCall = sb.calls.find((c) => c.path.endsWith('/api/data'));
  assert.notEqual(dataCall.token, 'stale', 'the API was called with the refreshed token');
  assert.notEqual(session(w).access_token, 'stale');
  assert.equal(session(w).username, 'lifter', 'account details kept across refresh');
});

test('a revoked session sends you back to log in', async () => {
  const sb = fakeSupabase();
  const old = { mode: 'supabase', username: 'lifter', email: 'lifter@example.com', name: 'L', access_token: 'stale', refresh_token: 'revoked', expires_at: Date.now() - 1000 };
  const w = await launch(sb, { forgefit_session_v1: JSON.stringify(old) });
  await tick(150);
  assert.equal(session(w), null);
  assert.ok(visible(w, 'authView'));
  assert.equal($(w, 'loginUsername').value, 'lifter');
});

test('forgot password: email code, new password, other devices signed out', async () => {
  const sb = fakeSupabase({ accounts: { 'lifter@example.com': { username: 'lifter', email: 'lifter@example.com', name: 'L' } }, passwords: { 'lifter@example.com': 'old-pass' } });
  const w = await launch(sb);
  await click(w, 'forgotPassToggle');
  val(w, 'fpEmail', 'lifter@example.com');
  await click(w, 'fpSendCodeBtn');
  assert.ok(sb.calls.some((c) => c.path.endsWith('/auth/v1/recover')));
  val(w, 'fpOtp', '123456');
  await click(w, 'fpVerifyBtn');
  assert.equal(sb.calls.filter((c) => c.path.endsWith('/auth/v1/verify')).pop().body.type, 'recovery');
  val(w, 'fpNewPass', 'new-pass-1'); val(w, 'fpConfirmPass', 'new-pass-1');
  await click(w, 'fpResetBtn');
  await tick(100);
  assert.equal(sb.passwords['lifter@example.com'], 'new-pass-1');
  assert.ok(sb.calls.some((c) => c.path.includes('/logout?scope=others')));
  assert.equal($(w, 'loginUsername').value, 'lifter');
  assert.match($(w, 'authNotice').textContent, /Password reset for “lifter”/);
});

test('change password checks the current one first', async () => {
  const sb = fakeSupabase({ accounts: { 'lifter@example.com': { username: 'lifter', email: 'lifter@example.com', name: 'L' } }, passwords: { 'lifter@example.com': 'old-pass' }, tokens: { 'at-start': 'lifter@example.com' } });
  const s = { mode: 'supabase', username: 'lifter', email: 'lifter@example.com', name: 'L', access_token: 'at-start', refresh_token: 'good', expires_at: Date.now() + 3600e3 };
  const w = await launch(sb, { forgefit_session_v1: JSON.stringify(s) });
  await tick(120);
  w.renderProfile();
  val(w, 'cpCurrent', 'wrong'); val(w, 'cpNew', 'brand-new-1'); val(w, 'cpConfirm', 'brand-new-1');
  await w.submitChangePassword();
  assert.match($(w, 'cpError').textContent, /Current password is incorrect/);
  assert.equal(sb.passwords['lifter@example.com'], 'old-pass');

  val(w, 'cpCurrent', 'old-pass');
  await w.submitChangePassword();
  assert.equal(sb.passwords['lifter@example.com'], 'brand-new-1');
  assert.ok(sb.calls.some((c) => c.path.includes('/logout?scope=others')));
});

test('a session from the old Render server asks you to log in again', async () => {
  const sb = fakeSupabase();
  const w = await launch(sb, { forgefit_session_v1: JSON.stringify({ username: 'lifter', mode: 'backend', token: 'old-render-jwt' }) });
  assert.ok(visible(w, 'authView'));
  assert.match($(w, 'authNotice').textContent, /moved to a new, faster server/);
  assert.equal($(w, 'loginUsername').value, 'lifter');
  assert.equal(w.localStorage.getItem('forgefit_session_v1'), null);
});
