// 多言語対応。日本語は HTML と JS に直接書いた文言をそのまま使い、
// それ以外の言語は assets/i18n/<lang>.json をその言語のときだけ読み込む（日本語の利用者には追加の通信なし）。
// 翻訳はふじさわレンズによるもので、公式情報は日本語。

export const LANGS = {
  ja: { name: '日本語', locale: 'ja-JP' },
  en: { name: 'English', locale: 'en-US' },
  zh: { name: '中文（简体）', locale: 'zh-CN' },
  ko: { name: '한국어', locale: 'ko-KR' },
  vi: { name: 'Tiếng Việt', locale: 'vi-VN' },
};
const STORAGE_KEY = 'fujisawa-lens-lang';

let lang = 'ja';
let dict = {};

export function pickLang({ param, saved, browser } = {}) {
  for (const c of [param, saved]) if (c && LANGS[c]) return c;
  for (const b of browser ?? []) {
    const base = String(b).toLowerCase().split('-')[0];
    if (LANGS[base]) return base;
  }
  return 'ja';
}

function storage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function getLang() { return lang; }
export function locale() { return LANGS[lang].locale; }

// 文言を返す。辞書にない場合は日本語の文言（第2引数）を使う。{name} を置き換える。
export function t(key, ja, vars) {
  const s = (lang !== 'ja' && typeof dict[key] === 'string') ? dict[key] : ja;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
}

export function has(key) { return lang === 'ja' || typeof dict[key] === 'string'; }

// テスト用
export function _setDict(l, d) { lang = l; dict = d ?? {}; }

// HTML の data-i18n（textContent）と data-i18n-attr（"属性:キー;属性:キー"）を置き換える
export function applyStatic(root = document) {
  if (lang === 'ja') return;
  for (const n of root.querySelectorAll('[data-i18n]')) {
    const v = dict[n.getAttribute('data-i18n')];
    if (typeof v === 'string') n.textContent = v;
  }
  for (const n of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of n.getAttribute('data-i18n-attr').split(';')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && typeof dict[key] === 'string') n.setAttribute(attr, dict[key]);
    }
  }
  const page = document.documentElement.dataset.page;
  if (page && typeof dict[`title.${page}`] === 'string') document.title = `${dict[`title.${page}`]} | Fujisawa Lens`;
}

function renderSwitcher() {
  const header = document.querySelector('header.site');
  if (!header || header.querySelector('.lang-switch')) return;
  const wrap = document.createElement('div');
  wrap.className = 'lang-switch';
  const label = document.createElement('label');
  label.setAttribute('for', 'lang-select');
  label.textContent = '言語 / Language';
  const sel = document.createElement('select');
  sel.id = 'lang-select';
  for (const [code, info] of Object.entries(LANGS)) {
    const o = document.createElement('option');
    o.value = code;
    o.textContent = info.name;
    o.lang = code;
    if (code === lang) o.selected = true;
    sel.append(o);
  }
  sel.addEventListener('change', () => {
    try { storage()?.setItem(STORAGE_KEY, sel.value); } catch { /* 保存できなくても URL で切り替える */ }
    const u = new URL(location.href);
    if (sel.value === 'ja') u.searchParams.delete('lang'); else u.searchParams.set('lang', sel.value);
    location.href = u.toString();
  });
  wrap.append(label, sel);
  header.append(wrap);
}

// 日本語以外のとき、翻訳である旨と公式の多言語情報への案内を表示する
function renderTranslationNote() {
  if (lang === 'ja') return;
  const main = document.querySelector('main');
  if (!main || main.querySelector('.i18n-note')) return;
  const p = document.createElement('p');
  p.className = 'i18n-note small';
  p.append(t('i18n.note', '（翻訳について）この翻訳はふじさわレンズによるもので、公式の情報は日本語です。'), ' ');
  const a = document.createElement('a');
  a.href = 'https://www.city.fujisawa.kanagawa.jp/jinkendanjyo/saigaitagengojoho.html';
  a.rel = 'noopener';
  a.textContent = t('i18n.officialLink', '藤沢市の多言語の災害情報');
  p.append(a);
  const only = document.documentElement.dataset.i18nJaOnly === 'true';
  if (only) {
    p.append(document.createElement('br'));
    const s = document.createElement('strong');
    s.textContent = t('i18n.jaOnly', 'このページの本文は日本語のみです。');
    p.append(s);
  }
  main.prepend(p);
}

// 内部リンクに言語を引き継ぐ（?lang=）。localStorage が使えない環境でも言語が保たれる
function keepLangInLinks() {
  if (lang === 'ja') return;
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (/^(https?:|mailto:|#|data:)/.test(href)) continue;
    const u = new URL(href, location.href);
    if (u.origin !== location.origin) continue;
    u.searchParams.set('lang', lang);
    a.setAttribute('href', `${u.pathname.split('/').pop() || './'}${u.search}${u.hash}`);
  }
}

async function init() {
  const params = new URLSearchParams(location.search);
  let saved = null;
  try { saved = storage()?.getItem(STORAGE_KEY); } catch { /* なし */ }
  lang = pickLang({ param: params.get('lang'), saved, browser: navigator.languages ?? [navigator.language] });
  if (params.get('lang') && LANGS[params.get('lang')]) {
    try { storage()?.setItem(STORAGE_KEY, lang); } catch { /* なし */ }
  }
  if (lang !== 'ja') {
    try {
      const res = await fetch(new URL(`../i18n/${lang}.json`, import.meta.url));
      if (!res.ok) throw new Error(String(res.status));
      dict = await res.json();
    } catch {
      // 辞書を読めない（オフラインで未保存など）ときは日本語で表示する
      lang = 'ja';
      dict = {};
    }
  }
  document.documentElement.lang = lang === 'zh' ? 'zh-Hans' : lang;
  applyStatic();
  renderSwitcher();
  renderTranslationNote();
  keepLangInLinks();
  return lang;
}

export const ready = typeof document !== 'undefined' ? init() : Promise.resolve('ja');
