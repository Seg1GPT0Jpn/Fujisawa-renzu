// 多言語表示とワンタップ検索
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer } from '../../scripts/dev-server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
let server; let browser; let base;
const GEO = { permissions: ['geolocation'], geolocation: { latitude: 35.3389, longitude: 139.4877 } };

before(async () => {
  server = await startServer({ port: 0, quiet: true });
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); });

async function open(url, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', ...opts });
  const page = await ctx.newPage();
  const reqs = []; const errors = [];
  page.on('request', (r) => reqs.push(r.url()));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url, { waitUntil: 'networkidle' });
  return { ctx, page, reqs, errors };
}

test('ワンタップ：ホームの災害ボタン1回で、現在地から近い順の結果と経路ボタンが出る', async () => {
  const { ctx, page, errors } = await open(base, { locale: 'ja-JP', ...GEO });
  await ctx.addInitScript(() => { window.__geo = 0; const g = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation); navigator.geolocation.getCurrentPosition = (...a) => { window.__geo += 1; return g(...a); }; });
  await page.click('a.tile[href^="shelters.html?hazard=flood"]');
  await page.waitForSelector('#results li.card.nearest');
  assert.equal(await page.evaluate(() => window.__geo), 1, '位置情報の取得は1回');
  assert.ok(!page.url().includes('go=1'), '再読み込みで再取得しないよう URL から外す');
  const route = await page.getAttribute('#results li.card.nearest a.route', 'href');
  assert.match(route, /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&travelmode=walking&destination=35\.\d+%2C139\.\d+$/);
  assert.ok(!route.includes('origin'), '現在地は付けない');
  assert.equal(await page.getAttribute('#results li.card.nearest a.route', 'target'), '_blank');
  // いちばん近い結果が1画面目に見えている
  const box = await page.locator('#results li.card.nearest a.route').boundingBox();
  assert.ok(box && box.y + box.height <= 844 + 1, `route button y=${box?.y}`);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('ワンタップ：避難先ページでも種別ボタン1回で検索。位置情報が使えなければ一覧をすぐ表示', async () => {
  const a = await open(base + 'shelters.html', { locale: 'ja-JP', ...GEO });
  await a.page.click('#hz-earthquake');
  await a.page.waitForSelector('#results li.card.nearest');
  assert.equal(await a.page.getAttribute('#hz-earthquake', 'aria-pressed'), 'true');
  await a.ctx.close();
  const b = await open(base + 'shelters.html', { locale: 'ja-JP', permissions: [] });
  await b.page.click('#hz-earthquake');
  await b.page.waitForSelector('#results li.card');
  assert.match(await b.page.textContent('#locate-state'), /許可されませんでした/);
  assert.equal(await b.page.locator('#results li.card.nearest').count(), 0, '距離がないときは「いちばん近い」と表示しない');
  await b.ctx.close();
});

test('ページを開いただけでは位置情報を要求しない（?go=1 がないとき）', async () => {
  const { ctx, page } = await open(base + 'shelters.html?hazard=flood', { locale: 'ja-JP', ...GEO });
  assert.equal(await page.locator('#results li.card').count(), 0);
  assert.equal(await page.getAttribute('#hz-flood', 'aria-pressed'), 'true');
  await ctx.close();
});

test('日本語のブラウザでは辞書を読み込まない（追加の通信なし）', async () => {
  const { ctx, reqs } = await open(base, { locale: 'ja-JP' });
  assert.ok(!reqs.some((u) => u.includes('/i18n/')));
  await ctx.close();
});

for (const [locale, lang, h, route] of [
  ['en-US', 'en', /In a disaster/, /Walking route/],
  ['zh-CN', 'zh', /发生灾害时/, /步行路线/],
  ['ko-KR', 'ko', /재해 시/, /도보 경로/],
  ['vi-VN', 'vi', /Khi có thiên tai/, /đường đi bộ/],
]) {
  test(`${lang}：ブラウザの言語で自動表示し、ワンタップ検索の結果も翻訳される`, async () => {
    const { ctx, page, errors } = await open(base, { locale, ...GEO });
    assert.equal(await page.getAttribute('html', 'lang'), lang === 'zh' ? 'zh-Hans' : lang);
    assert.match(await page.textContent('#h-emergency'), h);
    assert.match(await page.textContent('.i18n-note'), /Fujisawa Lens|藤泽透镜|후지사와 렌즈/);
    await page.click('a.tile[href*="hazard=tsunami"]');
    await page.waitForSelector('#results li.card.nearest');
    assert.match(await page.textContent('#results li.card.nearest a.route'), route);
    // 施設名・住所以外に日本語の文（ひらがな）が残っていない
    const leftover = await page.evaluate(() => {
      const clone = document.querySelector('main').cloneNode(true);
      clone.querySelectorAll('[lang="ja"], option, noscript').forEach((n) => n.remove());
      return (clone.textContent.match(/[ぁ-ん]{2,}/g) ?? []);
    });
    assert.deepEqual(leftover, []);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('言語の切替：選んだ言語が保存され、他のページでも使われる。日本語に戻せる', async () => {
  const { ctx, page } = await open(base, { locale: 'ja-JP' });
  await page.selectOption('#lang-select', 'ko');
  await page.waitForURL(/lang=ko/);
  await page.waitForFunction(() => document.documentElement.lang === 'ko');
  await page.goto(base + 'prepare.html', { waitUntil: 'networkidle' });
  assert.equal(await page.getAttribute('html', 'lang'), 'ko');
  assert.match(await page.textContent('h1'), /방재 준비 체크리스트/);
  assert.match(await page.textContent('#sec-stock'), /3리터/);
  await page.selectOption('#lang-select', 'ja');
  await page.waitForFunction(() => document.documentElement.lang === 'ja');
  assert.match(await page.textContent('h1'), /備えのチェックリスト/);
  await ctx.close();
});

test('本文が日本語のみのページ（環境など）は、その旨を選んだ言語で表示', async () => {
  const { ctx, page } = await open(base + 'environment.html?lang=en');
  assert.match(await page.textContent('.i18n-note'), /Japanese only/);
  assert.match(await page.textContent('h1'), /environmental change/);
  await ctx.close();
});

test('辞書が読めないときは日本語で表示する', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block', locale: 'en-US' });
  const page = await ctx.newPage();
  await page.route('**/i18n/en.json', (r) => r.fulfill({ status: 404, body: '' }));
  await page.goto(base, { waitUntil: 'networkidle' });
  assert.equal(await page.getAttribute('html', 'lang'), 'ja');
  assert.match(await page.textContent('#h-emergency'), /何から避難しますか/);
  await ctx.close();
});
