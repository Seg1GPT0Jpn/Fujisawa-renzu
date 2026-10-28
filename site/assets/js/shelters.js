import { initCommon, fetchJson, el, formatDateJa, formatDateTimeJa, daysSince, STALE_DAYS } from './common.js';
import {
  filterFacilities, sortByDistance, searchFacilities, formatDistance,
  googleMapsSearchUrl, googleMapsDirectionsUrl, haversineMeters,
} from './geo.js';

initCommon();

const PAGE = 10;
const SHELTER_MODE = '__shelter__';
const CITY_LIST_URL = 'https://www.city.fujisawa.kanagawa.jp/kikikanri/bosai/siteihinannjyo.html';
const FUJISAWA_CENTER = { latitude: 35.3392, longitude: 139.4900 };

const $ = (id) => document.getElementById(id);
let data = null;
let hazardLabels = {};
let current = { items: [], shown: 0, withDistance: false };

function selectedMode() {
  const v = document.querySelector('input[name="hazard"]:checked')?.value;
  if (!v) return null;
  return v === SHELTER_MODE ? { mode: 'shelter', hazard: null } : { mode: 'emergency', hazard: v };
}

function modeLabel(m) {
  return m.mode === 'shelter' ? '指定避難所（滞在用）' : `指定緊急避難場所（${hazardLabels[m.hazard]}）`;
}

function renderDataState(savedAt) {
  const box = $('data-state');
  const age = daysSince(data.lastCheckedAt);
  const parts = [
    el('p', {}, `避難先データ：国土地理院の公開データ（藤沢市分）。最終確認 ${formatDateJa(data.lastCheckedAt)}。`),
  ];
  let cls = 'notice';
  if (savedAt) {
    cls = 'notice warn';
    parts.push(el('p', {}, el('strong', { text: '端末に保存されたデータを表示しています' }),
      `（保存 ${formatDateTimeJa(savedAt)}）。最新の指定内容・開設状況は確認できていません。`));
  }
  if (age != null && age > STALE_DAYS) {
    cls = 'notice warn';
    parts.push(el('p', {}, el('strong', { text: 'データの確認から時間が経っています。' }), ' 指定内容が変わっている可能性があるため、',
      el('a', { href: CITY_LIST_URL, rel: 'noopener' }, '藤沢市の公式一覧'), 'を確認してください。'));
  }
  parts.push(el('p', { class: 'small' }, '開設しているかどうか（開設状況）は、このデータには含まれません。'));
  box.className = cls;
  box.replaceChildren(...parts);
}

function renderSourceInfo() {
  const box = $('source-info');
  box.replaceChildren(
    el('ul', {}, ...data.sources.map((s) => el('li', {},
      el('a', { href: s.url, rel: 'noopener' }, s.name),
      s.license ? `（${s.license}）` : '',
      s.pageUpdatedAt ? ` 市ページ更新日 ${formatDateJa(s.pageUpdatedAt)}。` : '',
      ` 取得日 ${formatDateJa(s.retrievedAt)}。`,
      s.usage ? ` ${s.usage}` : '',
      s.note ? ` ${s.note}` : ''))),
    el('p', {}, '施設ごとの公式の更新日は配信データに含まれていないため「不明」と表示します。座標は国土地理院データの値で、敷地や建物の正確な位置を示さない場合があります。'),
  );
}

function buildForm() {
  hazardLabels = Object.fromEntries(data.hazards.map((h) => [h.key, h.label]));
  const opts = $('hazard-options');
  const make = (value, label, hint) => {
    const id = `hz-${value}`;
    return el('label', { for: id }, el('input', { type: 'radio', name: 'hazard', id, value, required: true }), el('span', {}, label, hint ? el('span', { class: 'small muted' }, ` ${hint}`) : ''));
  };
  for (const h of data.hazards) opts.append(make(h.key, h.label));
  opts.append(make(SHELTER_MODE, '災害後に滞在する場所（指定避難所）', '※緊急に逃げる場所ではありません'));

  const missing = $('missing-hazards');
  for (const m of data.missingHazards ?? []) {
    missing.append(el('div', { class: 'notice warn' },
      el('p', {}, el('strong', { text: `「${m.label}」はこのサイトでは検索できません。` }), ` ${m.reason}`),
      el('p', {}, el('a', { href: m.officialUrl, rel: 'noopener' }, `藤沢市「指定緊急避難場所（${m.label}）指定先一覧」（PDF）`), 'を確認してください。')));
  }

  const districts = [...new Set(data.facilities.map((f) => f.district).filter(Boolean))];
  const sel = $('district');
  for (const d of districts) sel.append(el('option', { value: d }, d));

  $('search-form').hidden = false;
}

function hazardTags(f) {
  return (f.supportedHazards ?? []).map((k) => el('span', { class: 'tag' }, hazardLabels[k] ?? k));
}

function card(f, distanceM) {
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
  const warn = [];
  if (f.cityPageCheck?.status === 'mismatch') {
    warn.push(el('p', { class: 'notice warn small' }, el('strong', { text: '要確認：' }),
      `藤沢市の一覧と指定内容が異なります（${f.cityPageCheck.mismatches.join('、')}）。`,
      el('a', { href: CITY_LIST_URL, rel: 'noopener' }, '市の公式一覧'), 'を確認してください。'));
  }
  return el('li', { class: 'card' },
    el('h3', {}, f.name),
    distanceM != null ? el('p', { class: 'distance' }, `直線距離 ${formatDistance(distanceM)}`) : null,
    ...warn,
    el('dl', {},
      el('dt', {}, '住所'), el('dd', { id: addrId }, f.address),
      el('dt', {}, '種別'), el('dd', {}, f.facilityTypes.join('・')),
      f.supportedHazards?.length ? [el('dt', {}, '対象の災害'), el('dd', {}, hazardTags(f))] : null,
      f.district ? [el('dt', {}, '地区'), el('dd', {}, f.district)] : null,
      el('dt', {}, '公式更新日'), el('dd', {}, f.sourceUpdatedAt ? formatDateJa(f.sourceUpdatedAt) : '不明'),
      el('dt', {}, '最終確認'), el('dd', {}, formatDateJa(f.lastCheckedAt)),
      el('dt', {}, '出典'), el('dd', {}, el('a', { href: f.sourceUrl, rel: 'noopener' }, '国土地理院')),
    ),
    f.remarks?.length ? el('p', { class: 'small' }, `備考（公式データ）：${f.remarks.join(' / ')}`) : null,
    f.latitude == null ? el('p', { class: 'small' }, '座標が確認できないため距離は計算していません。') : null,
    el('div', { class: 'links-row' },
      el('a', { class: 'btn', href: googleMapsSearchUrl(f), target: '_blank', rel: 'noopener noreferrer' }, '地図で見る（Google マップ）'),
      el('a', { class: 'btn', href: googleMapsDirectionsUrl(f), target: '_blank', rel: 'noopener noreferrer' }, '経路を開く（Google マップ）'),
      copyBtn,
      el('a', { class: 'btn', href: `crowding.html#${f.id}` }, '混雑状況'),
    ),
  );
}

function showMore() {
  const list = $('results');
  const next = current.items.slice(current.shown, current.shown + PAGE);
  for (const it of next) list.append(card(it.facility, it.distanceM));
  current.shown += next.length;
  $('more-btn').hidden = current.shown >= current.items.length;
}

function showResults(items, summary, { withDistance, extraNote, hazard = null } = {}) {
  current = { items, shown: 0, withDistance, hazard };
  $('results-section').hidden = false;
  $('results').replaceChildren();
  $('distance-note').hidden = !withDistance;
  const s = $('results-summary');
  s.replaceChildren(summary);
  if (extraNote) s.append(el('br'), extraNote);
  if (current.hazard === 'tsunami') {
    s.append(el('span', { class: 'notice warn small', style: 'display:block' },
      '津波のときは、この一覧（指定緊急避難場所）のほか「津波避難ビル」も避難先になります。津波避難ビルはこのサイトのデータに含まれていません：',
      el('a', { href: 'https://www.city.fujisawa.kanagawa.jp/kikikanri/bosai/bosai/tunamihinanbiruichiran.html', rel: 'noopener' }, '藤沢市「津波避難ビル」'),
      '。揺れを感じたら、できるだけ早く高い場所へ。'));
  }
  if (items.length === 0) {
    $('results').append(el('li', { class: 'notice warn' },
      el('p', {}, 'この条件に該当する公式の指定先は見つかりませんでした。別の種類の施設を代わりに案内することはしません。'),
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
    $('locate-state').replaceChildren(el('p', { class: 'notice warn' }, '先に「何から避難しますか？」を選んでください。'));
    $('hazard-fieldset').querySelector('input')?.focus();
  }
  return m;
}

function onLocate() {
  const m = requireMode();
  if (!m) return;
  const state = $('locate-state');
  if (!('geolocation' in navigator)) {
    state.replaceChildren(el('p', { class: 'notice warn' }, 'この端末・ブラウザでは位置情報を利用できません。下の「施設名・住所・地区名で探す」をご利用ください。'));
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
    showResults(items, `${modeLabel(m)}：近い順に ${items.length} 件`, {
      withDistance: true, hazard: m.hazard,
      extraNote: far != null && far > 20000 ? el('strong', {}, '現在地が藤沢市から離れているようです。このサイトは藤沢市の避難先のみを扱います。') : null,
    });
  }, (err) => {
    const msg = {
      1: '位置情報の利用が許可されませんでした。',
      2: '現在地を特定できませんでした。',
      3: '現在地の取得に時間がかかりすぎたため中止しました。',
    }[err.code] ?? '現在地を取得できませんでした。';
    state.replaceChildren(el('p', { class: 'notice warn' }, `${msg} 下の「施設名・住所・地区名で探す」「地区から探す」で確認できます。`));
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
  showResults(pool.map((f) => ({ facility: f, distanceM: null })), `${modeLabel(m)}：${cond} ${pool.length} 件（住所順）`, { hazard: m.hazard });
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
      el('p', {}, el('strong', { text: '避難先データを読み込めませんでした。' }), navigator.onLine ? '' : '（オフラインで、端末に保存されたデータもありません。初回表示前は保存されていません）'),
      el('p', {}, el('a', { href: CITY_LIST_URL, rel: 'noopener' }, '藤沢市「指定避難所・指定緊急避難場所の指定について」'), 'で公式の一覧を確認してください。'));
  }
}
main();
