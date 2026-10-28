// ふじさわレンズ Service Worker
// 目的：オフライン時に、避難先の基本データ・出典一覧・ページを参照できるようにする（PWAのインストール案内はしない）。
// 方針：同一オリジンの GET のみ扱う。常にネットワークを優先し、失敗・タイムアウト時だけ保存済みの内容を返す。
//       保存済みの JSON を返すときは X-FL-Saved-At ヘッダで保存日時を伝え、画面で「最新ではない」ことを示す。
//       混雑共有API（別オリジン）は一切キャッシュしない。
const CACHE = 'fujisawa-lens-v1';
const SAVED_AT = 'X-FL-Saved-At';
const NETWORK_TIMEOUT_MS = 5000;

// 初回訪問時に保存するもの（避難に必要な最小限。環境データは閲覧時に保存）
const PRECACHE = [
  './', 'index.html', 'shelters.html', 'crowding.html', 'sources.html', 'privacy.html', 'offline.html',
  'config.js', 'assets/css/style.css',
  'assets/js/common.js', 'assets/js/common-init.js', 'assets/js/geo.js', 'assets/js/home.js', 'assets/js/shelters.js',
  'assets/js/crowding.js', 'assets/js/crowding-client.js',
  'data/shelters.json', 'data/status.json',
];

async function putWithTimestamp(cache, request, response) {
  const body = await response.clone().blob();
  const headers = new Headers(response.headers);
  headers.set(SAVED_AT, new Date().toISOString());
  await cache.put(request, new Response(body, { status: response.status, statusText: response.statusText, headers }));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const path of PRECACHE) {
      try {
        const req = new Request(new URL(path, self.registration.scope), { cache: 'no-cache' });
        const res = await fetch(req);
        if (res.ok) await putWithTimestamp(cache, req, res);
      } catch { /* 1件の失敗でインストール全体を止めない */ }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外部（API・地図など）には関与しない

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await Promise.race([fetch(req), timeout(NETWORK_TIMEOUT_MS)]);
      if (res.ok && res.type === 'basic') putWithTimestamp(cache, req, res.clone()).catch(() => {});
      return res;
    } catch {
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const offline = await cache.match(new URL('offline.html', self.registration.scope));
        if (offline) return offline;
      }
      return new Response('オフラインで、保存された内容もありません。', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
