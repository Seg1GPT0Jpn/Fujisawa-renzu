// V2 環境ページ：地図・グラフ・比較表の操作
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

async function open() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const reqs = []; const errors = [];
  page.on('request', (r) => reqs.push(r.url()));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base + 'environment.html', { waitUntil: 'networkidle' });
  return { ctx, page, reqs, errors };
}

test('土地被覆：格子データは「地図で比べる」を押すまで読み込まない', async () => {
  const { ctx, page, reqs } = await open();
  assert.ok(!reqs.some((u) => u.includes('landcover-grid.json')));
  await page.click('#lc-load');
  await page.waitForSelector('#lc-map rect[data-i]');
  assert.ok(reqs.some((u) => u.includes('landcover-grid.json')));
  assert.ok(await page.locator('#lc-map rect[data-i]').count() > 900);
  await ctx.close();
});

test('土地被覆：年の割合・2つの年の差を切り替え、区画をタップすると内訳が出る', async () => {
  const { ctx, page, errors } = await open();
  await page.click('#lc-load');
  await page.waitForSelector('#lc-map rect[data-i]');
  assert.match(await page.textContent('#lc-legend'), /割合/);
  assert.match(await page.textContent('#lc-summary'), /半分以上/);
  await page.selectOption('#lc-group', '1');
  await page.selectOption('#lc-year', '2020');
  assert.match(await page.textContent('#lc-summary'), /2020年.*農地/);
  await page.check('#lc-mode-diff');
  assert.match(await page.textContent('#lc-legend'), /差が5未満（誤差の範囲の可能性）/);
  const summary = await page.textContent('#lc-summary');
  assert.match(summary, /2020年→2024年/);
  assert.match(summary, /分類のゆらぎ/);
  assert.ok(!/悪化|改善した|開発された|原因は/.test(summary.replace('原因は不明', '')), '原因・良否を断定しない');
  await page.locator('#lc-map rect[data-i]').nth(400).click();
  const cell = await page.textContent('#lc-cell');
  assert.match(cell, /市民センターから約/);
  assert.match(cell, /地域メッシュ \d{10}/);
  assert.equal(await page.locator('#lc-cell tbody tr').count(), 5);
  // 同じ年どうしは比べない
  await page.selectOption('#lc-to', '2020');
  assert.match(await page.textContent('#lc-summary'), /異なる2つの年/);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('大気：項目・期間・測定局を切り替えるとグラフが変わり、欠測は0にせず×と「欠測等」で示す', async () => {
  const { ctx, page } = await open();
  assert.equal(await page.locator('#air-chart polyline').count() > 0, true);
  assert.ok(!(await page.isChecked('#air-st-4')), '自排局は初期状態で一般局と同じグラフに混ぜない');
  await page.selectOption('#air-item', 'PM2.5');
  await page.check('#air-st-4');
  assert.match(await page.textContent('#air-chart'), /×/);
  await page.click('#air summary >> text=グラフの数値（表）');
  const table = await page.textContent('#air table');
  assert.match(table, /欠測等/);
  // 2016年度の湘南台小学校（評価基準未満）の欄
  const cell = await page.$$eval('#air table tbody tr', (rows) => {
    const r = rows.find((tr) => tr.querySelector('th').textContent === '2016');
    const heads = [...document.querySelectorAll('#air table thead th')].map((th) => th.textContent);
    return r.children[heads.indexOf('湘南台小学校')].textContent;
  });
  assert.equal(cell, '欠測等');
  // 自排局は破線
  assert.ok(await page.locator('#air-chart polyline[stroke-dasharray]').count() > 0);
  const before = await page.locator('#air-chart polyline').count();
  await page.uncheck('#air-st-0');
  assert.ok(await page.locator('#air-chart polyline').count() < before);
  await page.selectOption('#air-from', '2020');
  assert.match(await page.textContent('#air-findings'), /2020年度/);
  assert.match(await page.textContent('#air-findings'), /言えないこと/);
  assert.match(await page.textContent('#air'), /藤沢市役所/);
  await ctx.close();
});

test('水質：年度・回×海水浴場の表で、判定を文字で示し、今日の水質ではないと明示', async () => {
  const { ctx, page } = await open();
  assert.equal(await page.locator('#water table.water tbody tr').count(), 6);
  assert.equal(await page.locator('#water table.water thead th').count(), 4);
  const t = await page.textContent('#water table.water');
  assert.match(t, /適/);
  assert.match(t, /可/);
  assert.match(t, /採水 \d+\/\d+〜\d+\/\d+のうち2日/);
  assert.match(await page.textContent('#water'), /今日の水質ではありません/);
  await ctx.close();
});
