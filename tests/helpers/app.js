// Shared jsdom harness: loads the real index.html against a mocked API.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
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

const SESSION = { forgefit_session_v1: JSON.stringify({ username: 'lifter', mode: 'supabase', access_token: 't', refresh_token: 'r', expires_at: Date.now() + 3600e3, email: 'lifter@example.com', name: 'Test Lifter' }) };

async function launch(server, storage = SESSION, setup) {
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
      if (setup) setup(w);
    },
  });
  const w = dom.window;
  for (let i = 0; i < 100 && !w.document.getElementById('app').classList.contains('active'); i++) await tick(20);
  w.__errors = errors;
  return w;
}

const deviceStorage = (w) => Object.fromEntries(Object.keys(w.localStorage).map((k) => [k, w.localStorage.getItem(k)]));
function type(w, id, value) {
  const el = w.document.getElementById(id);
  assert.ok(el, '#' + id + ' should exist');
  el.value = value;
  el.dispatchEvent(new w.Event('input', { bubbles: true }));
  el.dispatchEvent(new w.Event('change', { bubbles: true }));
}

module.exports = { tick, plain, userState, mockServer, launch, deviceStorage, type, SESSION };
