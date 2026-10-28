#!/usr/bin/env node
// 通信量の計測：実際にブラウザ（Playwright/Chromium）で各ページを開き、発生したリクエストを記録する。
// 各ファイルの非圧縮サイズと gzip(-9) 圧縮後サイズ（静的ホスティングの圧縮配信の目安）を集計する。
// Service Worker の事前キャッシュによる追加取得は、初回表示とは別に集計する。
//   node scripts/measure-size.mjs            # 表を表示
//   node scripts/measure-size.mjs --markdown # README 貼り付け用
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from './dev-server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = new URL('..', import.meta.url).pathname;
const PAGES = ['index.html', 'shelters.html', 'crowding.html', 'environment.html', 'prepare.html', 'sources.html', 'privacy.html'];
const MD = process.argv.includes('--markdown');

async function sizes(pathname) {
  const p = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
  const buf = await readFile(join(ROOT, 'site', decodeURIComponent(p)));
  return { raw: buf.length, gz: gzipSync(buf, { level: 9 }).length };
}

const server = await startServer({ port: 0, quiet: true });
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
const rows = [];
const external = [];
try {
  for (const page of PAGES) {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    const tab = await ctx.newPage();
    const urls = new Set();
    tab.on('request', (r) => {
      const u = new URL(r.url());
      if (u.origin === new URL(base).origin) urls.add(u.pathname);
      else if (!u.protocol.startsWith('data')) external.push(`${page}: ${r.url()}`);
    });
    await tab.goto(base + page, { waitUntil: 'networkidle' });
    let raw = 0; let gz = 0;
    const files = [];
    for (const u of urls) {
      const s = await sizes(u);
      raw += s.raw; gz += s.gz; files.push(`${u} ${s.raw}/${s.gz}`);
    }
    rows.push({ page, requests: urls.size, raw, gz, files });
    await ctx.close();
  }
  // Service Worker 事前キャッシュの追加取得量
  const swSrc = await readFile(join(ROOT, 'site/sw.js'), 'utf8');
  const list = JSON.parse(swSrc.match(/const PRECACHE = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"').replace(/,\s*]/, ']'));
  let swRaw = 0; let swGz = 0;
  for (const p of list) { const s = await sizes(`/${p === './' ? '' : p}`); swRaw += s.raw; swGz += s.gz; }
  rows.push({ page: '（SW事前キャッシュ全体）', requests: list.length, raw: swRaw, gz: swGz, files: [] });
} finally {
  await browser.close();
  server.close();
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
if (MD) {
  console.log('| ページ | リクエスト数 | 非圧縮 | gzip後（目安） |');
  console.log('|---|---:|---:|---:|');
  for (const r of rows) console.log(`| ${r.page} | ${r.requests} | ${kb(r.raw)} | ${kb(r.gz)} |`);
} else {
  for (const r of rows) {
    console.log(`${r.page.padEnd(20)} req=${String(r.requests).padStart(2)} raw=${kb(r.raw).padStart(9)} gzip=${kb(r.gz).padStart(9)}`);
    for (const f of r.files) console.log(`    ${f}`);
  }
}
console.log(external.length ? `\n外部リクエスト:\n${external.join('\n')}` : '\n外部リクエスト: なし');
const over = rows.filter((r) => !r.page.startsWith('（') && r.gz > 150 * 1024);
if (over.length) { console.error(`目標（gzip後150KB）超過: ${over.map((r) => r.page).join(', ')}`); process.exitCode = 1; }
