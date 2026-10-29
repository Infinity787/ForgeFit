// The rest timer rings through a scheduled Android notification (so it works
// in the background), and logging a set doesn't make the page jump.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tick, userState, mockServer, launch } = require('./helpers/app');

const trainUser = () => userState({ routine: { Push: ['ex0', 'ex1'] } });

function fakeNotifications({ granted = true, inexact = false } = {}) {
  const calls = [];
  const LN = {
    createChannel: async (c) => { calls.push(['channel', c]); },
    checkPermissions: async () => ({ display: granted ? 'granted' : 'prompt' }),
    requestPermissions: async () => { calls.push(['request']); return { display: granted ? 'granted' : 'denied' }; },
    schedule: async (o) => { calls.push(['schedule', o.notifications[0]]); return inexact ? { notifications: [], warning: { code: 'x', message: 'inexact' } } : { notifications: [] }; },
    cancel: async (o) => { calls.push(['cancel', o.notifications[0].id]); },
    changeExactNotificationSetting: async () => { calls.push(['exactSettings']); return { exact_alarm: 'granted' }; },
  };
  return { calls, setup: (w) => { w.Capacitor = { isNativePlatform: () => true, Plugins: { LocalNotifications: LN } }; } };
}

async function openTrain(w) {
  w.goToView('train');
  if (w.eval('trainState.activeDay') !== 'Push') await w.selectTrainDay('Push');
}

test('starting the rest timer schedules a ringing notification for when it ends', async () => {
  const n = fakeNotifications();
  const w = await launch(mockServer(trainUser()), undefined, n.setup);
  await openTrain(w);
  const before = Date.now();
  w.startRestTimer(90);
  await tick(30);
  const channel = n.calls.find((c) => c[0] === 'channel')[1];
  assert.deepEqual([channel.id, channel.sound, channel.importance], ['rest-timer', 'rest_done.wav', 5]);
  const sched = n.calls.filter((c) => c[0] === 'schedule').map((c) => c[1]);
  assert.equal(sched.length, 1);
  const at = sched[0].schedule.at.getTime();
  assert.ok(at >= before + 89000 && at <= Date.now() + 90000, 'rings when the rest ends');
  assert.equal(sched[0].schedule.allowWhileIdle, true, 'rings even when the phone is idle');
  assert.equal(sched[0].channelId, 'rest-timer');
  assert.deepEqual(w.__errors, []);
});

test('cancelling or restarting the timer cancels the pending alarm', async () => {
  const n = fakeNotifications();
  const w = await launch(mockServer(trainUser()), undefined, n.setup);
  await openTrain(w);
  w.startRestTimer(60);
  await tick(30);
  w.startRestTimer(120);
  await tick(30);
  const kinds = n.calls.map((c) => c[0]).filter((k) => k === 'schedule' || k === 'cancel');
  assert.equal(kinds[kinds.length - 1], 'schedule', 'the newest timer is the one scheduled');
  assert.ok(kinds.filter((k) => k === 'cancel').length >= 2);
  n.calls.length = 0;
  w.stopRestTimer(false);
  await tick(30);
  assert.deepEqual(n.calls, [['cancel', 4207]]);
});

test('a timer that finishes in the app leaves the alarm to ring (not cancelled)', async () => {
  const n = fakeNotifications();
  const w = await launch(mockServer(trainUser()), undefined, n.setup);
  await openTrain(w);
  w.startRestTimer(60);
  await tick(30);
  n.calls.length = 0;
  w.stopRestTimer(true);
  await tick(30);
  assert.deepEqual(n.calls, []);
});

test('if Android would ring late, the app asks once to allow exact alarms', async () => {
  const n = fakeNotifications({ inexact: true });
  const w = await launch(mockServer(trainUser()), undefined, n.setup);
  await openTrain(w);
  w.startRestTimer(60);
  await tick(50);
  const modal = w.document.getElementById('choiceModal');
  assert.ok(modal, 'explains and offers settings');
  [...modal.querySelectorAll('button')].find((b) => /Open settings/.test(b.textContent)).click();
  await tick(20);
  assert.ok(n.calls.some((c) => c[0] === 'exactSettings'));
  w.startRestTimer(60);
  await tick(50);
  assert.equal(w.document.getElementById('choiceModal'), null, 'only asked once');
});

test('without notification permission the timer still runs, with a hint', async () => {
  const n = fakeNotifications({ granted: false });
  const w = await launch(mockServer(trainUser()), undefined, n.setup);
  await openTrain(w);
  w.startRestTimer(60);
  await tick(50);
  assert.ok(!n.calls.some((c) => c[0] === 'schedule'));
  assert.equal(w.eval('trainState.restTimer.active'), true);
});

test('logging a set keeps the exercise at the same place on screen', async () => {
  const w = await launch(mockServer(trainUser()));
  await openTrain(w);
  w.setRestAuto(true);
  // jsdom has no layout: report the card 300px lower after the re-render,
  // as happened when the rest-timer box above it changed size.
  let renders = 0;
  const realRender = w.renderTrain;
  w.renderTrain = () => { renders++; realRender(); };
  const proto = w.HTMLElement.prototype;
  proto.getBoundingClientRect = function () {
    const isCard = this.matches && this.matches('.log-ex[data-ex="ex1"]');
    return { top: isCard ? (renders ? 500 : 200) : 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 };
  };
  let scrolled = 0;
  w.scrollBy = (x, y) => { scrolled += y; };
  w.document.getElementById('reps_ex1').value = '8';
  w.document.getElementById('weight_ex1').value = '40';
  w.addPendingSet('ex1');
  assert.equal(scrolled, 300, 'scrolled back by exactly the shift');
  assert.equal(w.eval('trainState.restTimer.active'), true);
});
