const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/address/address.js'), 'utf8');
function setup(request, onboarding = false) {
  let page; let relaunched = ''; let toast = '';
  vm.runInNewContext(source, {
    require: () => ({ request }),
    Page: value => { page = value; },
    wx: { chooseAddress() {}, showToast(value) { toast = value.title; }, reLaunch(value) { relaunched = value.url; }, redirectTo() {} }
  });
  page.setData = patch => { for (const [key, value] of Object.entries(patch)) { const parts = key.split('.'); let target = page.data; while (parts.length > 1) target = target[parts.shift()]; target[parts[0]] = value; } };
  page.data.onboarding = onboarding;
  page.openManual();
  Object.assign(page.data.manual, { recipientName: '张三', phone: '13800138000', province: '江苏省', city: '苏州市', district: '昆山市', detail: '测试路1号' });
  return { page, relaunched: () => relaunched, toast: () => toast };
}
(async () => {
  let calls = 0; let resolve; const pendingRequest = new Promise(done => { resolve = done; });
  const success = setup((url, options) => { calls++; assert.equal(url, '/api/addresses'); assert.equal(options.method, 'POST'); return calls === 1 ? pendingRequest : Promise.resolve({ addresses: [] }); });
  const pending = success.page.saveManual(); await success.page.saveManual();
  assert.equal(calls, 1, 'concurrent saves must send one request'); assert.equal(success.page.data.saving, true);
  resolve({}); await pending; assert.equal(success.page.data.manualOpen, false); assert.equal(success.toast(), '地址已保存');
  const invalid = setup(() => { throw new Error('invalid form must not request'); }); invalid.page.data.manual.phone = '123'; await invalid.page.saveManual(); assert.match(invalid.page.data.formError, /手机号/);
  let retries = 0; const failure = setup(() => { retries++; return Promise.reject(new Error('网络异常')); }); await failure.page.saveManual(); assert.equal(failure.page.data.saving, false); assert.equal(failure.page.data.formError, '网络异常'); await failure.page.saveManual(); assert.equal(retries, 2);
  const onboarding = setup(() => Promise.resolve({}), true); await onboarding.page.saveManual(); assert.equal(onboarding.relaunched(), '/pages/home/home');
  console.log('PASS: manual address validation, duplicate lock, retry, refresh and onboarding');
})().catch(error => { console.error(error); process.exitCode = 1; });
