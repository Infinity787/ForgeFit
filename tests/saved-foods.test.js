// End-to-end tests for "My foods" (saved custom foods) in the Diet view.
// They load the real index.html in jsdom against a mocked API.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const plain = (v) => JSON.parse(JSON.stringify(v));

function userState(extra) {
  return Object.assign({
    username: 'lifter', email: 'lifter@example.com', name: 'Test Lifter', backendAuth: true, onboarded: true,
    profile: { sex: 'male', age: 19, heightCm: 175, weightKg: 57, activity: '1.55', goal: 'bulk', diet: 'veg' },
    targets: { calories: 2739, protein: 108, carbs: 406, fat: 76, bmr: 1574, tdee: 2439 },
    splitType: 'Custom', routine: { Push: ['ex0'] }, customExercises: [],
    workoutLogs: [], mealLogs: [], stepLogs: [], savedFoods: [], dietPlan: null, dietPlanChecks: {}, coachChat: [],
  }, extra || {});
}

function mockServer(state) {
  const server = { ops: [] };
  server.fetch = async (url, opts = {}) => {
    const p = new URL(url).pathname;
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (p.endsWith('/api/data') && (opts.method || 'GET') === 'GET') return json(200, { ok: true, state });
    if (p.endsWith('/api/data/sync')) { server.ops.push(...JSON.parse(opts.body).ops); return json(200, { ok: true }); }
    return json(404, { error: 'Not found.' });
  };
  return server;
}

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
  for (let i = 0; i < 100 && !w.document.getElementById('app').classList.contains('active'); i++) await tick(20);
  w.__errors = errors;
  return w;
}

const SESSION = { forgefit_session_v1: JSON.stringify({ username: 'lifter', mode: 'supabase', access_token: 't', refresh_token: 'r', expires_at: Date.now() + 3600e3, email: 'lifter@example.com', name: 'Test Lifter' }) };
const deviceStorage = (w) => Object.fromEntries(Object.keys(w.localStorage).map((k) => [k, w.localStorage.getItem(k)]));
const val = (w, id, v) => { w.document.getElementById(id).value = v; };

async function addCustom(w, { name, serving = '', cal, p, c = '', f = '', save }) {
  w.goToView('diet');
  if (!w.document.getElementById('customFoodName')) w.toggleCustomFoodForm();
  val(w, 'customFoodName', name);
  val(w, 'customFoodServing', serving);
  val(w, 'customFoodCal', String(cal));
  val(w, 'customFoodProtein', String(p));
  val(w, 'customFoodCarbs', String(c));
  val(w, 'customFoodFat', String(f));
  w.document.getElementById('customFoodSave').checked = save;
  w.addCustomFood();
  await tick(400); // let the sync debounce run
}

async function choose(w, label, action) {
  const pending = action();
  await tick(5);
  const btn = [...w.document.querySelectorAll('#choiceModal [data-choice]')].find((b) => b.textContent.includes(label));
  assert.ok(btn, 'dialog option "' + label + '" should be shown');
  btn.click();
  await pending;
  await tick(400);
}

test('a custom food can be saved with its macros and is synced to the account', async () => {
  const server = mockServer(userState());
  const w = await launch(server, SESSION);
  await addCustom(w, { name: 'Mom’s chicken curry', serving: '1 bowl', cal: 420, p: 32, c: 18, f: 24, save: true });

  const u = w.currentUser();
  assert.equal(u.mealLogs.length, 1, 'still logged to today');
  assert.equal(u.mealLogs[0].name, 'Mom’s chicken curry');
  assert.deepEqual(plain(u.savedFoods).map(({ id, ...rest }) => rest), [{ n: 'Mom’s chicken curry', cal: 420, p: 32, c: 18, f: 24, serving: '1 bowl' }]);

  const saved = server.ops.filter((o) => o.type === 'savedFood.upsert');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].data.n, 'Mom’s chicken curry');
  const list = w.document.getElementById('view-diet').textContent;
  assert.match(list, /My foods/);
  assert.match(list, /1 bowl · 420 kcal · P 32 · C 18 · F 24/);
  assert.deepEqual(w.__errors, []);
});

test('leaving "Save to My foods" unticked only logs the food', async () => {
  const server = mockServer(userState());
  const w = await launch(server, SESSION);
  await addCustom(w, { name: 'Street samosa', cal: 260, p: 5, save: false });
  assert.equal(w.currentUser().mealLogs.length, 1);
  assert.deepEqual(plain(w.currentUser().savedFoods), []);
  assert.ok(!server.ops.some((o) => o.type === 'savedFood.upsert'));
  assert.doesNotMatch(w.document.getElementById('view-diet').textContent, /My foods/);
});

test('a saved food logs again in one tap, with calories and protein adjustable first', async () => {
  const server = mockServer(userState({ savedFoods: [{ id: 'sf_shake', n: 'Protein shake', serving: '1 scoop + milk', cal: 260, p: 34, c: 14, f: 7 }] }));
  const w = await launch(server, SESSION);
  w.goToView('diet');
  w.setDietMeal('Snack');
  assert.equal(w.document.getElementById('scal_sf_shake').value, '260', 'starts with the saved calories');
  assert.equal(w.document.getElementById('sp_sf_shake').value, '34', 'and the saved protein');

  w.addSavedFood('sf_shake'); // as saved
  val(w, 'scal_sf_shake', '180');
  val(w, 'sp_sf_shake', '25');
  w.addSavedFood('sf_shake'); // adjusted
  await tick(400);

  const [asSaved, adjusted] = plain(w.currentUser().mealLogs);
  assert.deepEqual([asSaved.meal, asSaved.name, asSaved.cal, asSaved.p, asSaved.c, asSaved.f], ['Snack', 'Protein shake', 260, 34, 14, 7]);
  assert.deepEqual([adjusted.cal, adjusted.p, adjusted.c, adjusted.f, adjusted.servings], [180, 25, 14, 7, 1]);
  assert.equal(adjusted.foodId, 'sf_shake');
  assert.deepEqual(plain(w.currentUser().savedFoods)[0], { id: 'sf_shake', n: 'Protein shake', serving: '1 scoop + milk', cal: 260, p: 34, c: 14, f: 7 }, 'the saved food itself is unchanged');
  assert.ok(server.ops.some((o) => o.type === 'meal.upsert'));

  // Invalid numbers are refused.
  val(w, 'scal_sf_shake', '-5');
  w.addSavedFood('sf_shake');
  assert.equal(w.currentUser().mealLogs.length, 2);
});

test('saving the same name again updates the saved food instead of duplicating it', async () => {
  const server = mockServer(userState());
  const w = await launch(server, SESSION);
  await addCustom(w, { name: 'Dal rice', cal: 500, p: 18, save: true });
  const firstId = w.currentUser().savedFoods[0].id;
  await addCustom(w, { name: 'dal RICE', serving: 'big plate', cal: 640, p: 22, c: 100, f: 12, save: true });

  const foods = plain(w.currentUser().savedFoods);
  assert.equal(foods.length, 1);
  assert.equal(foods[0].id, firstId);
  assert.deepEqual([foods[0].n, foods[0].serving, foods[0].cal, foods[0].c], ['dal RICE', 'big plate', 640, 100]);
  assert.equal(w.currentUser().mealLogs.length, 2, 'both servings were still logged');
});

test('removing a saved food asks first and keeps meals already logged', async () => {
  const server = mockServer(userState());
  const w = await launch(server, SESSION);
  await addCustom(w, { name: 'Paneer wrap', cal: 510, p: 26, save: true });
  const id = w.currentUser().savedFoods[0].id;

  await choose(w, 'Keep it', () => w.removeSavedFood(id));
  assert.equal(w.currentUser().savedFoods.length, 1);

  await choose(w, 'Remove', () => w.removeSavedFood(id));
  assert.deepEqual(plain(w.currentUser().savedFoods), []);
  assert.equal(w.currentUser().mealLogs.length, 1, 'the logged meal stays');
  assert.ok(server.ops.some((o) => o.type === 'savedFood.delete' && o.id === id));
});

test('saved foods are there after an app restart and on a new device', async () => {
  const server = mockServer(userState());
  const w1 = await launch(server, SESSION);
  await addCustom(w1, { name: 'Overnight oats', serving: '1 jar', cal: 380, p: 20, c: 52, f: 9, save: true });
  const restart = deviceStorage(w1);
  w1.close();

  const w2 = await launch(server, restart);
  w2.goToView('diet');
  assert.match(w2.document.getElementById('view-diet').textContent, /Overnight oats/);

  // A brand-new device has no cache: the list comes from the account.
  const fresh = mockServer(userState({ savedFoods: [{ id: 'sf_x', n: 'Overnight oats', serving: '1 jar', cal: 380, p: 20, c: 52, f: 9 }] }));
  const w3 = await launch(fresh, SESSION);
  w3.goToView('diet');
  assert.match(w3.document.getElementById('view-diet').textContent, /Overnight oats/);
});
