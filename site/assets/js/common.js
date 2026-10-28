// 全ページ共通：オフライン表示・Service Worker 登録・データ取得の補助
export const SAVED_AT_HEADER = 'X-FL-Saved-At';

export function formatDateTimeJa(value) {
  if (!value) return '不明';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '不明';
  return d.toLocaleString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' });
}

export function formatDateJa(value) {
  if (!value) return '不明';
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00+09:00` : value);
  if (Number.isNaN(d.getTime())) return '不明';
  return d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Tokyo' });
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// JSON を取得する。Service Worker のキャッシュから返った場合は savedAt が入る。
export async function fetchJson(url, { timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return { data, savedAt: res.headers.get(SAVED_AT_HEADER) };
  } finally {
    clearTimeout(timer);
  }
}

function updateOfflineBanner() {
  const banner = document.getElementById('offline-banner');
  if (!banner) return;
  banner.hidden = navigator.onLine;
}

export function initCommon() {
  if (!document.getElementById('offline-banner')) {
    const b = el('div', { id: 'offline-banner', class: 'offline-banner', role: 'status' },
      'オフラインです。表示中の内容は端末に保存されたもので、最新の情報を確認できません。');
    b.hidden = true;
    document.body.prepend(b);
  }
  updateOfflineBanner();
  window.addEventListener('online', updateOfflineBanner);
  window.addEventListener('offline', updateOfflineBanner);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register(new URL('../../sw.js', import.meta.url), { scope: new URL('../../', import.meta.url).pathname })
      .catch(() => { /* 未対応・失敗時もサイトは通常どおり動作する */ });
  }
}

export function getConfig() {
  const c = (typeof window !== 'undefined' && window.FUJISAWA_LENS_CONFIG) || {};
  return {
    crowdingApiBase: typeof c.crowdingApiBase === 'string' ? c.crowdingApiBase.replace(/\/+$/, '') : '',
    crowdingApiLabel: typeof c.crowdingApiLabel === 'string' ? c.crowdingApiLabel : '',
  };
}

export const STALE_DAYS = 90;
export function daysSince(dateStr, now = Date.now()) {
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(dateStr ?? '') ? `${dateStr}T00:00:00+09:00` : dateStr);
  return Number.isNaN(t) ? null : Math.floor((now - t) / 86400000);
}
