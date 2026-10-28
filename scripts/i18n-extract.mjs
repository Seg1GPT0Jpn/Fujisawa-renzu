#!/usr/bin/env node
// 翻訳キーと日本語の原文を集める（辞書の作成・テストで使う）
//   node scripts/i18n-extract.mjs            # キー一覧を JSON で出力
//   node scripts/i18n-extract.mjs --missing  # 各言語の辞書に足りないキーを表示
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SITE = join(ROOT, 'site');

// 地区名のローマ字表記（藤沢市「災害の情報」多言語ページの英語表記）
export const DISTRICT_ROMAJI = {
  御所見: 'Goshomi', 長後: 'Chogo', 遠藤: 'Endo', 六会: 'Mutsuai', 湘南台: 'Shonandai', 湘南大庭: 'Shonan-Oba',
  善行: 'Zengyo', 明治: 'Meiji', 藤沢西部: 'Fujisawa (west)', 藤沢東部: 'Fujisawa (east)', 村岡: 'Muraoka',
  辻堂: 'Tsujido', 鵠沼: 'Kugenuma', 片瀬: 'Katase',
};

const unescape = (s) => s.replace(/\\'/g, "'").replace(/\\n/g, '\n');

export async function extract() {
  const keys = new Map();
  const add = (k, ja, where) => { if (!keys.has(k)) keys.set(k, { ja, where }); };

  // HTML
  for (const f of (await readdir(SITE)).filter((x) => x.endsWith('.html'))) {
    const html = await readFile(join(SITE, f), 'utf8');
    for (const m of html.matchAll(/<(\w+)([^>]*?)\sdata-i18n="([^"]+)"([^>]*)>([\s\S]*?)<\/\1>/g)) {
      add(m[3], m[5].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(), f);
    }
    for (const m of html.matchAll(/<[^>]*data-i18n-attr="([^"]+)"[^>]*>/g)) {
      for (const pair of m[1].split(';')) {
        const [attr, key] = pair.split(':').map((s) => s.trim());
        const v = m[0].match(new RegExp(`\\s${attr}="([^"]*)"`))?.[1] ?? '';
        add(key, v, f);
      }
    }
    const page = html.match(/<html[^>]*data-page="([^"]+)"/)?.[1];
    if (page) add(`title.${page}`, html.match(/<title>([^｜<]+)/)?.[1] ?? '', f);
  }

  // JS：t('key', '日本語') / tr('key', '日本語')
  const jsDir = join(SITE, 'assets/js');
  for (const f of (await readdir(jsDir)).filter((x) => x.endsWith('.js'))) {
    const js = await readFile(join(jsDir, f), 'utf8');
    for (const m of js.matchAll(/\btr?\(\s*'([a-zA-Z0-9_.]+)'\s*,\s*'((?:[^'\\]|\\.)*)'/g)) add(m[1], unescape(m[2]), f);
  }
  // i18n.js 自身の文言（日本語では表示しない）
  add('i18n.note', '（翻訳について）この翻訳はふじさわレンズによるもので、公式の情報は日本語です。', 'i18n.js');
  add('i18n.officialLink', '藤沢市の多言語の災害情報', 'i18n.js');
  add('i18n.jaOnly', 'このページの本文は日本語のみです。', 'i18n.js');

  // データ由来の動的キー
  const sh = JSON.parse(await readFile(join(SITE, 'data/shelters.json'), 'utf8'));
  for (const h of sh.hazards) add(`hazard.${h.key}`, h.label, 'shelters.json');
  for (const m of sh.missingHazards ?? []) {
    add(`hazard.${m.key}`, m.label, 'shelters.json');
    add(`shelters.missing.${m.key}`, m.reason, 'shelters.json');
    add(`shelters.missingLink.${m.key}`, `藤沢市「指定緊急避難場所（${m.label}）指定先一覧」（PDF）`, 'shelters.json');
  }
  for (const d of new Set(sh.facilities.map((f) => f.district).filter(Boolean))) add(`district.${d}`, d, 'shelters.json');
  for (const [k, ja] of Object.entries({ empty: '空いている', some: 'やや混雑', crowded: 'かなり混雑', unknown: 'わからない／確認できない' })) add(`level.${k}`, ja, 'crowding-client.js');
  const c = JSON.parse(await readFile(join(SITE, 'data/checklist.json'), 'utf8'));
  for (const s of [...c.sections, ...c.hazardSections, ...c.familySections]) {
    add(`checklist.section.${s.id}`, s.title, 'checklist.json');
    if (s.hint) add(`checklist.hint.${s.id}`, s.hint, 'checklist.json');
    for (const it of s.items) {
      add(`checklist.item.${it.id}`, it.text, 'checklist.json');
      if (it.detail) add(`checklist.detail.${it.id}`, it.detail, 'checklist.json');
      if (it.link) add(`checklist.link.${it.id}`, it.link.text, 'checklist.json');
    }
  }
  return keys;
}

export const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const keys = await extract();
  if (process.argv.includes('--missing')) {
    for (const lang of ['en', 'zh', 'ko', 'vi']) {
      let dict = {};
      try { dict = JSON.parse(await readFile(join(SITE, `assets/i18n/${lang}.json`), 'utf8')); } catch { /* なし */ }
      const missing = [...keys.keys()].filter((k) => typeof dict[k] !== 'string');
      const extra = Object.keys(dict).filter((k) => !keys.has(k));
      console.log(`${lang}: ${keys.size - missing.length}/${keys.size}  missing=${missing.length} extra=${extra.length}`);
      if (missing.length) console.log('  missing:', missing.slice(0, 50).join(', '));
      if (extra.length) console.log('  extra:', extra.join(', '));
    }
  } else {
    console.log(JSON.stringify(Object.fromEntries([...keys].map(([k, v]) => [k, v.ja])), null, 1));
  }
}
