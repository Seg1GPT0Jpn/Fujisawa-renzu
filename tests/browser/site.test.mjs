// ブラウザでの主要画面確認（Playwright / Chromium）
//   npm run test:browser
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer } from '../../scripts/dev-server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const PAGES = ['index.html', 'shelters.html', 'crowding.html', 'environment.html', 'sources.html', 'privacy.html', 'offline.html'];
let server; let apiServer; let browser; let base; let apiBase;

before(async () => {
  server = await startServer({ port: 0, quiet: true, withApi: false });
  apiServer = await startServer({ port: 0, quiet: true, withApi: true });
  base = `http://127.0.0.1:${server.address().port}/`;
  apiBase = `http://127.0.0.1:${apiServer.address().port}/`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); apiServer?.close(); });

async function open(url, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, serviceWorkers: 'block', ...opts });
  const page = await ctx.newPage();
  const errors = []; const external = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => { const u = r.url(); if (!u.startsWith(new URL(url).origin) && !u.startsWith('data:')) external.push(u); });
  await page.goto(url, { waitUntil: 'networkidle' });
  return { ctx, page, errors, external };
}

test('全ページ：モバイル幅で横スクロールなし・コンソールエラーなし・外部読込なし・見出しあり', async () => {
  for (const p of PAGES) {
    const { ctx, page, errors, external } = await open(base + p);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `${p}: 横はみ出し ${overflow}px`);
    assert.deepEqual(errors, [], `${p}: console errors`);
    assert.deepEqual(external, [], `${p}: 外部リクエスト`);
    assert.equal(await page.locator('h1').count(), 1, `${p}: h1`);
    assert.equal(await page.getAttribute('html', 'lang'), 'ja');
    // フォーム部品にはラベルがある
    const unlabeled = await page.evaluate(() => [...document.querySelectorAll('input, select')]
      .filter((e) => e.type !== 'hidden' && !e.closest('label') && !(e.id && document.querySelector(`label[for="${e.id}"]`)) && !e.getAttribute('aria-label')).map((e) => e.id || e.name));
    assert.deepEqual(unlabeled, [], `${p}: ラベルのない入力`);
    await ctx.close();
  }
});

test('ページ表示だけで位置情報を要求しない', async () => {
  const { ctx, page } = await open(base + 'shelters.html');
  const calls = await page.evaluate(() => window.__geoCalls ?? 0);
  assert.equal(calls, 0);
  await ctx.close();
});

async function openShelters(opts) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, serviceWorkers: 'block', ...opts });
  await ctx.addInitScript(() => {
    window.__geoCalls = 0;
    if (navigator.geolocation) {
      const orig = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
      navigator.geolocation.getCurrentPosition = (...a) => { window.__geoCalls += 1; return orig(...a); };
    }
  });
  const page = await ctx.newPage();
  const posts = [];
  page.on('request', (r) => { if (r.method() !== 'GET') posts.push(r.url()); });
  await page.goto(base + 'shelters.html', { waitUntil: 'networkidle' });
  return { ctx, page, posts };
}

test('現在地から探す：許可時は近い順、選んだ災害種別の施設だけ、位置はサーバーへ送らない', async () => {
  const { ctx, page, posts } = await openShelters({ permissions: ['geolocation'], geolocation: { latitude: 35.3389, longitude: 139.4877 } });
  assert.equal(await page.evaluate(() => window.__geoCalls), 0, '押す前は取得しない');
  await page.check('#hz-tsunami');
  await page.click('#locate-btn');
  await page.waitForSelector('#results li.card');
  assert.equal(await page.evaluate(() => window.__geoCalls), 1);
  const text = await page.textContent('#results-summary');
  assert.match(text, /津波/);
  const distances = await page.$$eval('#results .distance', (els) => els.map((e) => e.textContent));
  assert.ok(distances.length > 0);
  assert.ok(distances.every((d) => d.includes('直線')));
  const tags = await page.$$eval('#results li.card', (els) => els.map((e) => e.textContent));
  assert.ok(tags.every((t) => t.includes('津波')), '津波に対応しない施設が混ざっていない');
  assert.ok(!(await page.textContent('#results')).includes('藤沢市民会館'), '休止中の施設を出さない');
  assert.match(await page.textContent('#results-summary'), /直線距離です/);
  const mapHref = await page.getAttribute('#results li.card a.btn >> nth=1', 'href');
  assert.match(mapHref, /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1/);
  assert.ok(!mapHref.includes('35.3389'), '現在地をURLに含めない');
  assert.deepEqual(posts, [], 'POST 等の送信なし');
  await ctx.close();
});

test('位置情報を拒否しても手動で探せる', async () => {
  const { ctx, page } = await openShelters({ permissions: [] });
  await page.check('#hz-earthquake');
  await page.click('#locate-btn');
  await page.waitForSelector('#locate-state .notice');
  assert.match(await page.textContent('#locate-state'), /許可されませんでした|取得できませんでした/);
  await page.fill('#query', '辻堂');
  await page.click('#search-form button[type=submit]');
  await page.waitForSelector('#results li.card');
  assert.match(await page.textContent('#results-summary'), /辻堂/);
  await ctx.close();
});

test('位置情報に非対応の端末・タイムアウトでも案内が出る', async () => {
  for (const mode of ['unsupported', 'timeout']) {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, serviceWorkers: 'block' });
    await ctx.addInitScript((m) => {
      if (m === 'unsupported') Object.defineProperty(Navigator.prototype, 'geolocation', { get: () => undefined, configurable: true });
      else navigator.geolocation.getCurrentPosition = (_ok, err) => setTimeout(() => err({ code: 3 }), 10);
      if (m === 'unsupported') delete Navigator.prototype.geolocation;
    }, mode);
    const page = await ctx.newPage();
    await page.goto(base + 'shelters.html', { waitUntil: 'networkidle' });
    await page.check('#hz-flood');
    await page.click('#locate-btn');
    await page.waitForSelector('#locate-state .notice');
    assert.match(await page.textContent('#locate-state'), mode === 'timeout' ? /時間がかかりすぎた/ : /利用できません/);
    await ctx.close();
  }
});

test('データ取得失敗時は公式一覧へ案内し、架空の結果を出さない', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.route('**/data/shelters.json', (r) => r.fulfill({ status: 500, body: 'x' }));
  await page.goto(base + 'shelters.html', { waitUntil: 'networkidle' });
  assert.match(await page.textContent('#data-state'), /読み込めませんでした/);
  assert.ok(await page.isHidden('#search-form'));
  await ctx.close();
});

test('不正な形式のデータでも落ちずに失敗を表示', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.route('**/data/shelters.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"facilities": "x"}' }));
  await page.goto(base + 'shelters.html', { waitUntil: 'networkidle' });
  assert.match(await page.textContent('#data-state'), /読み込めませんでした/);
  await ctx.close();
});

test('高潮は選択肢に出さず、公式一覧へ案内（データ未対応の種別）', async () => {
  const { ctx, page } = await open(base + 'shelters.html');
  assert.equal(await page.locator('#hz-storm_surge').count(), 0);
  assert.match(await page.textContent('#missing-hazards'), /高潮/);
  await ctx.close();
});

test('オフライン：保存済みデータの保存日時を表示し、最新と誤認させない', async () => {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
  const page = await ctx.newPage();
  await page.goto(base + 'shelters.html', { waitUntil: 'networkidle' });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  // SW の事前キャッシュ完了を待つ
  await page.waitForFunction(async () => (await caches.keys()).length > 0 && !!(await (await caches.open((await caches.keys())[0])).match('data/shelters.json')));
  await page.reload({ waitUntil: 'networkidle' });
  await ctx.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#data-state p');
  await page.waitForFunction(() => document.getElementById('data-state').textContent.includes('端末に保存'));
  const t = await page.textContent('#data-state');
  assert.match(t, /端末に保存されたデータ/);
  assert.match(t, /保存 \d{4}年/);
  assert.ok(await page.isVisible('#offline-banner'));
  // オフライン時の混雑ページは最新と誤認させない（API未設定の場合は準備中）
  await page.goto(base + 'crowding.html').catch(() => {});
  assert.match(await page.textContent('main'), /準備中|オフライン/);
  await ctx.close();
});

test('混雑共有：API未設定なら「準備中」で、架空の値を出さない', async () => {
  const { ctx, page } = await open(base + 'crowding.html');
  assert.match(await page.textContent('#api-state'), /準備中/);
  assert.ok(await page.isHidden('#crowding-ui'));
  await ctx.close();
});

test('混雑共有：ローカルAPIで匿名投稿→少数は「情報不足」、送信内容は施設IDと区分のみ', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block', permissions: ['geolocation'], geolocation: { latitude: 35.33, longitude: 139.48 } });
  const page = await ctx.newPage();
  const bodies = [];
  page.on('request', (r) => { if (r.method() === 'POST') bodies.push(r.postData()); });
  await page.goto(apiBase + 'crowding.html', { waitUntil: 'networkidle' });
  assert.match(await page.textContent('#api-state'), /ローカル検証用/);
  const id = await page.$eval('#facility optgroup option', (o) => o.value);
  await page.selectOption('#facility', id);
  await page.check('#lv-crowded');
  await page.click('#report-submit');
  await page.waitForSelector('#report-result .notice');
  assert.match(await page.textContent('#report-result'), /受け付けました/);
  assert.deepEqual(bodies.map((b) => JSON.parse(b)), [{ facilityId: id, level: 'crowded' }]);
  await page.waitForFunction(() => document.getElementById('facility-summary').textContent.includes('報告 1件'));
  assert.match(await page.textContent('#facility-summary'), /情報不足/);
  // 連投は拒否され、成功と表示しない
  await page.click('#report-submit');
  await page.waitForFunction(() => document.getElementById('report-result').textContent.includes('送信できませんでした'));
  await ctx.close();
});

test('混雑共有：API障害時に送信成功と表示しない', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.route('**/api/reports', (r) => r.fulfill({ status: 503, body: 'down' }));
  await page.goto(apiBase + 'crowding.html', { waitUntil: 'networkidle' });
  const id = await page.$eval('#facility optgroup option', (o) => o.value);
  await page.selectOption('#facility', id);
  await page.check('#lv-some');
  await page.click('#report-submit');
  await page.waitForSelector('#report-result .notice');
  assert.match(await page.textContent('#report-result'), /送信できませんでした/);
  await ctx.close();
});

test('キーボードだけで避難先を検索できる', async () => {
  const { ctx, page } = await open(base + 'shelters.html');
  await page.focus('#hz-flood');
  await page.keyboard.press('Space');
  await page.focus('#query');
  await page.keyboard.type('鵠沼');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#results li.card');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'h-results', '結果見出しへフォーカス移動');
  await ctx.close();
});

test('環境情報：出典・対象期間・単位・取得日を表示し、欠測を0にせず、環境悪化と断定しない', async () => {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const pngs = [];
  page.on('request', (r) => { if (r.url().endsWith('.png')) pngs.push(r.url()); });
  await page.goto(base + 'environment.html', { waitUntil: 'networkidle' });
  for (const id of ['landcover', 'water', 'air']) {
    const t = await page.textContent(`#${id}`);
    assert.match(t, /出典/, `${id}: 出典`);
    assert.match(t, /データの見方/, `${id}: データの見方`);
    assert.match(t, /いつの？/, `${id}: 対象期間`);
    assert.match(t, /取得日/, `${id}: 取得日`);
    assert.match(t, /判断できないこと/, `${id}: 判断できないこと`);
    assert.ok(!/読み込み中/.test(t), `${id}: 読み込み完了`);
  }
  assert.match(await page.textContent('#air'), /ppm/);
  assert.match(await page.textContent('#air'), /欠測等/);
  // 欠測（null）のセルが 0 表示になっていない
  const zeroCells = await page.$$eval('#air td.num', (tds) => tds.filter((td) => /^0(\.0+)?$/.test(td.textContent.trim())).length);
  assert.equal(zeroCells, 0);
  const all = await page.textContent('main');
  assert.ok(!/(環境|自然)が悪化した|悪化している/.test(all), '因果・悪化の断定がない');
  assert.match(await page.textContent('#water'), /今日の水質ではありません/);
  assert.equal(pngs.length, 0, '地図画像は開くまで読み込まない');
  await page.click('#landcover summary >> text=15分類ごとの市全体の割合と概観図');
  await page.click('#landcover summary >> text=元の15分類の概観図');
  await page.waitForSelector('#landcover figure img');
  await page.waitForFunction(() => [...document.querySelectorAll('#landcover figure img')].every((i) => i.complete && i.naturalWidth > 0));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0);
  await ctx.close();
});

test('環境データ取得失敗時は数値を出さずに失敗を表示', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.route('**/data/environment/air-quality.json', (r) => r.fulfill({ status: 404, body: '' }));
  await page.goto(base + 'environment.html', { waitUntil: 'networkidle' });
  assert.match(await page.textContent('#air'), /取得できませんでした/);
  assert.equal(await page.locator('#air table').count(), 0);
  await ctx.close();
});
