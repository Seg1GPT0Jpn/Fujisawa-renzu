import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extract, placeholders } from '../../scripts/i18n-extract.mjs';
import { pickLang, t, _setDict, LANGS } from '../../site/assets/js/i18n.js';

const LANG_CODES = Object.keys(LANGS).filter((l) => l !== 'ja');

test('辞書：すべてのキーが4言語にあり、余分なキーがない', async () => {
  const keys = await extract();
  assert.ok(keys.size > 300);
  for (const lang of LANG_CODES) {
    const dict = JSON.parse(await readFile(new URL(`../../site/assets/i18n/${lang}.json`, import.meta.url), 'utf8'));
    const missing = [...keys.keys()].filter((k) => typeof dict[k] !== 'string' || !dict[k].trim());
    const extra = Object.keys(dict).filter((k) => !keys.has(k));
    assert.deepEqual(missing, [], `${lang}: 不足`);
    assert.deepEqual(extra, [], `${lang}: 余分`);
  }
});

test('辞書：差し込み（{n} など）が日本語と一致し、HTML を含まない', async () => {
  const keys = await extract();
  for (const lang of LANG_CODES) {
    const dict = JSON.parse(await readFile(new URL(`../../site/assets/i18n/${lang}.json`, import.meta.url), 'utf8'));
    for (const [k, { ja }] of keys) {
      assert.deepEqual(placeholders(dict[k]), placeholders(ja), `${lang} ${k}`);
      assert.ok(!/<[a-z/][^>]*>/i.test(dict[k]), `${lang} ${k}: HTML`);
    }
  }
});

test('辞書：安全に関わる語が訳されている（数量・171など）', async () => {
  for (const lang of LANG_CODES) {
    const d = JSON.parse(await readFile(new URL(`../../site/assets/i18n/${lang}.json`, import.meta.url), 'utf8'));
    assert.match(`${d['checklist.item.water-3d']}${d['checklist.detail.water-3d']}`, /3/, `${lang}: 3日・3リットル`);
    assert.match(d['checklist.item.dial171'], /171/, lang);
    assert.match(d['card.route'], /Google|谷歌|구글/i, lang);
  }
});

test('言語の選び方：URL > 保存 > ブラウザ言語 > 日本語', () => {
  assert.equal(pickLang({ param: 'vi', saved: 'en', browser: ['ko-KR'] }), 'vi');
  assert.equal(pickLang({ param: 'xx', saved: 'en', browser: ['ko-KR'] }), 'en');
  assert.equal(pickLang({ browser: ['zh-CN', 'en'] }), 'zh');
  assert.equal(pickLang({ browser: ['fr-FR', 'ko'] }), 'ko');
  assert.equal(pickLang({ browser: ['fr-FR'] }), 'ja');
  assert.equal(pickLang({}), 'ja');
});

test('t()：辞書にないときは日本語、差し込みを置き換える', () => {
  _setDict('en', { 'a.b': 'about {n} m' });
  assert.equal(t('a.b', '約{n} m', { n: 120 }), 'about 120 m');
  assert.equal(t('x.y', '日本語'), '日本語');
  _setDict('ja', {});
  assert.equal(t('a.b', '約{n} m', { n: 5 }), '約5 m');
});
