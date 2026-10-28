// 距離計算・避難先の絞り込み（ブラウザとテストで共用する純粋関数のみ）
import { t } from './i18n.js';
// 位置情報はこのモジュールの外に出さない。サーバーへの送信処理は一切持たない。

const EARTH_RADIUS_M = 6371008.8;

export function isValidCoordinate(lat, lon) {
  return typeof lat === 'number' && typeof lon === 'number' &&
    Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 &&
    !(lat === 0 && lon === 0);
}

// 2点間の大円距離（メートル）。道路距離ではない。
export function haversineMeters(lat1, lon1, lat2, lon2) {
  if (!isValidCoordinate(lat1, lon1) || !isValidCoordinate(lat2, lon2)) return null;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function formatDistance(m) {
  if (m == null || !Number.isFinite(m)) return t('geo.unknownDistance', '距離不明');
  if (m < 1000) return t('geo.aboutM', '約{n} m', { n: Math.round(m / 10) * 10 });
  return t('geo.aboutKm', '約{n} km', { n: (m / 1000).toFixed(1) });
}

// 災害種別で絞り込む。hazard が null のときは「指定避難所（滞在用）」を返す。
// 休止告知のある施設は除外する。
export function filterFacilities(facilities, { hazard = null, mode = 'emergency' } = {}) {
  if (!Array.isArray(facilities)) return [];
  return facilities.filter((f) => {
    if (!f || typeof f !== 'object') return false;
    if (f.notice && f.notice.type === 'suspended') return false;
    if (mode === 'shelter') {
      return Array.isArray(f.facilityTypes) && f.facilityTypes.includes('指定避難所') &&
        !(Array.isArray(f.excludedTypes) && f.excludedTypes.includes('指定避難所'));
    }
    if (!hazard) return false;
    // 公式一覧との照合で確認できなかった種別（excludedHazards）は推奨しない
    if (Array.isArray(f.excludedHazards) && f.excludedHazards.includes(hazard)) return false;
    return Array.isArray(f.facilityTypes) && f.facilityTypes.includes('指定緊急避難場所') &&
      Array.isArray(f.supportedHazards) && f.supportedHazards.includes(hazard);
  });
}

// 市の一覧のみで指定が確認できる施設（推奨はしない。名前と公式一覧への案内だけに使う）
export function cityOnlyFacilities(facilities, hazard) {
  if (!Array.isArray(facilities) || !hazard) return [];
  return facilities.filter((f) => f && !(f.notice && f.notice.type === 'suspended') &&
    Array.isArray(f.cityOnlyHazards) && f.cityOnlyHazards.some((c) => c.hazards.includes(hazard)));
}

// 近い順に並べる。座標のない施設は距離計算に使わず、別リストとして返す。
export function sortByDistance(facilities, origin) {
  const withDistance = [];
  const noCoordinates = [];
  for (const f of facilities) {
    const d = origin ? haversineMeters(origin.latitude, origin.longitude, f.latitude, f.longitude) : null;
    if (d == null) noCoordinates.push(f);
    else withDistance.push({ facility: f, distanceM: d });
  }
  withDistance.sort((a, b) => a.distanceM - b.distanceM);
  return { withDistance, noCoordinates };
}

// 手動検索（施設名・住所・地区名の部分一致）。外部ジオコーディングは使わない。
export function normalizeForSearch(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/[\s　]/g, '')
    .replace(/[‐‑‒–—―ー−-]/g, '-')
    .toLowerCase();
}

export function searchFacilities(facilities, query) {
  const q = normalizeForSearch(query);
  if (!q) return [];
  return facilities.filter((f) =>
    normalizeForSearch(`${f.name}|${f.address}|${f.district ?? ''}`).includes(q));
}

// 公式 Google Maps URLs（APIキー不要）。現在地は付加しない。
export function googleMapsSearchUrl(f) {
  const params = new URLSearchParams({ api: '1' });
  if (isValidCoordinate(f.latitude, f.longitude)) params.set('query', `${f.latitude},${f.longitude}`);
  else params.set('query', `${f.name} ${f.address}`);
  return `https://www.google.com/maps/search/?${params}`;
}

// 経路：origin を指定しないと、Google Maps 側が利用者の端末で現在地を使う（当サイトからは送らない）。
export function googleMapsDirectionsUrl(f) {
  const params = new URLSearchParams({ api: '1', travelmode: 'walking' });
  if (isValidCoordinate(f.latitude, f.longitude)) params.set('destination', `${f.latitude},${f.longitude}`);
  else params.set('destination', `${f.name} ${f.address}`);
  return `https://www.google.com/maps/dir/?${params}`;
}

export function hoursSince(isoString, now = Date.now()) {
  const t = Date.parse(isoString);
  if (Number.isNaN(t)) return null;
  return (now - t) / 3600000;
}
