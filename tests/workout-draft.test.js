// End-to-end tests for the in-progress workout draft. They load the real
// index.html in jsdom with a mocked API, and simulate an app restart by
// starting a fresh window from the previous window's device storage.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const DRAFT_KEY = 'forgefit_workout_draft_v1';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function userState(username, extra) {
  return Object.assign({
    username, email: username + '@example.com', name: 'Test Lifter', backendAuth: true, onboarded: true,
    profile: { sex: 'male', age: 19, heightCm: 175, weightKg: 57, activity: '1.55', goal: 'bulk', diet: 'veg' },
    targets: { calories: 2739, protein: 108, carbs: 406, fat: 76, bmr: 1574, tdee: 2439 },
    splitType: 'Custom', routine: { Push: ['ex0', 'ex1', 'ex2'], Pull: ['ex15'] }, customExercises: [],
    workoutLogs: [], mealLogs: [], stepLogs: [], dietPlan: null, dietPlanChecks: {}, coachChat: [],
  }, extra || {});
}

/** A mock ForgeFit API: serves account state and records every sync op. */
function mockServer(states) {
  const server = { ops: [], offline: false };
  server.fetch = async (url, opts = {}) => {
    if (server.offline) throw new TypeError('Failed to fetch');
    const p = new URL(url).pathname;
    const auth = (opts.headers || {}).Authorization || '';
    const who = auth.replace('Bearer token-', '');
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (p === '/api/data' && (opts.method || 'GET') === 'GET') return json(200, { ok: true, state: states[who] });
    if (p === '/api/data/sync') { server.ops.push(...JSON.parse(opts.body).ops); return json(200, { ok: true }); }
    return json(404, { error: 'Not found.' });
  };
  return server;
}

function session(username) {
  return JSON.stringify({ username, mode: 'backend', token: 'token-' + username, email: username + '@example.com', name: 'Test Lifter' });
}

/** Starts the app in a fresh window with the given device storage (a "process start"). */
async function launch(server, storage) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented|Could not load/.test(e.message)) errors.push(e); });
  const dom = new JSDOM(HTML, {
    url: 'https://localhost/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      Object.entries(storage).forEach(([k, v]) => w.localStorage.setItem(k, v));
      w.fetch = server.fetch;
      w.scrollTo = () => {};
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      w.HTMLCanvasElement.prototype.getContext = () => null;
    },
  });
  const w = dom.window;
  for (let i = 0; i < 100 && !(w.document.getElementById('app').classList.contains('active') || !w.document.getElementById('authView').classList.contains('hidden')); i++) await tick(20);
  w.__errors = errors;
  return w;
}

/** The device's storage, as it would survive the process being killed. */
const deviceStorage = (w) => Object.fromEntries(Object.keys(w.localStorage).map((k) => [k, w.localStorage.getItem(k)]));
const storedDraft = (w, user = 'lifter') => (JSON.parse(w.localStorage.getItem(DRAFT_KEY) || '{}'))[user];
const trainState = (w) => w.eval('trainState');

function type(w, id, value) {
  const el = w.document.getElementById(id);
  assert.ok(el, 'input #' + id + ' should exist');
  el.value = value;
  el.dispatchEvent(new w.Event('input', { bubbles: true }));
}

async function choose(w, label, action) {
  const pending = action();
  await tick(5);
  const btn = [...w.document.querySelectorAll('#choiceModal [data-choice]')].find((b) => b.textContent.includes(label));
  assert.ok(btn, 'dialog option "' + label + '" should be shown');
  btn.click();
  await pending;
  await tick(5);
}

function background(w) {
  Object.defineProperty(w.document, 'visibilityState', { value: 'hidden', configurable: true });
  w.document.dispatchEvent(new w.Event('visibilitychange'));
}

/** Opens Train on Push and logs a regular set, a typed (not yet added) drop set and unilateral values. */
async function logPartialWorkout(w) {
  w.goToView('train');
  if (trainState(w).activeDay !== 'Push') await w.selectTrainDay('Push');
  type(w, 'reps_ex0', '8');
  type(w, 'weight_ex0', '60');
  w.addPendingSet('ex0');
  w.toggleExMode('ex1', 'dropset');
  type(w, 'drep_ex1_0', '10');
  type(w, 'dwt_ex1_0', '40');
  type(w, 'drep_ex1_1', '8');
  type(w, 'dwt_ex1_1', '30');
  w.toggleExMode('ex2', 'unilateral');
  type(w, 'lreps_ex2', '12');
  type(w, 'lwt_ex2', '14');
}

function setup() {
  const server = mockServer({ lifter: userState('lifter'), other: userState('other') });
  return { server, storage: { forgefit_session_v1: session('lifter') } };
}

test('draft survives backgrounding and leaving the Train screen, and is never synced', async () => {
  const { server, storage } = setup();
  const w = await launch(server, storage);
  await logPartialWorkout(w);
  background(w);

  w.goToView('dashboard');
  assert.match(w.document.getElementById('view-dashboard').textContent, /Unfinished workout/);
  w.goToView('train');

  const st = trainState(w);
  assert.deepEqual(JSON.parse(JSON.stringify(st.pendingSets)), { ex0: [{ reps: 8, weight: 60 }] });
  assert.equal(w.document.getElementById('dwt_ex1_1').value, '30', 'typed drop-set values kept');
  assert.equal(w.document.getElementById('lreps_ex2').value, '12', 'typed unilateral values kept');
  assert.match(w.document.getElementById('draftStatus').textContent, /Workout in progress/);

  const d = storedDraft(w);
  assert.equal(d.day, 'Push');
  assert.equal(d.exModes.ex1, 'dropset');
  assert.equal(d.inputs.lwt_ex2, '14');

  await tick(400);
  assert.ok(!server.ops.some((o) => o.type === 'workout.upsert'), 'the draft is not uploaded');
  assert.equal(w.currentUser().workoutLogs.length, 0, 'the draft is not a completed workout');
  assert.deepEqual(w.__errors, []);
});

test('draft is restored after the app process is killed and reopened', async () => {
  const { server, storage } = setup();
  const w1 = await launch(server, storage);
  await logPartialWorkout(w1);
  const killedAt = deviceStorage(w1);
  w1.close();

  const w2 = await launch(server, killedAt);
  w2.goToView('train');
  const st = trainState(w2);
  assert.equal(st.activeDay, 'Push');
  assert.deepEqual(JSON.parse(JSON.stringify(st.pendingSets)), { ex0: [{ reps: 8, weight: 60 }] });
  assert.equal(st.exModes.ex1, 'dropset');
  assert.equal(st.exModes.ex2, 'unilateral');
  assert.equal(w2.document.getElementById('drep_ex1_0').value, '10');
  assert.equal(w2.document.getElementById('dwt_ex1_0').value, '40');
  assert.equal(w2.document.getElementById('lwt_ex2').value, '14');
  assert.match(w2.document.getElementById('draftStatus').textContent, /Continuing your unfinished workout/);
  assert.match(w2.document.querySelector('#view-train .set-chip').textContent, /60kg × 8/);
});

test('draft is kept while offline and across an offline restart', async () => {
  const { server, storage } = setup();
  const w1 = await launch(server, storage);
  server.offline = true;
  await logPartialWorkout(w1);
  const s = deviceStorage(w1);
  w1.close();

  const w2 = await launch(server, s); // still offline: renders from the device cache
  w2.goToView('train');
  assert.deepEqual(JSON.parse(JSON.stringify(trainState(w2).pendingSets)), { ex0: [{ reps: 8, weight: 60 }] });
  assert.equal(w2.document.getElementById('lreps_ex2').value, '12');
});

test('Finish turns the draft into one completed workout and clears it', async () => {
  const { server, storage } = setup();
  const w = await launch(server, storage);
  await logPartialWorkout(w);
  w.addPendingSet('ex1'); // the typed drop set becomes a logged set
  w.finishWorkout();
  await tick(400);

  assert.equal(storedDraft(w), undefined, 'draft removed from the device');
  assert.deepEqual(JSON.parse(JSON.stringify(trainState(w).pendingSets)), {});
  const uploads = server.ops.filter((o) => o.type === 'workout.upsert');
  assert.equal(uploads.length, 1);
  assert.deepEqual(uploads[0].data.exercises, [
    { exId: 'ex0', sets: [{ reps: 8, weight: 60 }] },
    { exId: 'ex1', sets: [{ type: 'dropset', drops: [{ reps: 10, weight: 40 }, { reps: 8, weight: 30 }] }] },
  ]);
  assert.equal(w.document.getElementById('draftStatus').style.display, 'none');

  // A restart after finishing shows no unfinished workout.
  const w2 = await launch(server, deviceStorage(w));
  w2.goToView('dashboard');
  assert.doesNotMatch(w2.document.getElementById('view-dashboard').textContent, /Unfinished workout/);
});

test('Discard asks first, and only clears the draft when confirmed', async () => {
  const { server, storage } = setup();
  const w = await launch(server, storage);
  await logPartialWorkout(w);

  await choose(w, 'Keep logging', () => w.discardWorkout());
  assert.ok(storedDraft(w), 'kept when the user backs out');

  await choose(w, 'Discard workout', () => w.discardWorkout());
  assert.equal(storedDraft(w), undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(trainState(w).pendingSets)), {});
  await tick(400);
  assert.ok(!server.ops.some((o) => o.type === 'workout.upsert'), 'a discarded draft is never uploaded');
});

test('logout warns about an unfinished workout: stay, keep, or discard', async () => {
  const { server, storage } = setup();
  const w = await launch(server, storage);
  await logPartialWorkout(w);

  await choose(w, 'Stay logged in', () => w.logout());
  assert.ok(w.document.getElementById('app').classList.contains('active'), 'still signed in');

  await choose(w, 'Keep it and log out', () => w.logout());
  assert.ok(!w.document.getElementById('authView').classList.contains('hidden'), 'signed out');
  assert.ok(storedDraft(w), 'draft kept on the device');
  assert.deepEqual(JSON.parse(JSON.stringify(trainState(w).pendingSets)), {}, 'nothing left in memory');

  // Another account on the same phone never sees it.
  w.localStorage.setItem('forgefit_session_v1', session('other'));
  await w.boot(); await tick(50);
  w.goToView('train');
  assert.deepEqual(JSON.parse(JSON.stringify(trainState(w).pendingSets)), {});
  assert.equal(w.document.getElementById('draftStatus').style.display, 'none');
  await w.logout(); await tick(20);

  // Logging back in restores it.
  w.localStorage.setItem('forgefit_session_v1', session('lifter'));
  await w.boot(); await tick(50);
  w.goToView('train');
  assert.deepEqual(JSON.parse(JSON.stringify(trainState(w).pendingSets)), { ex0: [{ reps: 8, weight: 60 }] });
  assert.equal(w.document.getElementById('lwt_ex2').value, '14');

  await choose(w, 'Discard it and log out', () => w.logout());
  assert.equal(storedDraft(w), undefined);
});

test('starting a different day asks before replacing the draft', async () => {
  const { server, storage } = setup();
  const w = await launch(server, storage);
  await logPartialWorkout(w);

  await choose(w, 'Keep logging Push', () => w.selectTrainDay('Pull'));
  assert.equal(trainState(w).activeDay, 'Push');
  assert.equal(storedDraft(w).day, 'Push');

  await choose(w, 'Discard it and switch to Pull', () => w.selectTrainDay('Pull'));
  assert.equal(trainState(w).activeDay, 'Pull');
  assert.equal(storedDraft(w), undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(trainState(w).pendingSets)), {});

  // With nothing logged, switching days needs no confirmation.
  await w.selectTrainDay('Push');
  assert.equal(trainState(w).activeDay, 'Push');
  assert.equal(w.document.getElementById('choiceModal'), null);
});

test('"Repeat last" asks before replacing logged sets', async () => {
  const server = mockServer({ lifter: userState('lifter', { workoutLogs: [
    { id: 'w_prev', date: '2026-10-01', day: 'Push', exercises: [{ exId: 'ex0', sets: [{ reps: 5, weight: 70 }, { reps: 5, weight: 70 }] }] },
  ] }) });
  const w = await launch(server, { forgefit_session_v1: session('lifter') });
  await logPartialWorkout(w);

  await choose(w, 'Keep my sets', () => w.repeatLastWorkout());
  assert.deepEqual(JSON.parse(JSON.stringify(trainState(w).pendingSets)), { ex0: [{ reps: 8, weight: 60 }] });

  await choose(w, 'Replace with last session', () => w.repeatLastWorkout());
  assert.deepEqual(JSON.parse(JSON.stringify(trainState(w).pendingSets)), { ex0: [{ reps: 5, weight: 70 }, { reps: 5, weight: 70 }] });
  assert.deepEqual(storedDraft(w).pendingSets, { ex0: [{ reps: 5, weight: 70 }, { reps: 5, weight: 70 }] });
});
