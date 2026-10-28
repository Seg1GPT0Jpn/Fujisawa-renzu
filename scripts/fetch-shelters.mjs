#!/usr/bin/env node
// 避難先データの取込：国土地理院の指定緊急避難場所・指定一般避難所タイルから藤沢市分を抽出し、
// 藤沢市公式ページの一覧と照合して site/data/shelters.json を生成する。
//
//   node scripts/fetch-shelters.mjs            # 取得→検証→書き出し
//   node scripts/fetch-shelters.mjs --dry-run  # 書き出さずに差分と検証結果だけ表示
//
// プロキシ環境では NODE_USE_ENV_PROXY=1 を付けて実行する。
// 検証エラー時は既存の shelters.json を上書きしない（古いデータを最新として公開しないため）。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HAZARDS, mergeGsiFeatures, parseCityTable, parseCityUpdatedDate,
  crossCheckWithCity, applyNotices, validateShelterData,
} from './lib/shelters-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'site/data/shelters.json');
const REPORT = join(ROOT, 'reports/shelters-check.md');
const CACHE = join(ROOT, '.cache/shelters');
const DRY = process.argv.includes('--dry-run');

// 藤沢市域を覆う z10 タイル（x=908, y=404）。市域外の地物は住所で除外する。
const TILES = [[10, 908, 404]];
const GSI_BASE = 'https://cyberjapandata.gsi.go.jp/xyz';
const CITY_URL = 'https://www.city.fujisawa.kanagawa.jp/kikikanri/bosai/siteihinannjyo.html';
const GSI_INFO_URL = 'https://www.gsi.go.jp/bousaichiri/hinanbasho.html';
const GSI_TERMS_URL = 'https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html';
const GSI_DISCLAIMER_URL = 'https://www.gsi.go.jp/bousaichiri/hinanbasho-menseki.html';

async function get(url, as = 'text') {
  const res = await fetch(url, { headers: { 'User-Agent': 'fujisawa-lens-data-update (static site maintenance)' } });
  if (!res.ok) throw new Error(`取得失敗 ${res.status}: ${url}`);
  const body = as === 'json' ? await res.json() : await res.text();
  await mkdir(CACHE, { recursive: true });
  await writeFile(join(CACHE, url.replace(/[^a-z0-9]+/gi, '_').slice(-120)), as === 'json' ? JSON.stringify(body) : body);
  return body;
}

async function fetchLayer(layer) {
  const features = [];
  for (const [z, x, y] of TILES) {
    const g = await get(`${GSI_BASE}/${layer}/${z}/${x}/${y}.geojson`, 'json');
    if (g?.type !== 'FeatureCollection' || !Array.isArray(g.features)) throw new Error(`想定外の形式: ${layer}`);
    features.push(...g.features);
  }
  return { features };
}

function diff(prev, next) {
  if (!prev) return ['（前回データなし）'];
  const lines = [];
  const p = new Map(prev.facilities.map((f) => [f.id, f]));
  const n = new Map(next.facilities.map((f) => [f.id, f]));
  for (const [id, f] of n) if (!p.has(id)) lines.push(`+ 追加: ${f.name}（${f.address}）`);
  for (const [id, f] of p) if (!n.has(id)) lines.push(`- 削除: ${f.name}（${f.address}）`);
  for (const [id, f] of n) {
    const o = p.get(id);
    if (!o) continue;
    const a = JSON.stringify([o.supportedHazards, o.facilityTypes, o.latitude, o.longitude, o.notice ?? null]);
    const b = JSON.stringify([f.supportedHazards, f.facilityTypes, f.latitude, f.longitude, f.notice ?? null]);
    if (a !== b) lines.push(`~ 変更: ${f.name}: ${a} → ${b}`);
  }
  return lines.length ? lines : ['（施設・指定内容・座標の変更なし）'];
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const emergencyLayers = [];
  for (const h of HAZARDS) emergencyLayers.push(await fetchLayer(h.gsiLayer));
  const shelterLayer = await fetchLayer('sih');

  const { facilities, problems } = mergeGsiFeatures({ emergencyLayers, shelterLayer });

  const cityHtml = await get(CITY_URL);
  const cityRows = parseCityTable(cityHtml);
  const cityUpdated = parseCityUpdatedDate(cityHtml);
  const { unmatchedCityRows, suspendedOnCity, cityStormSurge, gsiHasStormSurge } = crossCheckWithCity(facilities, cityRows);

  const notices = JSON.parse(await readFile(join(ROOT, 'data-manual/notices.json'), 'utf8')).notices;
  const { unused } = applyNotices(facilities, notices);

  for (const f of facilities) {
    f.sourceUrl = GSI_INFO_URL;
    f.sourceUpdatedAt = null; // 国土地理院タイルには施設ごとの更新日が含まれない
    f.lastCheckedAt = today;
    if (!f.remarks.length) delete f.remarks;
    f.notice ??= null;
  }

  const presentHazards = HAZARDS.filter((h) => facilities.some((f) => f.supportedHazards.includes(h.key)));
  const data = {
    schemaVersion: 1,
    region: { prefecture: '神奈川県', city: '藤沢市', localGovCode: '142051' },
    generatedAt: new Date().toISOString(),
    lastCheckedAt: today,
    hazards: presentHazards.map(({ key, label }) => ({ key, label })),
    // 公式に指定があるのに配信データ（国土地理院）に含まれない災害種別。検索の選択肢には出さず、公式一覧へ案内する。
    missingHazards: !gsiHasStormSurge && cityStormSurge.length ? [{
      key: 'storm_surge', label: '高潮',
      reason: `藤沢市は高潮の指定緊急避難場所を指定していますが（市ページ上 ${cityStormSurge.length} 件）、国土地理院データに藤沢市の高潮指定が登録されていないため、当サイトでは検索できません。`,
      officialUrl: 'https://www.city.fujisawa.kanagawa.jp/documents/20769/siteikinnkyu_takasio.pdf',
    }] : [],
    sources: [
      {
        id: 'gsi',
        name: '国土地理院「指定緊急避難場所・指定避難所データ」（地理院タイル skhb01〜08, sih）',
        url: GSI_INFO_URL, termsUrl: GSI_TERMS_URL, disclaimerUrl: GSI_DISCLAIMER_URL,
        license: '国土地理院コンテンツ利用規約（公共データ利用規約 第1.0版）。本データは国土地理院データをもとにふじさわレンズが加工して作成',
        note: '市町村が登録したデータ。施設ごとの更新日はタイルに含まれないため不明。位置は敷地・建物の正確な位置を示さない場合がある。',
        retrievedAt: today,
      },
      {
        id: 'fujisawa-city',
        name: '藤沢市「指定避難所・指定緊急避難場所の指定について」',
        url: CITY_URL, pageUpdatedAt: cityUpdated, retrievedAt: today,
        usage: '照合専用（指定内容の一致確認・地区名・休止告知の確認）。市ページの内容は転載していない。',
      },
    ],
    facilities,
  };

  const { errors, warnings } = validateShelterData(data);
  // 市ページで「休止」と表示されているのに notices.json に反映されていない施設は公開を止める
  for (const f of suspendedOnCity) {
    if (!f.notice) errors.push(`市ページで休止表示あり・notices.json 未反映: ${f.name}（data-manual/notices.json に追記してください）`);
  }
  let prev = null;
  try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* 初回 */ }

  const mismatched = facilities.filter((f) => f.cityPageCheck.status === 'mismatch');
  const notListed = facilities.filter((f) => f.cityPageCheck.status === 'not_listed');
  const report = [
    `# 避難先データ 照合レポート（${today}）`, '',
    `- 国土地理院データ（藤沢市分）: ${facilities.length} 件（座標あり ${facilities.filter((f) => f.latitude != null).length} 件）`,
    `- 指定緊急避難場所: ${facilities.filter((f) => f.facilityTypes.includes('指定緊急避難場所')).length} 件 / 指定避難所: ${facilities.filter((f) => f.facilityTypes.includes('指定避難所')).length} 件`,
    `- 収録災害種別: ${presentHazards.map((h) => h.label).join('、')}`,
    `- 市ページ更新日: ${cityUpdated ?? '不明'} / 市ページの行数: ${cityRows.length}`,
    `- 市ページと一致: ${facilities.filter((f) => f.cityPageCheck.status === 'match').length} 件 / 不一致: ${mismatched.length} 件 / 市ページに該当なし: ${notListed.length} 件`,
    '', '## 検証エラー', ...(errors.length ? errors.map((e) => `- ${e}`) : ['- なし']),
    '', '## 警告', ...(warnings.length ? warnings.map((e) => `- ${e}`) : ['- なし']),
    ...problems.map((e) => `- ${e}`),
    '', '## 市ページとの不一致（災害種別ごとに判定。国土地理院のみ指定ありの種別は検索結果から除外、市のみ指定ありの種別は「公式一覧で確認」として案内）', ...mismatched.map((f) => `- ${f.name}: ${f.cityPageCheck.mismatches.join(' / ')}`),
    '', '## 市ページに該当行がない国土地理院データ（指定内容を確認できないため災害種別の検索結果から除外）', ...notListed.map((f) => `- ${f.name}（${f.address}）[${f.facilityTypes.join('・')}]`),
    '', '## 国土地理院データに見つからない市ページの行（当サイトには未収録）', ...unmatchedCityRows.map((r) => `- [${r.district}] ${r.name}（${r.address}）`),
    '', '## 適用されなかった告知', ...(unused.length ? unused.map((n) => `- ${n.nameIncludes}`) : ['- なし']),
    '', '## 前回からの差分', ...diff(prev, data), '',
  ].join('\n');

  await mkdir(dirname(REPORT), { recursive: true });
  if (!DRY) await writeFile(REPORT, report);
  console.log(report);

  if (errors.length) {
    console.error(`\n検証エラー ${errors.length} 件のため ${OUT} は更新しません。`);
    process.exit(1);
  }
  if (DRY) { console.log('\n--dry-run のため書き出しません。'); return; }
  await writeFile(OUT, JSON.stringify(data));
  console.log(`\n書き出し: ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
