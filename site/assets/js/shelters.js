import { initCommon, fetchJson, el, formatDateJa, formatDateTimeJa, daysSince, STALE_DAYS } from './common.js';
import {
  filterFacilities, sortByDistance, searchFacilities, formatDistance, cityOnlyFacilities,
  googleMapsSearchUrl, googleMapsDirectionsUrl, haversineMeters,
} from './geo.js';

initCommon();

const PAGE = 10;
const SHELTER_MODE = 'shelter';
const CITY_LIST_URL = 'https://www.city.fujisawa.kanagawa.jp/kikikanri/bosai/siteihinannjyo.html';
const OPEN_STATUS_URL = 'https://www.city.fujisawa.kanagawa.jp/kikikanri/bosai/congestion_situation.html';
const TSUNAMI_BUILDINGS_URL = 'https://www.city.fujisawa.kanagawa.jp/kikikanri/bosai/bosai/tunamihinanbiruichiran.html';
const TSUNAMI_MAP_URL = 'https://www.city.fujisawa.kanagawa.jp/kikikanri/bosai/tsunamihinanmap.html';
const FUJISAWA_CENTER = { latitude: 35.3392, longitude: 139.4900 };
// ボタンに表示する短い名前（データの正式名称は data.hazards の label）
const SHORT_LABEL = { landslide: '崖崩れ・土石流・地滑り', large_fire: '大規模な火事' };

const $ = (id) => document.getElementById(id);
let data = null;
let hazardLabels = {};
let current = { items: [], shown: 0, withDistance: false, hazard: null };

function selectedMode() {
  const v = document.querySelector('input[name="hazard"]:checked')?.value;
  if (!v) return null;
  return v === SHELTER_MODE ? { mode: 'shelter', hazard: null } : { mode: 'emergency', hazard: v };
}

function modeLabel(m) {
  return m.mode === 'shelter' ? '指定避難所（災害後に滞在する施設）' : `${hazardLabels[m.hazard]}の指定緊急避難場所`;
}

function renderDataState(savedAt) {
  const box = $('data-state');
  const age = daysSince(data.lastCheckedAt);
  const parts = [el('p', {}, `データ：国土地理院の公開データ（藤沢市分）、${formatDateJa(data.lastCheckedAt)}確認。`, el('a', { href: '#h-about' }, '詳しく'))];
  let warn = false;
  if (savedAt) {
    warn = true;
    parts.push(el('p', {}, el('strong', { text: '端末に保存されたデータを表示しています' }),
      `（保存 ${formatDateTimeJa(savedAt)}）。最新の指定内容・開設状況は確認できていません。`));
  }
  if (age != null && age > STALE_DAYS) {
    warn = true;
    parts.push(el('p', {}, el('strong', { text: 'データの確認から時間が経っています。' }), ' 指定内容が変わっている可能性があるため、',
      el('a', { href: CITY_LIST_URL, rel: 'noopener' }, '藤沢市の公式一覧'), 'も確認してください。'));
  }
  box.className = warn ? 'notice warn' : 'status-line small muted';
  box.replaceChildren(...parts);
}

function renderSourceInfo() {
  $('source-info').replaceChildren(
    el('ul', {}, ...data.sources.map((s) => el('li', {},
      el('a', { href: s.url, rel: 'noopener' }, s.name),
      s.license ? `（${s.license}）` : '',
      s.pageUpdatedAt ? ` 市ページ更新日 ${formatDateJa(s.pageUpdatedAt)}。` : '',
      ` 取得日 ${formatDateJa(s.retrievedAt)}。`,
      s.usage ? ` ${s.usage}` : ''))),
    el('p', {}, '施設ごとの公式の更新日はデータに含まれないため「不明」と表示します。座標は国土地理院データの値で、敷地や建物の正確な位置を示さない場合があります。'),
    el('p', {}, '藤沢市の一覧と災害種別ごとに照合し、市の一覧で指定が確認できない種別は検索結果に出しません。'),
  );
}

function buildForm() {
  hazardLabels = Object.fromEntries(data.hazards.map((h) => [h.key, h.label]));
  const opts = $('hazard-options');
  const make = (value, label, sub) => {
    const id = `hz-${value}`;
    return el('label', { for: id, class: 'tile' },
      el('input', { type: 'radio', name: 'hazard', id, value, required: true }),
      el('span', {}, label, sub ? el('small', {}, sub) : ''));
  };
  for (const h of data.hazards) opts.append(make(h.key, SHORT_LABEL[h.key] ?? h.label));
  opts.append(make(SHELTER_MODE, '避難所（滞在用）', '災害後に過ごす施設'));
  // 検索できない種別は選択肢にせず、公式情報へのリンクとして示す
  const notes = $('hazard-notes');
  const missingLinks = (data.missingHazards ?? []).map((m) => el('a', { href: `#missing-${m.key}` }, m.label));
  notes.replaceChildren(...(missingLinks.length ? ['ここにない災害（', ...missingLinks.flatMap((a, i) => (i ? ['・', a] : [a])), '）・津波避難ビル・福祉避難所は', el('a', { href: '#h-missing' }, '公式情報へ')] : []));

  const missing = $('missing-hazards');
  for (const m of data.missingHazards ?? []) {
    missing.append(el('p', { id: `missing-${m.key}` },
      el('strong', { text: `${m.label}：` }), `${m.reason} `,
      el('a', { href: m.officialUrl, rel: 'noopener' }, `藤沢市「指定緊急避難場所（${m.label}）指定先一覧」（PDF）`)));
  }

  const districts = [...new Set(data.facilities.map((f) => f.district).filter(Boolean))];
  for (const d of districts) $('district').append(el('option', { value: d }, d));

  $('search-form').hidden = false;

  // ?hazard=flood のように種別を指定して開かれた場合は選択済みにする
  const param = new URLSearchParams(location.search).get('hazard');
  if (param) {
    const input = document.getElementById(`hz-${param}`);
    if (input) { input.checked = true; }
    else {
      $('locate-state').replaceChildren(el('p', { class: 'notice warn' },
        '指定された災害の種類はこのサイトのデータにありません。下から選ぶか、', el('a', { href: CITY_LIST_URL, rel: 'noopener' }, '藤沢市の公式一覧'), 'を確認してください。'));
    }
  }
}

function card(f, distanceM, hazard) {
  const addrId = `addr-${f.id}`;
  const copyBtn = el('button', { type: 'button', class: 'btn', 'aria-describedby': addrId }, '住所をコピー');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(f.address);
      copyBtn.textContent = 'コピーしました';
    } catch {
      copyBtn.textContent = 'コピーできませんでした（住所を長押しして選択してください）';
    }
  });
  const check = hazard ? f.hazardChecks?.[hazard] : null;
  const checkText = {
    match: '藤沢市の一覧と国土地理院データの両方で指定を確認',
    no_city_column: '国土地理院データの指定（藤沢市の一覧にはこの災害の欄がないため照合していません）',
  }[check];
  return el('li', { class: 'card' },
    el('h3', {}, f.name),
    distanceM != null ? el('p', { class: 'distance' }, `直線 ${formatDistance(distanceM)}`) : null,
    el('p', { class: 'addr', id: addrId }, f.address.replace(/^神奈川県藤沢市/, '藤沢市')),
    el('div', { class: 'links-row' },
      el('a', { class: 'btn', href: googleMapsSearchUrl(f), target: '_blank', rel: 'noopener noreferrer' }, '地図'),
      el('a', { class: 'btn', href: googleMapsDirectionsUrl(f), target: '_blank', rel: 'noopener noreferrer' }, '経路'),
    ),
    el('details', { class: 'more' },
      el('summary', {}, '詳しく'),
      el('dl', {},
        el('dt', {}, '指定'), el('dd', {}, f.facilityTypes.join('・')),
        f.supportedHazards?.length ? [el('dt', {}, '対象の災害'), el('dd', {}, f.supportedHazards.filter((k) => !(f.excludedHazards ?? []).includes(k)).map((k) => hazardLabels[k] ?? k).join('、'))] : null,
        checkText ? [el('dt', {}, '確認'), el('dd', {}, checkText)] : null,
        f.district ? [el('dt', {}, '地区'), el('dd', {}, f.district)] : null,
        el('dt', {}, '開設状況'), el('dd', {}, 'このデータには含まれません'),
        el('dt', {}, '公式更新日'), el('dd', {}, f.sourceUpdatedAt ? formatDateJa(f.sourceUpdatedAt) : '不明'),
        el('dt', {}, '最終確認'), el('dd', {}, formatDateJa(f.lastCheckedAt)),
        el('dt', {}, '出典'), el('dd', {}, el('a', { href: f.sourceUrl, rel: 'noopener' }, '国土地理院')),
      ),
      f.remarks?.length ? el('p', { class: 'small' }, `備考（公式データ）：${f.remarks.join(' / ')}`) : null,
      f.latitude == null ? el('p', { class: 'small' }, '座標が確認できないため距離は計算していません。') : null,
      el('div', { class: 'links-row' }, copyBtn, el('a', { class: 'btn', href: `crowding.html#${f.id}` }, '混雑の報告')),
    ),
  );
}

function showMore() {
  const list = $('results');
  const next = current.items.slice(current.shown, current.shown + PAGE);
  for (const it of next) list.append(card(it.facility, it.distanceM, current.hazard));
  current.shown += next.length;
  $('more-btn').hidden = current.shown >= current.items.length;
}

// 結果の前に出す注意：指定と開設の区別、災害種別ごとの不足情報
function preNotices(m) {
  const out = [];
  if (m.hazard === 'tsunami') {
    out.push(el('div', { class: 'notice danger' },
      el('p', {}, el('strong', {}, '津波：揺れたら、すぐにできるだけ高い場所へ。'), '下の一覧（指定緊急避難場所）は数が少なく、沿岸部では「津波避難ビル」も避難先です。津波避難ビルはこのサイトのデータに含まれていません。'),
      el('div', { class: 'links-row' },
        el('a', { class: 'btn primary', href: TSUNAMI_BUILDINGS_URL, rel: 'noopener' }, '津波避難ビル（藤沢市）'),
        el('a', { class: 'btn', href: TSUNAMI_MAP_URL, rel: 'noopener' }, '津波避難マップ（藤沢市）'))));
  }
  if (m.hazard === 'inland_flood') {
    out.push(el('p', { class: 'notice small' }, '内水氾濫（大雨で下水や水路があふれる浸水）の指定は国土地理院データによるものです。藤沢市の一覧には内水氾濫の欄がないため、市の一覧との照合はしていません。'));
  }
  const cityOnly = m.hazard ? cityOnlyFacilities(data.facilities, m.hazard) : [];
  if (cityOnly.length) {
    out.push(el('div', { class: 'notice warn small' },
      el('p', {}, el('strong', {}, '公式一覧で確認が必要な施設：'),
        `${cityOnly.map((f) => f.name).join('、')}は、藤沢市の一覧では「${cityOnly[0].cityOnlyHazards.find((c) => c.hazards.includes(m.hazard)).label}」の指定がありますが、このサイトのデータ（国土地理院）では確認できないため、下の一覧には入れていません。`),
      el('p', {}, el('a', { href: CITY_LIST_URL, rel: 'noopener' }, '藤沢市の避難先一覧で確認する'))));
  }
  out.push(el('p', { class: 'notice small' },
    el('strong', {}, 'これは「指定されている施設」の一覧です。'), '今開いているか（開設状況）は分かりません。',
    el('a', { href: OPEN_STATUS_URL, rel: 'noopener' }, '開設・混雑状況（藤沢市公式）'), 'で確認してください。'));
  return out;
}

function showResults(items, summary, { withDistance, extraNote, m }) {
  current = { items, shown: 0, withDistance, hazard: m.hazard };
  $('results-section').hidden = false;
  $('results').replaceChildren();
  const s = $('results-summary');
  s.replaceChildren(summary);
  if (withDistance) s.append(el('br'), el('span', { class: 'small' }, '距離は直線距離です（道のり・所要時間・通れるかは分かりません）。'));
  if (extraNote) s.append(el('br'), extraNote);
  $('results-pre').replaceChildren(...preNotices(m));
  if (items.length === 0) {
    $('results').append(el('li', { class: 'notice warn' },
      el('p', {}, 'この条件に当てはまる公式の指定先は見つかりませんでした。別の種類の施設を代わりに案内することはしません。'),
      el('p', {}, el('a', { href: CITY_LIST_URL, rel: 'noopener' }, '藤沢市の公式一覧'), 'や防災情報を確認し、危険なときは近くの安全な場所へ避難してください。')));
    $('more-btn').hidden = true;
  } else {
    showMore();
  }
  $('h-results').focus();
}

function requireMode() {
  const m = selectedMode();
  if (!m) {
    $('locate-state').replaceChildren(el('p', { class: 'notice warn' }, '先に「1. 何から避難しますか？」を選んでください。'));
    $('hazard-fieldset').querySelector('input')?.focus();
  }
  return m;
}

function onLocate() {
  const m = requireMode();
  if (!m) return;
  const state = $('locate-state');
  if (!('geolocation' in navigator) || !navigator.geolocation) {
    state.replaceChildren(el('p', { class: 'notice warn' }, 'この端末・ブラウザでは位置情報を利用できません。下の「施設名・住所・地区名で探す」をご利用ください。'));
    $('query').focus();
    return;
  }
  state.replaceChildren(el('p', {}, '現在地を取得しています…'));
  navigator.geolocation.getCurrentPosition((pos) => {
    // 位置情報はこの関数内でのみ使い、保存・送信しない
    const origin = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
    const pool = filterFacilities(data.facilities, m);
    const { withDistance, noCoordinates } = sortByDistance(pool, origin);
    const far = haversineMeters(origin.latitude, origin.longitude, FUJISAWA_CENTER.latitude, FUJISAWA_CENTER.longitude);
    state.replaceChildren(el('p', { class: 'small' }, `現在地を取得しました（精度 約${Math.round(pos.coords.accuracy)} m）。`));
    const items = withDistance.concat(noCoordinates.map((f) => ({ facility: f, distanceM: null })));
    showResults(items, `${modeLabel(m)}：近い順 ${items.length}件`, {
      withDistance: true, m,
      extraNote: far != null && far > 20000 ? el('strong', {}, '現在地が藤沢市から離れているようです。このサイトは藤沢市の避難先のみを扱います。') : null,
    });
  }, (err) => {
    const msg = {
      1: '位置情報の利用が許可されませんでした。',
      2: '現在地を特定できませんでした。',
      3: '現在地の取得に時間がかかりすぎたため中止しました。',
    }[err.code] ?? '現在地を取得できませんでした。';
    state.replaceChildren(el('p', { class: 'notice warn' }, `${msg} 下の「施設名・住所・地区名で探す」「地区で絞り込む」で探せます。`));
  }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 });
}

function onManualSearch(ev) {
  ev.preventDefault();
  const m = requireMode();
  if (!m) return;
  let pool = filterFacilities(data.facilities, m);
  const q = $('query').value.trim();
  const d = $('district').value;
  if (d) pool = pool.filter((f) => f.district === d);
  if (q) pool = searchFacilities(pool, q);
  const cond = [q && `「${q}」`, d && `${d}地区`].filter(Boolean).join('・') || 'すべて';
  showResults(pool.map((f) => ({ facility: f, distanceM: null })), `${modeLabel(m)}：${cond} ${pool.length}件（住所順）`, { m });
}

async function main() {
  try {
    const { data: d, savedAt } = await fetchJson('data/shelters.json');
    if (!d || !Array.isArray(d.facilities) || !Array.isArray(d.hazards)) throw new Error('形式が不正です');
    data = d;
    renderDataState(savedAt);
    renderSourceInfo();
    buildForm();
    $('locate-btn').addEventListener('click', onLocate);
    $('search-form').addEventListener('submit', onManualSearch);
    $('more-btn').addEventListener('click', showMore);
  } catch {
    const box = $('data-state');
    box.className = 'notice danger';
    box.replaceChildren(
      el('p', {}, el('strong', { text: '避難先データを読み込めませんでした。' }), navigator.onLine ? '' : '（オフラインで、端末に保存されたデータもありません。初めて開く前は保存されていません）'),
      el('p', {}, el('a', { href: CITY_LIST_URL, rel: 'noopener' }, '藤沢市「指定避難所・指定緊急避難場所の指定について」'), 'で公式の一覧を確認してください。'));
  }
}
main();
