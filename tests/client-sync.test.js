// Unit tests for the app's sync/import helpers. The functions are taken
// verbatim from index.html (the app has no build step) and run in a sandbox.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extract(name) {
  const fn = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(html);
  if (fn) return html.slice(fn.index, html.indexOf('\n}\n', fn.index) + 3);
  const decl = new RegExp(`^const ${name} = .*;$`, 'm').exec(html);
  if (decl) return decl[0];
  throw new Error('not found in index.html: ' + name);
}

const names = ['j', 'clone', 'newId', 'normalizeUser', 'diffUser', 'hashString', 'datasetFingerprint',
  'datasetCounts', 'datasetHasData', 'describeCounts', 'saveMessage'];
const ctx = vm.createContext({ crypto: globalThis.crypto, window: { crypto: globalThis.crypto }, Math, Date, JSON, Map, Set, Object, Array, String });
vm.runInContext(names.map(extract).join('\n') + `\n;globalThis.api = {${names.join(',')}};`, ctx);
// Values created inside the sandbox have that realm's prototypes; round-trip
// them through JSON so deepStrictEqual compares plain data.
const plain = (fn) => (...args) => JSON.parse(JSON.stringify(fn(...args)));
const diffUser = plain(ctx.api.diffUser);
const normalizeUser = plain(ctx.api.normalizeUser);
const clone = plain(ctx.api.clone);
const { datasetFingerprint, datasetHasData, describeCounts, datasetCounts, saveMessage } = ctx.api;

const legacy = require('../backend/test/fixtures/legacy-backup.json');
const base = () => normalizeUser(clone({
  username: 'k', name: 'K', onboarded: true, splitType: 'PPL', profile: { age: 20 }, targets: { calories: 2000 },
  routine: { Push: ['ex1'], Pull: [] }, customExercises: [],
  workoutLogs: [{ id: 'w1', date: '2026-10-01', day: 'Push', exercises: [{ exId: 'ex1', sets: [{ reps: 5, weight: 60 }] }] }],
  mealLogs: [{ uid: 'm1', date: '2026-10-01', meal: 'Lunch', name: 'Rice', cal: 200, p: 4, c: 44, f: 1 }],
  stepLogs: [{ date: '2026-10-01', steps: 1000 }],
  dietPlan: null, dietPlanChecks: {}, coachChat: [{ id: 'c1', who: 'coach', text: 'Hi' }],
}));
const types = (ops) => ops.map((o) => o.type);

test('no changes produce no operations', () => {
  const b = base();
  assert.deepEqual(diffUser(b, clone(b)), []);
});

test('each kind of edit maps to the matching operation', () => {
  const b = base();
  const c = clone(b);
  c.name = 'Krishna';
  c.profile.age = 21;
  c.routine.Push.push('ex2');
  c.workoutLogs[0].exercises[0].sets.push({ reps: 5, weight: 62.5 });
  c.workoutLogs.push({ id: 'w2', date: '2026-10-02', day: 'Pull', exercises: [] });
  c.mealLogs = [];
  c.stepLogs[0].steps = 1500;
  c.coachChat.push({ id: 'c2', who: 'user', text: 'Hey' });
  c.dietPlan = { items: [{ id: 'dp0', text: 'Oats' }], updatedAt: 1 };
  c.dietPlanChecks = { '2026-10-02': { dp0: true } };
  const ops = diffUser(b, c);
  assert.deepEqual(types(ops), [
    'account.set', 'profile.set', 'routine.set', 'workout.upsert', 'workout.upsert', 'meal.delete',
    'steps.set', 'dietPlan.set', 'dietPlanCheck.set', 'coach.append',
  ]);
  assert.deepEqual(ops[0].data, { name: 'Krishna' });
  assert.equal(ops.find((o) => o.type === 'meal.delete').id, 'm1');
  assert.deepEqual(ops.find((o) => o.type === 'dietPlan.set').data, { items: [{ id: 'dp0', text: 'Oats' }] });
});

test('a first sync (no confirmed copy yet) sends everything', () => {
  const ops = diffUser(null, base());
  assert.ok(types(ops).includes('workout.upsert'));
  assert.ok(types(ops).includes('meal.upsert'));
  assert.ok(types(ops).includes('coach.append'));
});

test('removing coach messages clears and re-sends the history', () => {
  const b = base();
  const c = clone(b);
  c.coachChat = [{ id: 'c9', who: 'coach', text: 'Fresh start' }];
  assert.deepEqual(types(diffUser(b, c)), ['coach.clear', 'coach.append']);
});

test('normalizeUser gives every record a stable id without touching existing ones', () => {
  const u = normalizeUser({ workoutLogs: [{ date: '2026-01-01' }, { id: 'keep', date: '2026-01-02' }], mealLogs: [{}], coachChat: [{}] });
  assert.match(u.workoutLogs[0].id, /^w_/);
  assert.equal(u.workoutLogs[1].id, 'keep');
  assert.match(u.mealLogs[0].uid, /^m_/);
  assert.match(u.coachChat[0].id, /^c_/);
  assert.deepEqual(u.routine, {});
  assert.deepEqual(u.stepLogs, []);
});

test('dataset fingerprints identify the same device data regardless of account fields', () => {
  const a = clone(legacy);
  const b = clone(legacy);
  b.username = 'someone-else'; b.email = 'x@y.z'; b.onboarded = false;
  assert.equal(datasetFingerprint(a), datasetFingerprint(b));
  b.workoutLogs.push({ date: '2026-09-01', day: 'Legs', exercises: [] });
  assert.notEqual(datasetFingerprint(a), datasetFingerprint(b));
});

test('import candidates describe what they contain', () => {
  assert.ok(datasetHasData(legacy));
  assert.ok(!datasetHasData({ username: 'empty', workoutLogs: [], mealLogs: [] }));
  assert.equal(describeCounts(datasetCounts(legacy)), '5 workouts, 2 meals, 2 days of steps, 5-day routine, profile, diet plan');
});

test('save messages never claim success for a failed save', () => {
  assert.equal(saveMessage({ ok: true }, 'Workout saved.'), 'Workout saved.');
  assert.match(saveMessage({ ok: false, offline: true }, 'Workout saved.'), /on this device/);
  assert.match(saveMessage({ ok: false, error: 'ops[0] date invalid' }, 'Workout saved.'), /^Not saved: ops\[0\] date invalid/);
});
