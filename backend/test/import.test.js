const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const legacy = require('./fixtures/legacy-backup.json');
const { app, db, request, resetDb, createUser, auth } = require('./helpers');

before(resetDb);
after(() => db.close());

const importData = (token, data, source = 'device') =>
  request(app).post('/api/data/import').set(auth(token)).send({ source, data });
const clone = (o) => JSON.parse(JSON.stringify(o));

test('legacy device data imports into an empty account', async () => {
  const u = await createUser('imp');
  const res = await importData(u.token, legacy);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.alreadyImported, false);
  assert.deepEqual(res.body.skipped, []);
  assert.equal(res.body.counts.workouts, 5);
  assert.equal(res.body.counts.meals, 2);
  assert.equal(res.body.counts.steps, 2);
  assert.equal(res.body.counts.coachMessages, 5);
  assert.equal(res.body.counts.customExercises, 1);
  assert.equal(res.body.counts.profile, true);
  assert.equal(res.body.counts.routine, true);
  assert.equal(res.body.counts.dietPlan, true);

  const s = res.body.state;
  assert.equal(s.onboarded, true);
  assert.equal(s.splitType, 'Custom');
  assert.deepEqual(Object.keys(s.routine), Object.keys(legacy.routine));
  assert.equal(s.workoutLogs.length, 5);
  // Sets survive exactly.
  assert.deepEqual(s.workoutLogs[0].exercises, legacy.workoutLogs[0].exercises);
  assert.ok(s.workoutLogs.every((w) => w.id.startsWith('w_')), 'legacy workouts get stable content ids');
  assert.deepEqual(s.mealLogs.map((m) => m.uid), legacy.mealLogs.map((m) => m.uid));
  assert.equal(s.coachChat.length, 5);
  // Account identity is never taken from the backup.
  assert.equal(s.username, u.username);
  assert.equal(s.email, u.email);
});

test('importing the same data twice is detected and changes nothing', async () => {
  const u = await createUser('twice');
  const first = await importData(u.token, legacy);
  const second = await importData(u.token, legacy);
  assert.equal(second.status, 200);
  assert.equal(second.body.alreadyImported, true);
  assert.equal(second.body.importId, first.body.importId);
  assert.equal(second.body.state.workoutLogs.length, 5);
  assert.equal(second.body.state.mealLogs.length, 2);
});

test('concurrent duplicate imports apply only once', async () => {
  const u = await createUser('race');
  const [a, b] = await Promise.all([importData(u.token, legacy), importData(u.token, legacy)]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal([a.body.alreadyImported, b.body.alreadyImported].filter(Boolean).length, 1);
  const s = (await request(app).get('/api/data').set(auth(u.token))).body.state;
  assert.equal(s.workoutLogs.length, 5);
  assert.equal(s.coachChat.length, 5);
});

test('an overlapping import (e.g. a newer backup) only adds what is new', async () => {
  const u = await createUser('overlap');
  await importData(u.token, legacy);
  const newer = clone(legacy);
  newer.workoutLogs.push({ date: '2026-08-29', day: 'Back', exercises: [{ exId: 'ex15', sets: [{ reps: 8, weight: 50 }] }] });
  newer.mealLogs.push({ uid: 'new_meal', date: '2026-08-29', meal: 'Snack', foodId: null, name: 'Banana', servings: 1, qtyUnit: 'serving', qtyAmount: 1, cal: 105, p: 1.3, c: 27, f: 0.4 });
  newer.coachChat.push({ who: 'user', text: 'New question' });
  const res = await importData(u.token, newer, 'backup-file');
  assert.equal(res.body.alreadyImported, false);
  assert.equal(res.body.counts.workouts, 1);
  assert.equal(res.body.counts.meals, 1);
  assert.equal(res.body.counts.coachMessages, 1);
  assert.equal(res.body.state.workoutLogs.length, 6);
});

test('existing server data wins over imported profile/targets/plan', async () => {
  const u = await createUser('wins');
  await request(app).post('/api/data/sync').set(auth(u.token)).send({ ops: [
    { type: 'profile.set', data: { sex: 'female', age: 30, heightCm: 160, weightKg: 55, activity: '1.375', goal: 'cut', diet: 'nonveg' } },
    { type: 'routine.set', data: { 'Upper A': ['ex1'] } },
    { type: 'dietPlan.set', data: { items: [{ id: 'mine', text: 'My plan' }] } },
  ] });
  const res = await importData(u.token, legacy);
  const s = res.body.state;
  assert.equal(s.profile.sex, 'female');
  assert.equal(s.profile.goal, 'cut');
  assert.deepEqual(s.dietPlan.items, [{ id: 'mine', text: 'My plan' }]);
  assert.deepEqual(s.routine['Upper A'], ['ex1'], 'existing day kept');
  assert.ok('Back' in s.routine, 'missing imported days are added');
  assert.equal(res.body.counts.profile, false);
});

test('malformed legacy records are skipped and reported, the rest still import', async () => {
  const u = await createUser('messy');
  const messy = clone(legacy);
  messy.workoutLogs[1].date = 'yesterday';
  messy.mealLogs[0].cal = 'lots';
  const res = await importData(u.token, messy);
  assert.equal(res.status, 200);
  assert.equal(res.body.counts.workouts, 4);
  assert.equal(res.body.counts.meals, 1);
  assert.equal(res.body.skipped.length, 2);
  assert.match(res.body.skipped.join('\n'), /workoutLogs\[1\]/);
});

test('imports are per-user: the same file can be imported by two accounts independently', async () => {
  const a = await createUser('impA');
  const b = await createUser('impB');
  await importData(a.token, legacy);
  const res = await importData(b.token, legacy);
  assert.equal(res.body.alreadyImported, false);
  const history = await request(app).get('/api/data/imports').set(auth(a.token));
  assert.equal(history.body.imports.length, 1);
});

test('import rejects a missing payload', async () => {
  const u = await createUser('empty');
  assert.equal((await request(app).post('/api/data/import').set(auth(u.token)).send({})).status, 400);
  assert.equal((await request(app).post('/api/data/import').send({ data: legacy })).status, 401);
});
