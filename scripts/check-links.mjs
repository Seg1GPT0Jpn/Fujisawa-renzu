#!/usr/bin/env node
// リンク確認：site/*.html の内部リンク（ファイルの存在）と、外部リンク・データ内の出典URL（HTTP応答）を確認する。
//   NODE_USE_ENV_PROXY=1 node scripts/check-links.mjs [--internal-only]
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const SITE = new URL('../site/', import.meta.url).pathname;
const INTERNAL_ONLY = process.argv.includes('--internal-only');
const external = new Map();
const problems = [];

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p)); else out.push(p);
  }
  return out;
}

for (const file of await walk(SITE)) {
  const rel = file.slice(SITE.length);
  if (!/\.(html|json)$/.test(file)) continue;
  const text = await readFile(file, 'utf8');
  const urls = file.endsWith('.html')
    ? [...text.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'))
    : [...text.matchAll(/"(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  for (const u of urls) {
    if (u.startsWith('data:') || u.startsWith('#') || u.startsWith('mailto:')) continue;
    if (/^https?:\/\//.test(u)) {
      if (!external.has(u)) external.set(u, []);
      external.get(u).push(rel);
    } else {
      const target = join(SITE, rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '', u.split('#')[0].split('?')[0]);
      const s = await stat(target.endsWith('/') ? join(target, 'index.html') : target).catch(() => null);
      if (!s) problems.push(`内部リンク切れ: ${rel} → ${u}`);
    }
  }
}

if (!INTERNAL_ONLY) {
  for (const [u, from] of external) {
    if (u.includes('<') || u.includes('example')) continue;
    try {
      let res = await fetch(u, { method: 'HEAD', redirect: 'follow' });
      if (res.status === 405 || res.status === 403 || res.status === 501) res = await fetch(u, { redirect: 'follow' });
      const line = `${res.status} ${u}`;
      if (res.status >= 400) problems.push(`外部リンク異常 ${line}（${from[0]}）`); else console.log(line);
    } catch (e) {
      problems.push(`外部リンク取得失敗 ${u}（${from[0]}）: ${e.cause?.code ?? e.message}`);
    }
  }
}
console.log(`\n確認した外部URL: ${INTERNAL_ONLY ? '（省略）' : external.size}`);
if (problems.length) { console.log(problems.join('\n')); process.exitCode = 1; } else console.log('問題なし');
