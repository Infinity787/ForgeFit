// A photo of a packaged product opens a product popup: the exact product,
// its per-100 values, and a quantity that rescales the macros before logging.
// The old online food search is gone.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tick, userState, mockServer, launch } = require('./helpers/app');

const BAR = {
  isFood: true, imageQuality: 'good', qualityNote: '', dishName: 'Protein bar', confidence: 'high', assumptions: '',
  items: [{ name: 'Protein bar', portion: '1 bar', grams: 60, calories: 230, protein: 20, carbs: 22, fat: 8 }],
  total: { calories: 230, protein: 20, carbs: 22, fat: 8 },
  packaged: { brand: 'Yoga Bar', name: 'Protein Bar', variant: 'Chocolate Brownie', unit: 'g', netQuantity: 60, servingSize: 30,
    fromLabel: true, per100: { calories: 380, protein: 33.3, carbs: 36.7, fat: 13.3 } },
};

// Stands in for the upload: answers the photo request with `estimate`.
function fakeUpload(estimate) {
  return (w) => {
    w.XMLHttpRequest = class {
      constructor() { this.upload = {}; }
      open(method, url) { this.url = url; }
      setRequestHeader() {}
      send() {
        setTimeout(() => {
          this.status = 200;
          this.responseText = JSON.stringify({ ok: true, estimate });
          this.onload();
        }, 0);
      }
      abort() {}
    };
  };
}

async function snap(estimate) {
  const w = await launch(mockServer(userState()), undefined, fakeUpload(estimate));
  w.goToView('diet');
  w.openPhotoModal();
  w.eval('photoState.blob = new Blob(["x"], {type:"image/jpeg"})');
  await w.uploadPhoto();
  await tick(20);
  return w;
}
const val = (w, id) => w.document.getElementById(id).textContent;

test('a packaged product opens the product popup with its exact name and per-100 values', async () => {
  const w = await snap(BAR);
  const body = w.document.getElementById('photoModalBody');
  assert.equal(w.eval('photoState.stage'), 'product');
  assert.match(body.textContent, /Yoga Bar/);
  assert.equal(val(w, 'productName'), 'Protein Bar');
  assert.match(body.textContent, /Chocolate Brownie/);
  assert.match(body.textContent, /Read from the label/);
  assert.equal(val(w, 'p100_cal'), '380');
  // Starts at one serving (30 g): 380 × 0.3
  assert.equal(w.document.getElementById('productQty').value, '30');
  assert.equal(val(w, 'pt_cal'), '114');
  assert.equal(val(w, 'pt_p'), '10');
  assert.deepEqual(w.__errors, []);
});

test('changing the quantity rescales the macros, and that is what gets logged', async () => {
  const w = await snap(BAR);
  const qty = w.document.getElementById('productQty');
  qty.value = '45';
  qty.dispatchEvent(new w.Event('input'));
  assert.equal(val(w, 'pt_cal'), '171');
  assert.equal(val(w, 'pt_p'), '15');
  assert.equal(val(w, 'pt_c'), '16.5');
  assert.equal(val(w, 'pt_f'), '6');

  // The whole-pack chip fills in 60 g.
  [...w.document.querySelectorAll('#productQtyChips button')].find((b) => /Whole pack/.test(b.textContent)).click();
  assert.equal(qty.value, '60');
  assert.equal(val(w, 'pt_cal'), '228');

  w.confirmProductLog();
  await tick(10);
  const logged = w.eval('currentUser().mealLogs');
  assert.equal(logged.length, 1);
  assert.deepEqual(
    [logged[0].name, logged[0].qtyUnit, logged[0].qtyAmount, logged[0].cal, logged[0].p, logged[0].c, logged[0].f],
    ['Yoga Bar Protein Bar Chocolate Brownie', 'g', 60, 228, 20, 22, 8]
  );
  assert.equal(w.document.getElementById('photoModal').classList.contains('active'), false);
  assert.match(w.document.getElementById('view-diet').textContent, /60 g/);
});

test('wrong label values can be fixed, and the totals follow', async () => {
  const w = await snap(BAR);
  const p = w.document.getElementById('pp_protein');
  p.value = '40';
  p.dispatchEvent(new w.Event('input'));
  assert.equal(val(w, 'p100_p'), '40');
  assert.equal(val(w, 'pt_p'), '12');
});

test('an empty quantity is not logged', async () => {
  const w = await snap(BAR);
  const qty = w.document.getElementById('productQty');
  qty.value = '';
  qty.dispatchEvent(new w.Event('input'));
  w.confirmProductLog();
  assert.match(val(w, 'photoFormError'), /how much/);
  assert.equal(w.eval('currentUser().mealLogs.length'), 0);
});

test('a plate of food still gets the meal estimate, and a product can fall back to it', async () => {
  const w = await snap({ ...BAR, packaged: null });
  assert.equal(w.eval('photoState.stage'), 'review');
  const w2 = await snap(BAR);
  w2.productAsMeal();
  assert.equal(w2.eval('photoState.stage'), 'review');
  assert.ok(w2.document.getElementById('pfFoodName'));
});

test('the online food search is gone from Diet', async () => {
  const w = await launch(mockServer(userState()));
  w.goToView('diet');
  assert.equal(w.document.getElementById('onlineSearchInput'), null);
  assert.doesNotMatch(w.document.getElementById('view-diet').textContent, /Search any food online/);
  assert.equal(typeof w.searchOnlineFood, 'undefined');
  assert.ok(w.document.querySelector('[aria-label="Filter the food library"]'), 'the library filter stays');
});
