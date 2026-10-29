// Rest days in a split: they keep the streak alive, never count as a
// workout, and custom splits are asked to include them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { userState, mockServer, launch } = require('./helpers/app');

const ROUTINE = { Push: ['ex0'], Pull: ['ex1'], Legs: ['ex2'], 'Chest & Back': ['ex0'], Arms: ['ex1'], Rest: [], 'Rest 2': [] };

function ago(w, n) { return w.daysAgo(n); }
const log = (date, day) => ({ id: 'w_' + date, date, day, exercises: [{ exId: 'ex0', sets: [{ reps: 5, weight: 50 }] }] });

async function withWorkouts(routine, build) {
  // Dates are relative to "today", so build the logs inside the page.
  const w0 = await launch(mockServer(userState({ routine })));
  const logs = build((n) => ago(w0, n));
  return launch(mockServer(userState({ routine, workoutLogs: logs })));
}

test('rest days after the last training day keep the streak without counting', async () => {
  const days = ['Push', 'Pull', 'Legs', 'Chest & Back', 'Arms'];
  const w = await withWorkouts(ROUTINE, (d) => days.map((day, i) => log(d(6 - i), day)));
  // Trained 6..2 days ago, then yesterday was a Rest slot; today is the 2nd Rest slot.
  assert.equal(w.computeStreak(w.currentUser()), 5);
  assert.equal(w.isScheduledRestDay(w.currentUser(), w.todayStr()), true);
  assert.equal(w.nextTrainingDay(w.currentUser()), 'Push');
  w.goToView('dashboard');
  assert.match(w.document.getElementById('view-dashboard').textContent, /Rest day/);
  assert.equal(w.document.getElementById('statStreak').textContent.length > 0, true);
});

test('missing a training day still breaks the streak', async () => {
  const w = await withWorkouts(ROUTINE, (d) => [log(d(4), 'Push'), log(d(3), 'Pull')]);
  // Legs was due 2 days ago and was skipped.
  assert.equal(w.computeStreak(w.currentUser()), 0);
});

test('more rest days than the split allows breaks the streak', async () => {
  const routine = { Push: ['ex0'], Pull: ['ex1'], Rest: [] };
  const w = await withWorkouts(routine, (d) => [log(d(4), 'Push'), log(d(3), 'Pull')]);
  // Rest 2 days ago is fine, but yesterday should have been Push.
  assert.equal(w.computeStreak(w.currentUser()), 0);
  const w2 = await withWorkouts(routine, (d) => [log(d(3), 'Push'), log(d(2), 'Pull')]);
  assert.equal(w2.computeStreak(w2.currentUser()), 2, 'yesterday was the Rest slot');
});

test('a split without rest days works as before', async () => {
  const routine = { Push: ['ex0'], Pull: ['ex1'] };
  const w = await withWorkouts(routine, (d) => [log(d(2), 'Push'), log(d(1), 'Pull')]);
  assert.equal(w.computeStreak(w.currentUser()), 2);
  const w2 = await withWorkouts(routine, (d) => [log(d(3), 'Push'), log(d(2), 'Pull')]);
  assert.equal(w2.computeStreak(w2.currentUser()), 0);
});

test('rest days are not training days in Train', async () => {
  const w = await launch(mockServer(userState({ routine: ROUTINE })));
  w.goToView('train');
  const tabs = [...w.document.querySelectorAll('#view-train [role="tab"]')].map((b) => b.textContent.replace(/·.*/, '').trim());
  assert.deepEqual(tabs, ['Push', 'Pull', 'Legs', 'Chest & Back', 'Arms']);
});

test('custom day names: repeated "Rest" is numbered, and a missing rest day is flagged', async () => {
  const w = await launch(mockServer(userState()));
  assert.deepEqual([...w.parseDayNames('Push, Rest, Pull, rest')], ['Push', 'Rest', 'Pull', 'rest 2']);
  assert.equal(w.isRestDayName('Rest 2'), true);
  assert.equal(w.isRestDayName('Off'), true);
  assert.equal(w.isRestDayName('Rest Day'), true);
  assert.equal(w.isRestDayName('Restorative Yoga'), false);
  let asked = 0;
  w.confirm = () => { asked++; return false; };
  assert.equal(w.confirmNoRestDay(['Push', 'Pull']), false);
  assert.equal(w.confirmNoRestDay(['Push', 'Rest']), true);
  assert.equal(asked, 1);
});
