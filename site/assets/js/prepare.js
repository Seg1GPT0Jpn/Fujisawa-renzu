import { initCommon, fetchJson, el, t, ready } from './common.js';
import { loadState, saveState, clearState } from './checklist-store.js';

initCommon();

const $ = (id) => document.getElementById(id);
let data = null;
let state = loadState();
let storageOk = true;

function visibleSections() {
  const focus = new Set(state.hazards);
  return [
    ...data.sections,
    ...data.hazardSections.filter((s) => focus.has(s.id)),
    ...data.familySections.filter((s) => focus.has(s.id)),
  ];
}

function visibleItemIds() {
  return visibleSections().flatMap((s) => s.items.map((i) => i.id));
}

function persist() {
  // 表示中の項目に含まれないチェックは数えない（項目を外したときに進捗が合わなくなるのを防ぐ）
  const ids = new Set([...data.sections, ...data.hazardSections, ...data.familySections].flatMap((s) => s.items.map((i) => i.id)));
  state.checked = Object.fromEntries(Object.entries(state.checked).filter(([k]) => ids.has(k)));
  state.total = visibleItemIds().length;
  storageOk = saveState({ checked: state.checked, hazards: state.hazards, total: state.total });
  renderStorageState();
  renderProgress();
}

function renderStorageState() {
  $('storage-state').replaceChildren(storageOk ? '' : el('p', { class: 'notice warn small' },
    t('prepare.noStorage', 'このブラウザでは端末に保存できないため（プライベートブラウズなど）、ページを閉じるとチェックは消えます。')));
}

function renderProgress() {
  const ids = visibleItemIds();
  const done = ids.filter((id) => state.checked[id]).length;
  const pct = ids.length ? Math.round((done / ids.length) * 100) : 0;
  $('progress').replaceChildren(
    el('p', {}, el('strong', {}, t('prepare.progress', '{total}項目中 {done}項目を確認済み', { total: ids.length, done })), `（${pct}%）`),
    el('div', { class: 'bar', 'aria-hidden': 'true' }, el('span', { style: `width:${pct}%` })));
  for (const s of visibleSections()) {
    const n = s.items.filter((i) => state.checked[i.id]).length;
    const c = document.getElementById(`count-${s.id}`);
    if (c) c.textContent = `${n}/${s.items.length}`;
  }
}

function sourceName(id) {
  return data.sources.find((s) => s.id === id)?.name ?? '';
}

function renderSections() {
  const box = $('sections');
  box.replaceChildren(...visibleSections().map((s) => el('fieldset', { class: 'check-section', id: `sec-${s.id}` },
    el('legend', {}, t(`checklist.section.${s.id}`, s.title), ' ', el('span', { class: 'small muted', id: `count-${s.id}` })),
    ...s.items.map((it) => {
      const id = `chk-${it.id}`;
      const input = el('input', { type: 'checkbox', id, checked: !!state.checked[it.id] });
      input.addEventListener('change', () => {
        if (input.checked) state.checked[it.id] = true; else delete state.checked[it.id];
        persist();
      });
      return el('div', { class: 'check-item' },
        el('label', { for: id }, input, el('span', {}, t(`checklist.item.${it.id}`, it.text), it.detail ? el('small', {}, t(`checklist.detail.${it.id}`, it.detail)) : '')),
        el('p', { class: 'small muted src' }, t('prepare.source', '出典：'), el('span', { lang: 'ja' }, sourceName(it.source)),
          it.link ? [' ／ ', el('a', { href: it.link.href, rel: it.link.href.startsWith('http') ? 'noopener' : null }, t(`checklist.link.${it.id}`, it.link.text))] : ''));
    }))));
  renderProgress();
}

function renderFocus() {
  const box = $('focus-options');
  const opts = [...data.hazardSections, ...data.familySections];
  box.replaceChildren(...opts.map((s) => {
    const id = `focus-${s.id}`;
    const input = el('input', { type: 'checkbox', id, value: s.id, checked: state.hazards.includes(s.id) });
    input.addEventListener('change', () => {
      state.hazards = input.checked ? [...new Set([...state.hazards, s.id])] : state.hazards.filter((h) => h !== s.id);
      renderSections();
      persist();
    });
    return el('label', { for: id }, input, el('span', {}, t(`checklist.section.${s.id}`, s.title), s.hint ? el('small', {}, t(`checklist.hint.${s.id}`, s.hint)) : ''));
  }));
}

async function main() {
  await ready;
  try {
    ({ data } = await fetchJson('data/checklist.json'));
    if (!Array.isArray(data?.sections)) throw new Error('bad');
  } catch {
    $('progress').replaceChildren(el('p', { class: 'notice warn' }, t('prepare.loadFailed', 'チェックリストを読み込めませんでした。'), ' ',
      el('a', { href: 'https://www.kantei.go.jp/jp/content/000182715.pdf', rel: 'noopener' }, t('prepare.pdfLink', '首相官邸「災害の『備え』チェックリスト」（PDF）'))));
    return;
  }
  const valid = new Set([...data.hazardSections, ...data.familySections].map((s) => s.id));
  state.hazards = state.hazards.filter((h) => valid.has(h));
  $('sources').replaceChildren(...data.sources.map((s) => el('li', {}, el('a', { href: s.url, rel: 'noopener', lang: 'ja' }, s.name))));
  renderFocus();
  renderSections();
  $('checklist').hidden = false;
  $('reset-btn').addEventListener('click', () => {
    if (!window.confirm(t('prepare.confirmReset', 'この端末に保存したチェックをすべて消しますか？'))) return;
    clearState();
    state = { checked: {}, hazards: [], total: 0, updatedAt: null };
    renderFocus();
    renderSections();
  });
}
main();
