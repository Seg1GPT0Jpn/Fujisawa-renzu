// 避難先データの正規化・照合・検証（ネットワークに依存しない純粋関数）
import { createHash } from 'node:crypto';

export const HAZARDS = [
  { key: 'flood', label: '洪水', gsiLayer: 'skhb01', gsiProp: 'disaster1' },
  { key: 'landslide', label: '崖崩れ、土石流及び地滑り', gsiLayer: 'skhb02', gsiProp: 'disaster2' },
  { key: 'storm_surge', label: '高潮', gsiLayer: 'skhb03', gsiProp: 'disaster3' },
  { key: 'earthquake', label: '地震', gsiLayer: 'skhb04', gsiProp: 'disaster4' },
  { key: 'tsunami', label: '津波', gsiLayer: 'skhb05', gsiProp: 'disaster5' },
  { key: 'large_fire', label: '大規模な火事', gsiLayer: 'skhb06', gsiProp: 'disaster6' },
  { key: 'inland_flood', label: '内水氾濫', gsiLayer: 'skhb07', gsiProp: 'disaster7' },
  { key: 'volcano', label: '火山現象', gsiLayer: 'skhb08', gsiProp: 'disaster8' },
];

export const CITY_NAME = '藤沢市';
export const ADDRESS_PREFIX = '神奈川県藤沢市';

export function nfkc(s) {
  return String(s ?? '').normalize('NFKC').trim();
}

export function normalizeAddress(s) {
  return nfkc(s)
    .replace(/\s/g, '')
    .replace(/^神奈川県/, '')
    .replace(/^藤沢市/, '')
    .replace(/[‐‑‒–—―ー−－]/g, '-')
    .replace(/丁目/g, '-')
    .replace(/番地?の?/g, '-')
    .replace(/号/g, '')
    .replace(/-+$/g, '')
    .replace(/他$/, '');
}

export function normalizeName(s) {
  return nfkc(s)
    .replace(/[（(]外部サイトへリンク[）)]/g, '')
    .replace(/[（(][^）)]*休止[^）)]*[）)]/g, '')
    .replace(/\s/g, '')
    .replace(/^藤沢市立/, '')
    .replace(/^神奈川県立/, '県立')
    .replace(/慶應/g, '慶応');
}

export function stableId(name, address) {
  const h = createHash('sha1').update(`${normalizeName(name)}|${normalizeAddress(address)}`).digest('hex');
  return `fjs-${h.slice(0, 10)}`;
}

function toNumber(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function validLatLon(lat, lon) {
  // 藤沢市周辺の範囲外は誤りとして扱う（市域外の値を使わない）
  return lat != null && lon != null && lat > 35.2 && lat < 35.5 && lon > 139.3 && lon < 139.6;
}

// 国土地理院 GeoJSON タイル群（features 配列の集合）から藤沢市分を統合
export function mergeGsiFeatures({ emergencyLayers, shelterLayer }) {
  const byKey = new Map();
  const problems = [];

  const upsert = (feature, kind) => {
    const p = feature?.properties ?? {};
    const name = nfkc(p.name);
    const address = nfkc(p.address);
    if (!address.startsWith(ADDRESS_PREFIX)) return; // 他市町村は混在させない
    if (!name) { problems.push(`名称のない地物: ${address}`); return; }
    const key = `${normalizeName(name)}|${normalizeAddress(address)}`;
    const coords = feature?.geometry?.type === 'Point' ? feature.geometry.coordinates : null;
    const lon = toNumber(coords?.[0]);
    const lat = toNumber(coords?.[1]);
    let rec = byKey.get(key);
    if (!rec) {
      rec = {
        id: stableId(name, address), name, address,
        latitude: null, longitude: null, coordinateSource: null,
        facilityTypes: [], supportedHazards: [], remarks: [],
      };
      byKey.set(key, rec);
    }
    if (validLatLon(lat, lon)) {
      if (rec.latitude == null) {
        rec.latitude = lat; rec.longitude = lon; rec.coordinateSource = 'gsi';
      }
    } else {
      problems.push(`座標が不正または範囲外のため座標なし扱い: ${name}（${address}）`);
    }
    if (kind === 'emergency') {
      if (!rec.facilityTypes.includes('指定緊急避難場所')) rec.facilityTypes.push('指定緊急避難場所');
      for (const h of HAZARDS) {
        if (Number(p[h.gsiProp]) === 1 && !rec.supportedHazards.includes(h.key)) rec.supportedHazards.push(h.key);
      }
    } else if (kind === 'shelter') {
      if (!rec.facilityTypes.includes('指定避難所')) rec.facilityTypes.push('指定避難所');
    }
    const remark = nfkc(p.remarks);
    if (remark && !rec.remarks.includes(remark)) rec.remarks.push(remark);
  };

  for (const layer of emergencyLayers) for (const f of layer?.features ?? []) upsert(f, 'emergency');
  for (const f of shelterLayer?.features ?? []) upsert(f, 'shelter');

  const facilities = [...byKey.values()];
  for (const f of facilities) {
    f.supportedHazards.sort((a, b) => HAZARDS.findIndex((h) => h.key === a) - HAZARDS.findIndex((h) => h.key === b));
  }
  facilities.sort((a, b) => a.address.localeCompare(b.address, 'ja') || a.name.localeCompare(b.name, 'ja'));
  return { facilities, problems };
}

// ---- 藤沢市ページ（照合専用。内容は再配布しない）----
function stripTags(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#64;/g, '@').replace(/\s+/g, ' ').trim();
}

// 列：名称, 所在地, [指定緊急避難場所の災害種別列（表により「高潮」列の有無が異なる）], 指定避難所, 福祉避難所
const CITY_SUBCOLUMNS = {
  地震: 'earthquake', 火山現象: 'volcano', 洪水・崖崩れ: 'floodOrLandslide',
  大規模火災: 'largeFire', 津波: 'tsunami', 高潮: 'stormSurge',
};

export function parseCityTable(html) {
  // 地区ごとの表は caption「○○地区 避難先一覧」を持つ（class 属性は表により異なる）
  const tables = [...html.matchAll(/<table[^>]*>\s*(<caption>[^<]*避難先一覧[^<]*<\/caption>[\s\S]*?)<\/table>/g)].map((m) => m[1]);
  const captionCount = (html.match(/<caption>[^<]*避難先一覧/g) ?? []).length;
  if (tables.length === 0) throw new Error('市ページに「避難先一覧」の表が見つかりません（レイアウト変更の可能性）');
  if (tables.length !== captionCount) throw new Error(`市ページの表の抽出数（${tables.length}）と見出し数（${captionCount}）が一致しません`);
  const rows = [];
  for (const t of tables) {
    const caption = stripTags(t.match(/<caption>([\s\S]*?)<\/caption>/)?.[1] ?? '');
    const district = caption.replace(/\s*避難先一覧.*$/, '').replace(/地区$/, '').trim();
    const trs = [...t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) =>
      [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => stripTags(c[1])));
    const [h1, h2] = trs;
    const h1Expected = ['名称', '所在地', '指定緊急避難場所', '指定避難所', '福祉避難所'];
    if (!h1 || h1.join('|') !== h1Expected.join('|')) throw new Error(`市ページ表の見出しが想定外です（${caption}）: ${h1?.join('|')}`);
    const sub = (h2 ?? []).map((c) => c.replace(/\s/g, ''));
    const subKeys = sub.map((c) => CITY_SUBCOLUMNS[c]);
    if (subKeys.length === 0 || subKeys.some((k) => !k)) throw new Error(`市ページ表の災害種別見出しが想定外です（${caption}）: ${sub.join('|')}`);
    const width = 2 + subKeys.length + 2;
    for (const cells of trs.slice(2)) {
      if (cells.length !== width) throw new Error(`市ページ表の列数が想定外です（${cells.length}列, 想定${width}列, ${caption}）`);
      const mark = (c) => /[〇○◯]/.test(c);
      const row = {
        district,
        name: normalizeName(cells[0]),
        suspendedOnCityPage: /休止/.test(cells[0]),
        address: cells[1],
        earthquake: false, volcano: false, floodOrLandslide: false, largeFire: false, tsunami: false,
        stormSurge: null, // 列がない表では不明
        shelter: mark(cells[2 + subKeys.length]),
        welfare: mark(cells[3 + subKeys.length]),
      };
      subKeys.forEach((k, i) => { row[k] = mark(cells[2 + i]); });
      rows.push(row);
    }
  }
  return rows;
}

export function parseCityUpdatedDate(html) {
  const m = html.match(/更新日[：:]\s*(\d{4})年(\d{1,2})月(\d{1,2})日/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
}

export function matchCityRow(row, facilities) {
  const addr = normalizeAddress(row.address);
  const sameAddr = facilities.filter((f) => normalizeAddress(f.address) === addr);
  // 「○○周辺」（大規模火災用の区域）と施設本体は同じ住所になりうるため区別する
  const isArea = (n) => /周辺/.test(n);
  const base = (n) => n.replace(/[(（].*$/, '').replace(/周辺$/, '');
  const nameOk = (f) => {
    const a = normalizeName(f.name); const b = row.name;
    if (isArea(a) !== isArea(b)) return false;
    return a === b || a.includes(b) || b.includes(a) || base(a) === base(b);
  };
  if (sameAddr.length === 1) return nameOk(sameAddr[0]) || !isArea(row.name) ? sameAddr[0] : null;
  if (sameAddr.length > 1) return sameAddr.find((f) => normalizeName(f.name) === row.name) ?? sameAddr.find(nameOk) ?? null;
  const byName = facilities.filter((f) => normalizeName(f.name) === row.name);
  return byName.length === 1 ? byName[0] : null;
}

// 市ページの表と国土地理院データの指定内容を比較する
export function crossCheckWithCity(facilities, cityRows) {
  const checked = new Map();
  const unmatchedCityRows = [];
  const suspendedOnCity = [];
  const cityStormSurge = [];
  const gsiHasStormSurge = facilities.some((f) => f.supportedHazards.includes('storm_surge'));
  for (const row of cityRows) {
    const f = matchCityRow(row, facilities);
    if (!f) { unmatchedCityRows.push(row); continue; }
    if (row.suspendedOnCityPage) suspendedOnCity.push(f);
    const has = (k) => f.supportedHazards.includes(k);
    const mismatches = [];
    const cmp = (label, city, gsi) => { if (city !== gsi) mismatches.push(`${label}（市:${city ? '〇' : '－'} / 国土地理院:${gsi ? '〇' : '－'}）`); };
    cmp('地震', row.earthquake, has('earthquake'));
    cmp('火山現象', row.volcano, has('volcano'));
    cmp('洪水・崖崩れ', row.floodOrLandslide, has('flood') || has('landslide'));
    cmp('大規模火災', row.largeFire, has('large_fire'));
    cmp('津波', row.tsunami, has('tsunami'));
    // 高潮：国土地理院データに藤沢市の高潮指定が登録されていない場合は施設ごとの不一致にせず、全体の注意として扱う
    if (row.stormSurge !== null && gsiHasStormSurge) cmp('高潮', row.stormSurge, has('storm_surge'));
    if (row.stormSurge) cityStormSurge.push(row.name);
    cmp('指定避難所', row.shelter, f.facilityTypes.includes('指定避難所'));
    const prev = checked.get(f.id);
    if (prev) prev.mismatches.push(...mismatches);
    else checked.set(f.id, { status: mismatches.length ? 'mismatch' : 'match', mismatches, district: row.district, welfare: row.welfare });
    if (mismatches.length) checked.get(f.id).status = 'mismatch';
  }
  for (const f of facilities) {
    const c = checked.get(f.id);
    if (c) {
      f.district = c.district || null;
      f.cityPageCheck = { status: c.status, mismatches: c.mismatches };
    } else {
      f.district = null;
      f.cityPageCheck = { status: 'not_listed', mismatches: [] };
    }
  }
  return { unmatchedCityRows, suspendedOnCity, cityStormSurge, gsiHasStormSurge };
}

// 手作業で管理する公式告知（休止など）を適用する
export function applyNotices(facilities, notices) {
  const unused = [];
  for (const n of notices ?? []) {
    const target = facilities.filter((f) => normalizeName(f.name).includes(normalizeName(n.nameIncludes)));
    if (target.length === 0) unused.push(n);
    for (const f of target) f.notice = { type: n.type, text: n.text, since: n.since ?? null, sourceUrl: n.sourceUrl };
  }
  return { unused };
}

// 公開前検証。エラーがあれば公開しない（古いデータを最新として出さない）。
export function validateShelterData(data, { minFacilities = 50 } = {}) {
  const errors = [];
  const warnings = [];
  if (!data || !Array.isArray(data.facilities)) return { errors: ['facilities 配列がありません'], warnings };
  const ids = new Set();
  const hazardKeys = new Set(HAZARDS.map((h) => h.key));
  if (data.facilities.length < minFacilities) errors.push(`施設数が少なすぎます（${data.facilities.length}件）。取得失敗の可能性があります`);
  for (const f of data.facilities) {
    if (!f.id || typeof f.id !== 'string') errors.push(`id がありません: ${f.name}`);
    else if (ids.has(f.id)) errors.push(`重複 id: ${f.id}（${f.name}）`);
    ids.add(f.id);
    if (!f.name) errors.push(`名称がありません: ${f.id}`);
    if (!String(f.address ?? '').startsWith(ADDRESS_PREFIX)) errors.push(`藤沢市以外の住所: ${f.name} ${f.address}`);
    if ((f.latitude == null) !== (f.longitude == null)) errors.push(`緯度経度の片方のみ: ${f.name}`);
    if (f.latitude != null && !validLatLon(f.latitude, f.longitude)) errors.push(`座標が範囲外: ${f.name}`);
    if (f.latitude == null) warnings.push(`座標なし: ${f.name}`);
    for (const h of f.supportedHazards ?? []) if (!hazardKeys.has(h)) errors.push(`未知の災害種別 ${h}: ${f.name}`);
    if ((f.supportedHazards ?? []).length && !(f.facilityTypes ?? []).includes('指定緊急避難場所')) {
      errors.push(`災害種別があるのに指定緊急避難場所でない: ${f.name}`);
    }
    if (!f.sourceUrl) errors.push(`出典URLがありません: ${f.name}`);
  }
  return { errors, warnings };
}
