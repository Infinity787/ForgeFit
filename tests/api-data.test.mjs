// Data API tests, against the Supabase Edge Function.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { app, db, request, resetDb, createUser as makeUser, auth } from './helpers/api.mjs';
// Same shape the old suite expected from createUser().
const createUser = async (p) => { const u = await makeUser(p); return { ...u, user: { id: u.id } }; };

before(resetDb);
after(() => db.close());

const sync = (token, ops) => request(app).post('/api/data/sync').set(auth(token)).send({ ops });
const state = async (token) => (await request(app).get('/api/data').set(auth(token))).body.state;

const fullOps = [
  { type: 'account.set', data: { onboarded: true, splitType: 'Custom', name: 'Krishna' } },
  { type: 'profile.set', data: { sex: 'male', age: 19, heightCm: 175, weightKg: 57, activity: '1.55', goal: 'bulk', diet: 'veg', experience: 'gym' } },
  { type: 'targets.set', data: { calories: 2739, protein: 108, carbs: 406, fat: 76, bmr: 1574, tdee: 2439 } },
  { type: 'customExercise.upsert', data: { id: 'custom_1', n: 'Landmine Press', m: 'Shoulders', type: 'Custom' } },
  { type: 'routine.set', data: { 'Chest & Shoulder': ['ex4', 'custom_1'], Back: ['ex15'], Rest: [] } },
  { type: 'workout.upsert', data: { id: 'w_a', date: '2026-10-02', day: 'Back', exercises: [
    { exId: 'ex15', sets: [{ reps: 8, weight: 42.5 }, { type: 'dropset', drops: [{ reps: 8, weight: 40 }, { reps: 6, weight: 30 }] }] },
    { exId: 'ex19', sets: [{ type: 'unilateral', left: { reps: 10, weight: 12.5 }, right: null }] },
  ] } },
  { type: 'workout.upsert', data: { id: 'w_b', date: '2026-10-01', day: 'Chest & Shoulder', exercises: [{ exId: 'ex4', sets: [{ reps: 6, weight: 22.5 }] }] } },
  { type: 'meal.upsert', data: { uid: 'meal1', date: '2026-10-02', meal: 'Lunch', foodId: 'fd3', name: 'Paneer', servings: 1.5, qtyUnit: 'g', qtyAmount: 150, cal: 397.5, p: 27, c: 5.4, f: 30, source: 'library' } },
  { type: 'meal.upsert', data: { uid: 'meal2', date: '2026-10-02', meal: 'Dinner', foodId: null, name: 'Dal rice (photo estimate)', servings: 1, qtyUnit: 'custom', qtyAmount: 1, cal: 520, p: 18, c: 88, f: 9, source: 'photo' } },
  { type: 'steps.set', data: { date: '2026-10-02', steps: 8450 } },
  { type: 'dietPlan.set', data: { items: [{ id: 'dp0', text: 'Oats + whey' }, { id: 'dp1', text: '2 bananas' }] } },
  { type: 'dietPlanCheck.set', data: { date: '2026-10-02', itemId: 'dp0', checked: true } },
  { type: 'coach.append', data: { id: 'c1', who: 'coach', text: 'Hey <b>Krishna</b>' } },
  { type: 'coach.append', data: { id: 'c2', who: 'user', text: 'How am I doing?' } },
];

test('a fresh account starts with an empty state', async () => {
  const u = await createUser('fresh');
  const s = await state(u.token);
  assert.equal(s.username, u.username);
  assert.equal(s.onboarded, false);
  assert.deepEqual(s.workoutLogs, []);
  assert.deepEqual(s.routine, {});
  assert.equal(s.profile, null);
});

test('every kind of record round-trips through SQL in the app’s shape', async () => {
  const u = await createUser('roundtrip');
  const res = await sync(u.token, fullOps);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const s = await state(u.token);

  assert.equal(s.onboarded, true);
  assert.equal(s.splitType, 'Custom');
  assert.equal(s.name, 'Krishna');
  assert.deepEqual(s.profile, { sex: 'male', age: 19, heightCm: 175, weightKg: 57, activity: '1.55', goal: 'bulk', diet: 'veg', experience: 'gym' });
  assert.deepEqual(s.targets, { calories: 2739, protein: 108, carbs: 406, fat: 76, bmr: 1574, tdee: 2439 });
  assert.deepEqual(Object.keys(s.routine), ['Chest & Shoulder', 'Back', 'Rest'], 'day order preserved');
  assert.deepEqual(s.routine['Chest & Shoulder'], ['ex4', 'custom_1']);
  assert.deepEqual(s.customExercises, [{ id: 'custom_1', n: 'Landmine Press', m: 'Shoulders', type: 'Custom' }]);

  assert.deepEqual(s.workoutLogs.map((w) => w.id), ['w_b', 'w_a'], 'sorted by date');
  const back = s.workoutLogs[1];
  assert.deepEqual(back.exercises[0].sets, [
    { reps: 8, weight: 42.5 },
    { type: 'dropset', drops: [{ reps: 8, weight: 40 }, { reps: 6, weight: 30 }] },
  ]);
  assert.deepEqual(back.exercises[1].sets, [{ type: 'unilateral', left: { reps: 10, weight: 12.5 }, right: null }]);

  assert.equal(s.mealLogs.length, 2);
  assert.equal(s.mealLogs[0].cal, 397.5);
  assert.equal(s.mealLogs[1].source, 'photo');
  assert.deepEqual(s.stepLogs, [{ date: '2026-10-02', steps: 8450 }]);
  assert.deepEqual(s.dietPlan.items, [{ id: 'dp0', text: 'Oats + whey' }, { id: 'dp1', text: '2 bananas' }]);
  assert.deepEqual(s.dietPlanChecks, { '2026-10-02': { dp0: true } });
  assert.deepEqual(s.coachChat.map((m) => m.id), ['c1', 'c2']);
});

test('updates and deletes apply; re-sending the same batch is idempotent', async () => {
  const u = await createUser('update');
  await sync(u.token, fullOps);
  await sync(u.token, fullOps); // retry after a lost response must not duplicate
  let s = await state(u.token);
  assert.equal(s.workoutLogs.length, 2);
  assert.equal(s.mealLogs.length, 2);
  assert.equal(s.coachChat.length, 2);

  await sync(u.token, [
    { type: 'workout.upsert', data: { id: 'w_a', date: '2026-10-02', day: 'Back', exercises: [{ exId: 'ex15', sets: [{ reps: 10, weight: 45 }] }] } },
    { type: 'meal.delete', id: 'meal1' },
    { type: 'workout.delete', id: 'w_b' },
    { type: 'steps.set', data: { date: '2026-10-02', steps: 9000 } },
    { type: 'dietPlan.set', data: null },
  ]);
  s = await state(u.token);
  assert.deepEqual(s.workoutLogs.map((w) => w.id), ['w_a']);
  assert.deepEqual(s.workoutLogs[0].exercises, [{ exId: 'ex15', sets: [{ reps: 10, weight: 45 }] }]);
  assert.deepEqual(s.mealLogs.map((m) => m.uid), ['meal2']);
  assert.equal(s.stepLogs[0].steps, 9000);
  assert.equal(s.dietPlan, null);
});

test('invalid input is rejected with a 400 and nothing in the batch is applied', async () => {
  const u = await createUser('invalid');
  const res = await sync(u.token, [
    { type: 'meal.upsert', data: { uid: 'ok1', date: '2026-10-02', meal: 'Lunch', name: 'Rice', cal: 200, p: 4, c: 44, f: 1 } },
    { type: 'meal.upsert', data: { uid: 'bad1', date: '2026-13-45', meal: 'Lunch', name: 'Rice', cal: 200, p: 4, c: 44, f: 1 } },
  ]);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /ops\[1\].*date/);
  assert.deepEqual((await state(u.token)).mealLogs, [], 'whole batch rolled back');

  const cases = [
    { type: 'meal.upsert', data: { uid: 'x', date: '2026-10-02', meal: 'Lunch', name: 'Rice', cal: -5, p: 4, c: 44, f: 1 } },
    { type: 'workout.upsert', data: { id: 'w', date: '2026-10-02', day: 'X', exercises: [{ exId: 'ex1', sets: [{ reps: 'lots', weight: 5 }] }] } },
    { type: 'profile.set', data: { sex: 'other', age: 20, heightCm: 170, weightKg: 60, activity: '1.2', goal: 'cut', diet: 'veg' } },
    { type: 'routine.set', data: { Push: ['ex1; DROP TABLE users'] } },
    { type: 'nope.unknown', data: {} },
  ];
  for (const op of cases) {
    const r = await sync(u.token, [op]);
    assert.equal(r.status, 400, `${op.type} should be rejected`);
  }
  assert.equal((await sync(u.token, 'not-a-list')).status, 400);
});

test('users can only read and change their own records', async () => {
  const alice = await createUser('alice');
  const bob = await createUser('bob');
  await sync(alice.token, fullOps);

  // Bob sees none of Alice's data.
  const bobState = await state(bob.token);
  assert.deepEqual(bobState.workoutLogs, []);
  assert.deepEqual(bobState.mealLogs, []);
  assert.equal(bobState.username, bob.username);

  // Bob reusing Alice's client ids only ever touches Bob's own rows.
  await sync(bob.token, [
    { type: 'workout.delete', id: 'w_a' },
    { type: 'meal.delete', id: 'meal1' },
    { type: 'workout.upsert', data: { id: 'w_b', date: '2026-01-01', day: 'Hijack', exercises: [] } },
    { type: 'dietPlan.set', data: null },
    { type: 'coach.clear' },
  ]);
  const a = await state(alice.token);
  assert.deepEqual(a.workoutLogs.map((w) => w.id), ['w_b', 'w_a']);
  assert.equal(a.workoutLogs[0].day, 'Chest & Shoulder', 'Alice’s workout untouched');
  assert.equal(a.mealLogs.length, 2);
  assert.ok(a.dietPlan);
  assert.equal(a.coachChat.length, 2);

  const b = await state(bob.token);
  assert.deepEqual(b.workoutLogs.map((w) => w.day), ['Hijack']);

  // The user id in the body is ignored — identity comes only from the token.
  await request(app).post('/api/data/sync').set(auth(bob.token))
    .send({ userId: alice.user.id, ops: [{ type: 'steps.set', data: { date: '2026-10-05', steps: 1 } }] });
  assert.deepEqual((await state(alice.token)).stepLogs, [{ date: '2026-10-02', steps: 8450 }]);
});

test('sync rejects oversized batches', async () => {
  const u = await createUser('big');
  const ops = Array.from({ length: 501 }, (_, i) => ({ type: 'steps.set', data: { date: '2026-01-01', steps: i } }));
  assert.equal((await sync(u.token, ops)).status, 400);
});

test('saved foods ("My foods") round-trip, update, delete, and stay per-user', async () => {
  const a = await createUser('foodsA');
  const b = await createUser('foodsB');
  const curry = { id: 'sf_1', n: 'Mom’s chicken curry', serving: '1 bowl', cal: 420, p: 32, c: 18, f: 24 };
  const shake = { id: 'sf_2', n: 'Protein shake', cal: 180, p: 30 }; // carbs/fat optional
  assert.equal((await sync(a.token, [{ type: 'savedFood.upsert', data: curry }, { type: 'savedFood.upsert', data: shake }])).status, 200);

  let s = await state(a.token);
  assert.deepEqual(s.savedFoods, [curry, { id: 'sf_2', n: 'Protein shake', cal: 180, p: 30, c: 0, f: 0 }]);

  await sync(a.token, [{ type: 'savedFood.upsert', data: { ...curry, cal: 450, serving: '1 large bowl' } }, { type: 'savedFood.delete', id: 'sf_2' }]);
  s = await state(a.token);
  assert.deepEqual(s.savedFoods, [{ ...curry, cal: 450, serving: '1 large bowl' }]);

  // Another account can't see, change or delete them, even with the same ids.
  assert.deepEqual((await state(b.token)).savedFoods, []);
  await sync(b.token, [{ type: 'savedFood.delete', id: 'sf_1' }, { type: 'savedFood.upsert', data: { ...curry, n: 'Hijack' } }]);
  assert.equal((await state(a.token)).savedFoods[0].n, 'Mom’s chicken curry');

  const bad = await sync(a.token, [{ type: 'savedFood.upsert', data: { id: 'sf_3', n: '', cal: 100, p: 1 } }]);
  assert.equal(bad.status, 400);
  assert.equal((await sync(a.token, [{ type: 'savedFood.upsert', data: { id: 'sf_4', n: 'X', cal: -1, p: 1 } }])).status, 400);
});

test('saved foods come along in a backup import without duplicating', async () => {
  const u = await createUser('foodsImp');
  const data = { username: 'whoever', savedFoods: [{ id: 'sf_9', n: 'Paneer wrap', cal: 510, p: 26, c: 48, f: 22 }] };
  const first = await request(app).post('/api/data/import').set(auth(u.token)).send({ source: 'backup-file', data });
  assert.equal(first.body.counts.savedFoods, 1);
  data.savedFoods.push({ id: 'sf_10', n: 'Oats', cal: 300, p: 12, c: 50, f: 6 });
  const second = await request(app).post('/api/data/import').set(auth(u.token)).send({ source: 'backup-file', data });
  assert.equal(second.body.counts.savedFoods, 1);
  assert.equal(second.body.state.savedFoods.length, 2);
});
