import { initCommon, fetchJson, el, formatDateTimeJa, getConfig } from './common.js';
import { LEVELS, buildReportPayload, postReport, fetchCrowding, describeSummary } from './crowding-client.js';

initCommon();

const $ = (id) => document.getElementById(id);
const cfg = getConfig();
let facilities = [];
let crowding = null;

function facilityName(id) {
  return facilities.find((f) => f.id === id)?.name ?? '（不明な施設）';
}

function renderSummary() {
  const id = $('facility').value;
  const box = $('facility-summary');
  $('report-form').hidden = !id;
  if (!id) { box.replaceChildren(); return; }
  if (!crowding) {
    box.replaceChildren(el('p', { class: 'notice warn' }, '混雑報告を取得できていません。'));
    return;
  }
  const s = crowding.facilities[id];
  const d = describeSummary(s, crowding.minReportsForSummary);
  box.replaceChildren(el('div', { class: 'card' },
    el('p', {}, el('strong', { text: `利用者報告：${d.headline}` })),
    el('p', { class: 'small' }, d.detail),
    el('p', { class: 'small muted' }, `対象期間：直近${crowding.windowMinutes}分（${formatDateTimeJa(Date.parse(crowding.generatedAt) - crowding.windowMinutes * 60000)} 以降）`,
      el('br'), `最新報告：${s?.latestReportAt ? formatDateTimeJa(s.latestReportAt) : 'なし'}`)));
}

function renderRecent() {
  const box = $('recent-list');
  if (!crowding) { box.replaceChildren(el('p', { class: 'notice warn' }, '混雑報告を取得できませんでした。表示中の内容はありません。')); return; }
  const ids = Object.keys(crowding.facilities).filter((id) => crowding.facilities[id].total > 0);
  if (!ids.length) { box.replaceChildren(el('p', {}, `直近${crowding.windowMinutes}分の報告はありません。`)); return; }
  ids.sort((a, b) => (crowding.facilities[b].latestReportAt ?? '').localeCompare(crowding.facilities[a].latestReportAt ?? ''));
  box.replaceChildren(el('ul', {}, ...ids.map((id) => {
    const s = crowding.facilities[id];
    const d = describeSummary(s, crowding.minReportsForSummary);
    return el('li', {}, el('strong', { text: facilityName(id) }), `：${d.headline}（${d.detail}、最新 ${formatDateTimeJa(s.latestReportAt)}）`);
  })));
}

async function loadCrowding() {
  const state = $('fetched-at');
  if (!navigator.onLine) {
    crowding = null;
    state.textContent = 'オフラインのため最新情報を確認できません。';
  } else {
    try {
      crowding = await fetchCrowding(cfg.crowdingApiBase);
      $('window-min').textContent = String(crowding.windowMinutes);
      state.textContent = `取得時刻：${formatDateTimeJa(crowding.generatedAt)}`;
    } catch {
      crowding = null;
      state.textContent = '混雑報告を取得できませんでした（サーバーに接続できません）。';
    }
  }
  renderRecent();
  renderSummary();
}

function buildFacilitySelect() {
  const sel = $('facility');
  const groups = new Map();
  for (const f of facilities) {
    const g = f.district ? `${f.district}地区` : '地区不明';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(f);
  }
  for (const [g, fs] of groups) {
    sel.append(el('optgroup', { label: g }, ...fs.map((f) => el('option', { value: f.id }, f.name))));
  }
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash && facilities.some((f) => f.id === hash)) sel.value = hash;
  sel.addEventListener('change', () => { $('report-result').replaceChildren(); renderSummary(); });
}

function buildLevelOptions() {
  const box = $('level-options');
  for (const l of LEVELS) {
    const id = `lv-${l.key}`;
    box.append(el('label', { for: id }, el('input', { type: 'radio', name: 'level', id, value: l.key, required: true }), l.label));
  }
  $('report-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const out = $('report-result');
    const level = document.querySelector('input[name="level"]:checked')?.value;
    const facilityId = $('facility').value;
    if (!facilityId || !level) { out.replaceChildren(el('p', { class: 'notice warn' }, '施設と混雑区分を選んでください。')); return; }
    if (!navigator.onLine) { out.replaceChildren(el('p', { class: 'notice danger' }, 'オフラインのため送信できません（報告は保存されていません）。')); return; }
    const btn = $('report-submit');
    btn.disabled = true;
    out.replaceChildren(el('p', {}, '送信中…'));
    const r = await postReport(cfg.crowdingApiBase, buildReportPayload(facilityId, level));
    btn.disabled = false;
    out.replaceChildren(el('p', { class: `notice ${r.ok ? 'ok' : 'danger'}` }, r.message));
    if (r.ok) await loadCrowding();
  });
}

async function main() {
  const state = $('api-state');
  if (!cfg.crowdingApiBase) {
    // 未設定の機能を使えるように見せない：見出しごと小さな1行にする
    const section = $('user-reports');
    section.replaceChildren(el('p', { class: 'small muted', id: 'api-state' },
      '利用者どうしで混雑を報告し合う機能は準備中のため、現在は利用できません（報告の送信・表示は行っていません）。'));
    return;
  }
  try {
    const { data } = await fetchJson('data/shelters.json');
    facilities = data.facilities.filter((f) => !(f.notice && f.notice.type === 'suspended'));
  } catch {
    state.replaceChildren(el('p', { class: 'notice danger' }, '施設一覧を読み込めませんでした。'));
    return;
  }
  state.replaceChildren(cfg.crowdingApiLabel ? el('p', { class: 'notice warn' }, el('strong', { text: cfg.crowdingApiLabel })) : '');
  $('crowding-ui').hidden = false;
  buildFacilitySelect();
  buildLevelOptions();
  $('reload-btn').addEventListener('click', loadCrowding);
  window.addEventListener('online', loadCrowding);
  window.addEventListener('offline', loadCrowding);
  await loadCrowding();
}
main();
