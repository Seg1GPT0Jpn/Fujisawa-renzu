import { initCommon, fetchJson, el, formatDateJa, formatDateTimeJa, daysSince, STALE_DAYS, t, ready } from './common.js';
import { getLang } from './i18n.js';
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

const $ = (id) => document.getElementById(id);
let data = null;
let current = { items: [], shown: 0, withDistance: false, hazard: null };

// 災害の種類の名前（ボタン用の短い名前／文中の名前）
function hazardName(key) {
  if (key === SHELTER_MODE) return t('hazard.shelter', '避難所（滞在用）');
  const ja = data.hazards.find((h) => h.key === key)?.label ?? key;
  return t(`hazard.${key}`, ja);
}
function hazardButtonLabel(key) {
  const short = { landslide: '崖崩れ・土石流・地滑り', large_fire: '大規模な火事' };
  if (key === SHELTER_MODE) return t('hazard.shelter', '避難所（滞在用）');
  return t(`hazard.${key}`, short[key] ?? hazardName(key));
}
// 地区名：日本語以外では「Tsujido（辻堂）」のように表示（ローマ字は藤沢市の多言語ページの表記）
function districtName(d) {
  if (!d) return '';
  if (getLang() === 'ja') return d;
  const r = t(`district.${d}`, '');
  return r ? `${r}（${d}）` : d;
}

function modeOf(key) {
  return key === SHELTER_MODE ? { mode: 'shelter', hazard: null, key } : { mode: 'emergency', hazard: key, key };
}
function modeLabel(m) {
  return m.mode === 'shelter'
    ? t('shelters.modeShelter', '指定避難所（災害後に滞在する施設）')
    : t('shelters.modeEmergency', '{hazard}の指定緊急避難場所', { hazard: hazardName(m.hazard) });
}

function renderDataState(savedAt) {
  const box = $('data-state');
  const age = daysSince(data.lastCheckedAt);
  const parts = [el('p', {}, t('shelters.dataLine', 'データ：国土地理院の公開データ（藤沢市分）、{date}確認。', { date: formatDateJa(data.lastCheckedAt) }), ' ',
    el('a', { href: '#h-about' }, t('shelters.details', '詳しく')))];
  let warn = false;
  if (savedAt) {
    warn = true;
    parts.push(el('p', {}, el('strong', {}, t('shelters.savedData', '端末に保存されたデータを表示しています')),
      t('shelters.savedDataDetail', '（保存 {date}）。最新の指定内容・開設状況は確認できていません。', { date: formatDateTimeJa(savedAt) })));
  }
  if (age != null && age > STALE_DAYS) {
    warn = true;
    parts.push(el('p', {}, el('strong', {}, t('shelters.stale', 'データの確認から時間が経っています。')), ' ',
      t('shelters.staleDetail', '指定内容が変わっている可能性があるため、藤沢市の公式一覧も確認してください。'), ' ',
      el('a', { href: CITY_LIST_URL, rel: 'noopener' }, t('link.cityShelterList', '藤沢市の避難先一覧'))));
  }
  if (getLang() !== 'ja') parts.push(el('p', {}, t('shelters.namesInJa', '施設名・住所は公式データの日本語表記のまま表示します。')));
  box.className = warn ? 'notice warn' : 'status-line small muted';
  box.replaceChildren(...parts);
}

function renderSourceInfo() {
  $('source-info').replaceChildren(
    el('ul', {}, ...data.sources.map((s) => el('li', {},
      el('a', { href: s.url, rel: 'noopener', lang: 'ja' }, s.name),
      ` ${t('shelters.retrieved', '取得日')} ${formatDateJa(s.retrievedAt)}`))),
    el('p', {}, t('shelters.sourceNote1', '施設ごとの公式の更新日はデータに含まれないため「不明」と表示します。座標は国土地理院データの値で、敷地や建物の正確な位置を示さない場合があります。')),
    el('p', {}, t('shelters.sourceNote2', '藤沢市の一覧と災害種別ごとに照合し、市の一覧で指定が確認できない種別は検索結果に出しません。')),
    el('p', {}, el('a', { href: 'sources.html' }, t('shelters.sourcesLink', '出典・データの扱い'))),
  );
}

function buildUi() {
  const opts = $('hazard-options');
  const keys = [...data.hazards.map((h) => h.key), SHELTER_MODE];
  for (const key of keys) {
    const b = el('button', { type: 'button', class: 'tile', id: `hz-${key}`, 'data-hazard': key, 'aria-pressed': 'false' },
      hazardButtonLabel(key), key === SHELTER_MODE ? el('small', {}, t('hazard.shelterSub', '災害後に過ごす施設')) : '');
    b.addEventListener('click', () => onPick(key));
    opts.append(b);
  }
  const missingLinks = (data.missingHazards ?? []).map((m) => el('a', { href: `#missing-${m.key}` }, t(`hazard.${m.key}`, m.label)));
  $('hazard-notes').replaceChildren(...(missingLinks.length ? [
    t('shelters.notHere', 'ここにない災害（'), ...missingLinks.flatMap((a, i) => (i ? ['・', a] : [a])),
    t('shelters.notHere2', '）・津波避難ビル・福祉避難所は'), ' ', el('a', { href: '#h-missing' }, t('shelters.toOfficial', '公式情報へ'))] : []));
  for (const m of data.missingHazards ?? []) {
    $('missing-hazards').append(el('p', { id: `missing-${m.key}` },
      el('strong', {}, `${t(`hazard.${m.key}`, m.label)}：`),
      t(`shelters.missing.${m.key}`, m.reason), ' ',
      el('a', { href: m.officialUrl, rel: 'noopener' }, t(`shelters.missingLink.${m.key}`, `藤沢市「指定緊急避難場所（${m.label}）指定先一覧」（PDF）`))));
  }
  const sel = $('m-hazard');
  for (const key of keys) sel.append(el('option', { value: key }, hazardName(key)));
  const districts = [...new Set(data.facilities.map((f) => f.district).filter(Boolean))];
  for (const d of districts) $('district').append(el('option', { value: d }, districtName(d)));
  $('pick').hidden = false;
}

function setPressed(key) {
  for (const b of document.querySelectorAll('#hazard-options .tile')) b.setAttribute('aria-pressed', String(b.dataset.hazard === key));
  if (key) $('m-hazard').value = key;
}

function card(f, distanceM, hazard, nearest) {
  const addrId = `addr-${f.id}`;
  const copyBtn = el('button', { type: 'button', class: 'btn', 'aria-describedby': addrId }, t('card.copy', '住所をコピー'));
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(f.address);
      copyBtn.textContent = t('card.copied', 'コピーしました');
    } catch {
      copyBtn.textContent = t('card.copyFailed', 'コピーできませんでした（住所を長押しして選択してください）');
    }
  });
  const check = hazard ? f.hazardChecks?.[hazard] : null;
  const checkText = {
    match: t('card.checkMatch', '藤沢市の一覧と国土地理院データの両方で指定を確認'),
    no_city_column: t('card.checkNoColumn', '国土地理院データの指定（藤沢市の一覧にはこの災害の欄がないため照合していません）'),
  }[check];
  const types = f.facilityTypes.map((x) => (x === '指定緊急避難場所' ? t('type.emergency', '指定緊急避難場所') : t('type.shelter', '指定避難所'))).join('・');
  return el('li', { class: nearest ? 'card nearest' : 'card' },
    nearest ? el('p', { class: 'nearest-label' }, t('card.nearest', 'いちばん近い避難先（直線距離）')) : null,
    el('h3', { lang: 'ja' }, f.name),
    distanceM != null ? el('p', { class: 'distance' }, t('card.distance', '直線 {d}', { d: formatDistance(distanceM) })) : null,
    el('p', { class: 'addr', id: addrId, lang: 'ja' }, f.address.replace(/^神奈川県藤沢市/, '藤沢市')),
    el('a', { class: 'btn route', href: googleMapsDirectionsUrl(f), target: '_blank', rel: 'noopener noreferrer' },
      t('card.route', '徒歩の経路を表示（Googleマップ）')),
    el('div', { class: 'links-row' },
      el('a', { class: 'btn', href: googleMapsSearchUrl(f), target: '_blank', rel: 'noopener noreferrer' }, t('card.map', '地図で場所を見る')),
      copyBtn),
    el('details', { class: 'more' },
      el('summary', {}, t('card.more', '詳しく')),
      el('dl', {},
        el('dt', {}, t('card.type', '指定')), el('dd', {}, types),
        f.supportedHazards?.length ? [el('dt', {}, t('card.hazards', '対象の災害')), el('dd', {}, f.supportedHazards.filter((k) => !(f.excludedHazards ?? []).includes(k)).map((k) => hazardName(k)).join('、'))] : null,
        checkText ? [el('dt', {}, t('card.check', '確認')), el('dd', {}, checkText)] : null,
        f.district ? [el('dt', {}, t('card.district', '地区')), el('dd', {}, districtName(f.district))] : null,
        el('dt', {}, t('card.open', '開設状況')), el('dd', {}, t('card.openUnknown', 'このデータには含まれません')),
        el('dt', {}, t('card.updated', '公式更新日')), el('dd', {}, f.sourceUpdatedAt ? formatDateJa(f.sourceUpdatedAt) : t('common.unknown', '不明')),
        el('dt', {}, t('card.checked', '最終確認')), el('dd', {}, formatDateJa(f.lastCheckedAt)),
        el('dt', {}, t('card.source', '出典')), el('dd', {}, el('a', { href: f.sourceUrl, rel: 'noopener' }, t('card.gsi', '国土地理院'))),
      ),
      f.remarks?.length ? el('p', { class: 'small', lang: 'ja' }, `${t('card.remarks', '備考（公式データ）')}：${f.remarks.join(' / ')}`) : null,
      f.latitude == null ? el('p', { class: 'small' }, t('card.noCoords', '座標が確認できないため距離は計算していません。')) : null,
      el('div', { class: 'links-row' }, el('a', { class: 'btn', href: `crowding.html#${f.id}` }, t('card.crowding', '混雑の報告'))),
    ),
  );
}

function showMore() {
  const list = $('results');
  const next = current.items.slice(current.shown, current.shown + PAGE);
  next.forEach((it, k) => list.append(card(it.facility, it.distanceM, current.hazard, current.withDistance && current.shown + k === 0)));
  current.shown += next.length;
  $('more-btn').hidden = current.shown >= current.items.length;
}

// 結果の前に出す注意（短く）：津波避難ビル、指定と開設の区別
function preNotices(m) {
  const out = [];
  if (m.hazard === 'tsunami') {
    out.push(el('div', { class: 'notice danger compact' },
      el('p', {}, el('strong', {}, t('pre.tsunamiTitle', '津波：揺れたら、すぐにできるだけ高い場所へ。')), ' ',
        t('pre.tsunamiBody', '沿岸部では「津波避難ビル」も避難先です（このサイトのデータには含まれていません）。')),
      el('div', { class: 'links-row' },
        el('a', { class: 'btn primary', href: TSUNAMI_BUILDINGS_URL, rel: 'noopener' }, t('link.tsunamiBldg', '津波避難ビル（藤沢市）')),
        el('a', { class: 'btn', href: TSUNAMI_MAP_URL, rel: 'noopener' }, t('link.tsunamiMap', '津波避難マップ（藤沢市）')))));
  }
  out.push(el('p', { class: 'small designated' },
    el('strong', {}, t('pre.designatedTitle', '指定されている施設の一覧で、開いているかは分かりません。')), ' ',
    el('a', { href: OPEN_STATUS_URL, rel: 'noopener' }, t('pre.openLink', '開設・混雑状況（藤沢市公式）'))));
  return out;
}

// 結果の後に出す補足：照合で推奨しなかった施設、内水氾濫の注記、経路の注意
function postNotices(m) {
  const out = [];
  const cityOnly = m.hazard ? cityOnlyFacilities(data.facilities, m.hazard) : [];
  if (cityOnly.length) {
    out.push(el('div', { class: 'notice warn small' },
      el('p', {}, el('strong', {}, t('pre.cityOnlyTitle', '公式一覧で確認が必要な施設：')), ' ',
        el('span', { lang: 'ja' }, cityOnly.map((f) => f.name).join('、')), ' ',
        t('pre.cityOnlyBody', '藤沢市の一覧ではこの災害の指定がありますが、このサイトのデータ（国土地理院）では確認できないため、上の一覧には入れていません。')),
      el('p', {}, el('a', { href: CITY_LIST_URL, rel: 'noopener' }, t('pre.cityOnlyLink', '藤沢市の避難先一覧で確認する')))));
  }
  if (m.hazard === 'inland_flood') {
    out.push(el('p', { class: 'notice small' }, t('pre.inland', '内水氾濫（大雨で下水や水路があふれる浸水）の指定は国土地理院データによるものです。藤沢市の一覧には内水氾濫の欄がないため、市の一覧との照合はしていません。')));
  }
  out.push(el('p', { class: 'small muted' }, t('pre.routeNote', '経路はGoogleマップが案内するもので、災害時に通れるとは限りません。')));
  return out;
}

function showResults(items, summary, { withDistance, extraNote, m }) {
  current = { items, shown: 0, withDistance, hazard: m.hazard };
  $('results-section').hidden = false;
  $('results').replaceChildren();
  const s = $('results-summary');
  s.replaceChildren(summary);
  if (withDistance) s.append(el('br'), el('span', { class: 'small' }, t('shelters.straightNote', '距離は直線距離です（道のり・所要時間・通れるかは分かりません）。')));
  if (extraNote) s.append(el('br'), extraNote);
  $('results-pre').replaceChildren(...preNotices(m));
  $('results-post').replaceChildren(...postNotices(m));
  if (items.length === 0) {
    $('results').append(el('li', { class: 'notice warn' },
      el('p', {}, t('shelters.none', 'この条件に当てはまる公式の指定先は見つかりませんでした。別の種類の施設を代わりに案内することはしません。')),
      el('p', {}, el('a', { href: CITY_LIST_URL, rel: 'noopener' }, t('link.cityShelterList', '藤沢市の避難先一覧')), ' ',
        t('shelters.noneAfter', 'や防災情報を確認し、危険なときは近くの安全な場所へ避難してください。'))));
    $('more-btn').hidden = true;
  } else {
    showMore();
  }
  $('h-results').focus();
}

// 位置情報が使えないときは、その種類の避難先を地区順の一覧ですぐ表示する
function showListFallback(m, reason) {
  const pool = filterFacilities(data.facilities, m);
  $('locate-state').replaceChildren(el('p', { class: 'notice warn' }, reason, ' ',
    t('shelters.fallbackHint', '下の一覧から探すか、「位置情報を使わずに探す」で地区を選んでください。')));
  showResults(pool.map((f) => ({ facility: f, distanceM: null })), t('shelters.listSummary', '{mode}：{n}件（住所順）', { mode: modeLabel(m), n: pool.length }), { m });
  $('locate-state').scrollIntoView?.({ block: 'start' });
}

function locate(m) {
  $('results-section').hidden = false;
  $('results').replaceChildren();
  $('results-pre').replaceChildren();
  $('results-post').replaceChildren();
  $('more-btn').hidden = true;
  $('results-summary').replaceChildren(modeLabel(m));
  const state = $('locate-state');
  if (!('geolocation' in navigator) || !navigator.geolocation) {
    showListFallback(m, t('shelters.noGeo', 'この端末・ブラウザでは位置情報を利用できません。'));
    return;
  }
  state.replaceChildren(el('p', {}, t('shelters.locating', '現在地を取得しています…（許可を求められたら「許可」を押してください）')));
  $('results-section').scrollIntoView?.({ block: 'start' });
  navigator.geolocation.getCurrentPosition((pos) => {
    // 位置情報はこの関数内でのみ使い、保存・送信しない
    const origin = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
    const pool = filterFacilities(data.facilities, m);
    const { withDistance, noCoordinates } = sortByDistance(pool, origin);
    const far = haversineMeters(origin.latitude, origin.longitude, FUJISAWA_CENTER.latitude, FUJISAWA_CENTER.longitude);
    state.replaceChildren(el('p', { class: 'small' }, t('shelters.located', '現在地を取得しました（精度 約{n} m）。', { n: Math.round(pos.coords.accuracy) })));
    const items = withDistance.concat(noCoordinates.map((f) => ({ facility: f, distanceM: null })));
    showResults(items, t('shelters.nearSummary', '{mode}：近い順 {n}件', { mode: modeLabel(m), n: items.length }), {
      withDistance: true, m,
      extraNote: far != null && far > 20000 ? el('strong', {}, t('shelters.far', '現在地が藤沢市から離れているようです。このサイトは藤沢市の避難先のみを扱います。')) : null,
    });
  }, (err) => {
    const msg = {
      1: t('shelters.geoDenied', '位置情報の利用が許可されませんでした。'),
      2: t('shelters.geoUnavailable', '現在地を特定できませんでした。'),
      3: t('shelters.geoTimeout', '現在地の取得に時間がかかりすぎたため中止しました。'),
    }[err.code] ?? t('shelters.geoFailed', '現在地を取得できませんでした。');
    showListFallback(m, msg);
  }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 });
}

function onPick(key) {
  setPressed(key);
  locate(modeOf(key));
}

function onManualSearch(ev) {
  ev.preventDefault();
  const key = $('m-hazard').value;
  if (!key) { $('m-hazard').focus(); return; }
  setPressed(key);
  const m = modeOf(key);
  let pool = filterFacilities(data.facilities, m);
  const q = $('query').value.trim();
  const d = $('district').value;
  if (d) pool = pool.filter((f) => f.district === d);
  if (q) pool = searchFacilities(pool, q);
  $('locate-state').replaceChildren();
  const cond = [q && `「${q}」`, d && districtName(d)].filter(Boolean).join('・') || t('shelters.all', 'すべて');
  showResults(pool.map((f) => ({ facility: f, distanceM: null })), t('shelters.manualSummaryLine', '{mode}：{cond} {n}件（住所順）', { mode: modeLabel(m), cond, n: pool.length }), { m });
}

async function main() {
  await ready;
  let savedAt = null;
  try {
    const r = await fetchJson('data/shelters.json');
    if (!r.data || !Array.isArray(r.data.facilities) || !Array.isArray(r.data.hazards)) throw new Error('形式が不正です');
    data = r.data;
    savedAt = r.savedAt;
  } catch {
    const box = $('data-state');
    box.className = 'notice danger';
    box.replaceChildren(
      el('p', {}, el('strong', {}, t('shelters.loadFailed', '避難先データを読み込めませんでした。')), navigator.onLine ? '' : t('shelters.loadFailedOffline', '（オフラインで、端末に保存されたデータもありません。初めて開く前は保存されていません）')),
      el('p', {}, el('a', { href: CITY_LIST_URL, rel: 'noopener' }, t('link.cityShelterList', '藤沢市の避難先一覧')), ' ', t('shelters.loadFailedAfter', 'で公式の一覧を確認してください。')));
    return;
  }
  renderDataState(savedAt);
  renderSourceInfo();
  buildUi();
  $('search-form').addEventListener('submit', onManualSearch);
  $('more-btn').addEventListener('click', showMore);

  // ?hazard=flood のように種別を指定して開かれた場合は選択済みにし、&go=1 ならすぐ現在地から探す
  const params = new URLSearchParams(location.search);
  const param = params.get('hazard');
  if (param) {
    if (document.getElementById(`hz-${param}`)) {
      setPressed(param);
      if (params.get('go') === '1') {
        params.delete('go');
        history.replaceState(null, '', `${location.pathname}?${params}${location.hash}`);
        locate(modeOf(param));
      }
    } else {
      $('locate-state').replaceChildren(el('p', { class: 'notice warn' }, t('shelters.unknownHazard', '指定された災害の種類はこのサイトのデータにありません。ボタンから選ぶか、藤沢市の公式一覧を確認してください。'), ' ',
        el('a', { href: CITY_LIST_URL, rel: 'noopener' }, t('link.cityShelterList', '藤沢市の避難先一覧'))));
      $('results-section').hidden = false;
    }
  }
}
main();
