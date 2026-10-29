// Rest-timer settings/auto-start, sets shown exactly as logged, the
// full-day diet view, and quantity-based saved foods.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tick, plain, userState, mockServer, launch, deviceStorage, type } = require('./helpers/app');

const LAST_PUSH = {
  id: 'w_prev', date: '2026-10-01', day: 'Push', exercises: [
    { exId: 'ex0', sets: [{ type: 'unilateral', left: { reps: 10, weight: 12.5 }, right: { reps: 9, weight: 12.5 } }] },
    { exId: 'ex1', sets: [{ type: 'dropset', drops: [{ reps: 8, weight: 40 }, { reps: 6, weight: 30 }] }] },
  ],
};
const trainUser = () => userState({ routine: { Push: ['ex0', 'ex1'] }, workoutLogs: [LAST_PUSH] });

async function openTrain(w) {
  w.goToView('train');
  if (w.eval('trainState.activeDay') !== 'Push') await w.selectTrainDay('Push');
}

/* ---------------- unilateral / drop sets shown as logged ---------------- */

test('"last" shows each side of a unilateral set and every drop, without adding reps', async () => {
  const w = await launch(mockServer(trainUser()));
  await openTrain(w);
  const heads = [...w.document.querySelectorAll('#view-train .log-ex__last')].map((e) => e.textContent);
  assert.deepEqual(heads, ['last L 12.5kg × 10 · R 12.5kg × 9', 'last Drop 40kg × 8 → 30kg × 6']);
  assert.ok(!heads.join(' ').includes('× 19'), 'left and right reps are never summed');

  w.toggleExMode('ex0', 'unilateral');
  const v = (id) => w.document.getElementById(id).value;
  assert.deepEqual([v('lreps_ex0'), v('lwt_ex0'), v('rreps_ex0'), v('rwt_ex0')], ['10', '12.5', '9', '12.5']);

  w.toggleExMode('ex1', 'dropset');
  assert.deepEqual([v('drep_ex1_0'), v('dwt_ex1_0'), v('drep_ex1_1'), v('dwt_ex1_1')], ['8', '40', '6', '30']);
});

test('logged sets, history and records also show sets as logged', async () => {
  const w = await launch(mockServer(trainUser()));
  await openTrain(w);
  w.toggleExMode('ex0', 'unilateral');
  type(w, 'rreps_ex0', '8');
  w.addPendingSet('ex0');
  assert.match(w.document.querySelector('#view-train .set-chip').textContent, /L 12\.5kg × 10 · R 12\.5kg × 8/);

  w.goToView('progress');
  assert.match(w.document.getElementById('view-progress').textContent, /L 12\.5kg × 10 · R 12\.5kg × 9/);
});

/* ---------------- rest timer ---------------- */

test('rest length can be chosen or typed, and is remembered', async () => {
  const server = mockServer(trainUser());
  const w = await launch(server);
  await openTrain(w);
  type(w, 'restCustomSec', '45');
  assert.equal(w.getPrefs().restSeconds, 45);
  assert.match(w.document.getElementById('restTimerWidget').textContent, /Start 0:45/);

  type(w, 'restCustomSec', '3');
  assert.match(w.document.getElementById('restCustomError').textContent, /between 10 and 900/);
  assert.equal(w.getPrefs().restSeconds, 45, 'invalid values are not saved');

  w.chooseRestPreset(120);
  assert.equal(w.eval('trainState.restTimer.active'), true, 'a preset starts the timer right away (as before)');
  assert.equal(w.eval('trainState.restTimer.duration'), 120);
  w.stopRestTimer(false);

  const w2 = await launch(server, deviceStorage(w)); // app restart
  await openTrain(w2);
  assert.equal(w2.getPrefs().restSeconds, 120);
});

test('with auto-start on, the timer starts after each logged set', async () => {
  const server = mockServer(trainUser());
  const w = await launch(server);
  await openTrain(w);
  type(w, 'restCustomSec', '75');

  w.addPendingSet('ex0');
  assert.equal(w.eval('trainState.restTimer.active'), false, 'off by default');

  const auto = w.document.getElementById('restAutoToggle');
  auto.checked = true;
  auto.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(w.getPrefs().restAuto, true);

  w.addPendingSet('ex0');
  assert.equal(w.eval('trainState.restTimer.active'), true);
  assert.equal(w.eval('trainState.restTimer.duration'), 75);
  assert.equal(w.document.getElementById('restTimerDisplay').textContent, '1:15');

  // The countdown follows the clock, not timer ticks.
  w.eval('trainState.restTimer.endsAt -= 30000; tickRestTimer();');
  assert.equal(w.document.getElementById('restTimerDisplay').textContent, '0:45');
  w.eval('trainState.restTimer.endsAt = Date.now() - 1; tickRestTimer();');
  assert.equal(w.eval('trainState.restTimer.active'), false, 'stops at zero');

  // A rejected set (no reps) doesn't start the timer.
  type(w, 'reps_ex0', '');
  w.addPendingSet('ex0');
  assert.equal(w.eval('trainState.restTimer.active'), false);
  assert.deepEqual(w.__errors, []);
});

/* ---------------- full-day diet view ---------------- */

function dayMeals() {
  const m = (uid, date, meal, name, cal, p, extra) => Object.assign({ uid, date, meal, foodId: null, name, servings: 1, qtyUnit: 'custom', qtyAmount: 1, cal, p, c: 10, f: 5, source: 'custom' }, extra || {});
  return [
    m('m1', '2026-10-20', 'Breakfast', 'Oats', 300, 12),
    m('m2', '2026-10-20', 'Lunch', 'Dal rice', 520, 18),
    m('m3', '2026-10-20', 'Lunch', 'Curd', 120, 6, { qtyUnit: 'g', qtyAmount: 150 }),
    m('m4', '2026-10-21', 'Dinner', 'Paneer wrap', 510, 26),
  ];
}

test('a day’s diet can be opened and shows every meal, item and total', async () => {
  const w = await launch(mockServer(userState({ mealLogs: dayMeals() })));
  w.goToView('diet');
  w.openDayDiet('2026-10-20');
  const modal = w.document.getElementById('dayDietModal');
  assert.ok(modal.classList.contains('active'));
  const text = modal.textContent;
  assert.match(text, /Breakfast/);
  assert.match(text, /Lunch/);
  assert.match(text, /Oats/);
  assert.match(text, /Dal rice/);
  assert.match(text, /Curd 150 g/);
  assert.doesNotMatch(text, /Paneer wrap/, 'only that day');
  assert.match(text, /940\s*\/ 2,739 kcal/, 'calorie total for the day');
  assert.match(w.document.getElementById('dayDietSub').textContent, /3 items logged/);

  w.shiftDayDiet(1);
  assert.match(modal.textContent, /Paneer wrap/);
  assert.doesNotMatch(modal.textContent, /Dal rice/);

  w.pickDayDiet('2026-10-05');
  assert.match(modal.textContent, /No food logged on this day/);

  w.closeDayDiet();
  assert.ok(!modal.classList.contains('active'));
});

test('the "Last 7 days" rows open that day', async () => {
  const today = new Date();
  const ds = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  const w = await launch(mockServer(userState({ mealLogs: [{ uid: 'mt', date: ds, meal: 'Snack', foodId: null, name: 'Banana', servings: 1, qtyUnit: 'serving', qtyAmount: 1, cal: 105, p: 1.3, c: 27, f: 0.4, source: 'library' }] })));
  w.goToView('diet');
  const rows = w.document.querySelectorAll('#view-diet .day-row');
  assert.equal(rows.length, 7);
  rows[0].click();
  assert.match(w.document.getElementById('dayDietModal').textContent, /Banana/);
  assert.equal(w.document.getElementById('dayDietTitle').textContent, 'Today');
});
