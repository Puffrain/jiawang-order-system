const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/review/review.js'), 'utf8');
function setup(request) {
  let page;
  let backs = 0;
  vm.runInNewContext(source, {
    require: () => ({ request }),
    Page: value => { page = value; },
    wx: { showToast() {}, navigateBack() { backs++; } }
  });
  page.setData = patch => Object.assign(page.data, patch);
  page.onLoad({ orderId: 'order', orderItemId: 'item' });
  page.onInput({ detail: { value: 'Good product' } });
  return { page, backs: () => backs };
}
(async () => {
  let calls = 0;
  let resolve;
  const deferred = new Promise(done => { resolve = done; });
  const success = setup(() => { calls++; return deferred; });
  const pending = success.page.submit();
  await success.page.submit();
  assert.equal(calls, 1, 'concurrent clicks must not send another request');
  assert.equal(success.page.data.submitting, true);
  resolve({});
  await pending;
  await success.page.submit();
  assert.equal(calls, 1, 'success must remain locked');
  assert.equal(success.backs(), 1);
  assert.equal(success.page.data.submitting, false);
  let attempts = 0;
  const failure = setup(() => { attempts++; return Promise.reject(new Error('offline')); });
  await failure.page.submit();
  assert.equal(failure.page.data.submitting, false);
  assert.equal(failure.page.data.submitted, false);
  await failure.page.submit();
  assert.equal(attempts, 2, 'failure must allow explicit retry');
  assert.equal(failure.backs(), 0);
  const invalid = setup(() => { throw new Error('must not request'); });
  invalid.page.data.orderItemId = '';
  await invalid.page.submit();
  invalid.page.data.orderItemId = 'item';
  invalid.page.data.content = '  ';
  await invalid.page.submit();
  console.log('PASS: duplicate submit, success lock, failure retry, invalid input');
})().catch(error => { console.error(error); process.exitCode = 1; });
