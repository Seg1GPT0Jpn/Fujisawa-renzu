// 防災チェックリスト：端末内だけに保存され、送信しないこと
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer } from '../../scripts/dev-server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
let server; let browser; let base;

before(async () => {
  server = await startServer({ port: 0, quiet: true });
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); });

test('チェックは再読み込み後も残り、POST などの送信は発生しない。ホームに進み具合が出る', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const sent = [];
  page.on('request', (r) => { if (r.method() !== 'GET' || !r.url().startsWith(base)) sent.push(`${r.method()} ${r.url()}`); });
  await page.goto(base + 'prepare.html', { waitUntil: 'networkidle' });
  const total0 = await page.locator('.check-item input').count();
  assert.ok(total0 >= 25);
  assert.match(await page.textContent('#progress'), new RegExp(`${total0}項目中 0項目`));
  await page.check('#chk-water-3d');
  await page.check('#chk-battery');
  assert.match(await page.textContent('#progress'), /2項目を確認済み/);
  // 心配な災害を選ぶと項目が増える
  await page.check('#focus-tsunami');
  assert.ok(await page.isVisible('#sec-tsunami'));
  assert.equal(await page.locator('.check-item input').count(), total0 + 3);
  await page.check('#chk-tsunami-bldg');
  await page.reload({ waitUntil: 'networkidle' });
  assert.ok(await page.isChecked('#chk-water-3d'));
  assert.ok(await page.isChecked('#focus-tsunami'));
  assert.ok(await page.isChecked('#chk-tsunami-bldg'));
  assert.match(await page.textContent('#progress'), /3項目を確認済み/);
  // 各項目に出典
  assert.equal(await page.locator('.check-item .src').count(), await page.locator('.check-item').count());
  assert.match(await page.textContent('#sec-stock'), /1人1日3リットル/);
  await page.goto(base, { waitUntil: 'networkidle' });
  assert.match(await page.textContent('#prepare-progress'), /この端末の記録：\d+項目中 3項目/);
  assert.deepEqual(sent, [], '外部・POST の通信なし');
  await ctx.close();
});

test('「すべて消す」で端末の記録を消去できる', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.goto(base + 'prepare.html', { waitUntil: 'networkidle' });
  await page.check('#chk-furniture');
  page.once('dialog', (d) => d.accept());
  await page.click('#reset-btn');
  assert.ok(!(await page.isChecked('#chk-furniture')));
  assert.equal(await page.evaluate(() => localStorage.getItem('fujisawa-lens-checklist-v1')), null);
  await ctx.close();
});

test('保存できないブラウザでは、その旨を表示する（チェック自体はできる）', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  await ctx.addInitScript(() => { Storage.prototype.setItem = () => { throw new DOMException('denied', 'QuotaExceededError'); }; });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(base + 'prepare.html', { waitUntil: 'networkidle' });
  await page.check('#chk-radio');
  assert.match(await page.textContent('#storage-state'), /保存できない/);
  assert.match(await page.textContent('#progress'), /1項目を確認済み/);
  assert.deepEqual(errors, []);
  await ctx.close();
});
