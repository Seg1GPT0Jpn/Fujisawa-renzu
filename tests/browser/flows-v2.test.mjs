// V2 の操作フロー（ホーム→避難先、誤案内の防止、指定と開設の区別、混雑の公式導線）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { startServer } from '../../scripts/dev-server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
let server; let browser; let base;
const VIEW = { width: 390, height: 844 };

before(async () => {
  server = await startServer({ port: 0, quiet: true });
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
  // 既存テストは日本語表示を前提にする（ブラウザ言語による自動切替を固定）
  const newContext = browser.newContext.bind(browser);
  browser.newContext = (o = {}) => newContext({ locale: 'ja-JP', ...o });
});
after(async () => { await browser?.close(); server?.close(); });

async function ctxPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: VIEW, serviceWorkers: 'block', ...opts });
  const page = await ctx.newPage();
  return { ctx, page };
}
const top = (page, sel) => page.evaluate((s) => document.querySelector(s).getBoundingClientRect().top + scrollY, sel);

test('ホーム：3つの入口が1〜2画面に収まり、災害種別が1タップで選べる', async () => {
  const { ctx, page } = await ctxPage();
  await page.goto(base, { waitUntil: 'networkidle' });
  assert.ok(await top(page, '#h-emergency') < 200, '災害時の入口が最上部');
  assert.ok(await top(page, 'a.tile[href^="shelters.html?hazard=tsunami"]') < VIEW.height, '津波ボタンが1画面目');
  for (const id of ['#h-env', '#h-prepare']) assert.ok(await page.isVisible(id));
  await page.click('a.tile[href^="shelters.html?hazard=tsunami"]');
  await page.waitForSelector('#hz-tsunami[aria-pressed="true"]');
  await page.waitForSelector('#results li.card');
  assert.match(await page.textContent('#results-summary'), /津波/);
  await ctx.close();
});

test('ホームの災害種別ボタンはすべてデータに存在する種別（高潮など未収録は出さない）', async () => {
  const html = await readFile(new URL('../../site/index.html', import.meta.url), 'utf8');
  const data = JSON.parse(await readFile(new URL('../../site/data/shelters.json', import.meta.url), 'utf8'));
  const keys = [...html.matchAll(/shelters\.html\?hazard=([a-z_]+)/g)].map((m) => m[1]);
  const valid = new Set([...data.hazards.map((h) => h.key), 'shelter']);
  assert.ok(keys.length >= 8);
  for (const k of keys) assert.ok(valid.has(k), k);
  assert.ok(!keys.includes('storm_surge'));
});

test('避難先：すべての災害種別ボタンが1画面目に収まる', async () => {
  const { ctx, page } = await ctxPage();
  await page.goto(base + 'shelters.html', { waitUntil: 'networkidle' });
  const last = await top(page, '#hz-shelter');
  assert.ok(last + 52 <= VIEW.height, `hz-shelter top=${last}`);
  await ctx.close();
});

test('津波：結果より前に津波避難ビルの案内、市のみ指定の施設は推奨せず名前だけ案内', async () => {
  const { ctx, page } = await ctxPage({ permissions: ['geolocation'], geolocation: { latitude: 35.3175, longitude: 139.4715 } });
  await page.goto(base + 'shelters.html?hazard=tsunami&go=1', { waitUntil: 'networkidle' });
  await page.waitForSelector('#results li.card');
  const order = await page.evaluate(() => {
    const pre = document.getElementById('results-pre');
    const link = [...pre.querySelectorAll('a')].find((a) => a.textContent.includes('津波避難ビル'));
    const list = document.getElementById('results');
    return link && (link.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING) ? 'before' : 'after';
  });
  assert.equal(order, 'before');
  const post = await page.textContent('#results-post');
  assert.match(post, /鵠南小学校/);
  assert.match(post, /公式一覧で確認が必要/);
  const names = await page.$$eval('#results li.card h3', (hs) => hs.map((h) => h.textContent));
  assert.ok(!names.includes('鵠南小学校'), '市のみ指定の施設を推奨一覧に入れない');
  await ctx.close();
});

test('結果の先頭に「指定施設であり開設状況ではない」旨と公式の開設情報への導線', async () => {
  const { ctx, page } = await ctxPage();
  await page.goto(base + 'shelters.html', { waitUntil: 'networkidle' });
  await page.click('#hz-earthquake');
  await page.waitForSelector('#results li.card');
  const pre = await page.textContent('#results-pre');
  assert.match(pre, /指定されている施設/);
  assert.match(pre, /開いているかは分かりません/);
  assert.equal(await page.locator('#results-pre a[href*="congestion_situation"]').count(), 1);
  const first = await page.textContent('#results li.card');
  assert.match(first, /開設状況このデータには含まれません/);
  await ctx.close();
});

test('照合で除外された種別の施設は結果に出ない（データ差し替えで確認）', async () => {
  const { ctx, page } = await ctxPage();
  const data = JSON.parse(await readFile(new URL('../../site/data/shelters.json', import.meta.url), 'utf8'));
  const target = data.facilities.find((f) => f.supportedHazards.includes('flood') && !f.notice);
  target.excludedHazards = ['flood'];
  await page.route('**/data/shelters.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) }));
  await page.goto(base + 'shelters.html', { waitUntil: 'networkidle' });
  await page.click('#hz-flood');
  await page.waitForSelector('#results li.card');
  while (await page.isVisible('#more-btn')) await page.click('#more-btn');
  const names = await page.$$eval('#results li.card h3', (hs) => hs.map((h) => h.textContent));
  assert.ok(!names.includes(target.name));
  await ctx.close();
});

test('存在しない種別を指定されたら案内を出し、勝手に別の種別を選ばない', async () => {
  const { ctx, page } = await ctxPage();
  await page.goto(base + 'shelters.html?hazard=storm_surge', { waitUntil: 'networkidle' });
  assert.match(await page.textContent('#locate-state'), /データにありません/);
  assert.equal(await page.locator('input[name="hazard"]:checked').count(), 0);
  await ctx.close();
});

test('混雑：公式の開設・混雑情報が最初の主ボタン、API未設定なら報告画面を出さない', async () => {
  const { ctx, page } = await ctxPage();
  await page.goto(base + 'crowding.html', { waitUntil: 'networkidle' });
  const firstBtn = await page.$eval('main .bigbtn', (a) => a.href);
  assert.match(firstBtn, /congestion_situation/);
  assert.ok(await top(page, '#official-btn') < 300);
  assert.equal(await page.locator('#facility').count(), 0, '報告用の選択欄を出さない');
  assert.equal(await page.locator('#report-form').count(), 0);
  assert.match(await page.textContent('#user-reports'), /準備中のため、現在は利用できません/);
  await ctx.close();
});
