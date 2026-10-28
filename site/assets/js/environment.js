import { initCommon, fetchJson, el, formatDateJa, formatDateTimeJa } from './common.js';
import { renderers, renderUnavailable } from './environment-render.js';

initCommon();

for (const box of document.querySelectorAll('[data-dataset]')) {
  const name = box.dataset.dataset;
  // 該当ページを開いたときに初めて取得する
  fetchJson(`data/environment/${name}.json`).then(({ data, savedAt }) => {
    const nodes = data.status === 'ok' || data.status === 'partial'
      ? renderers[name](data, { el, formatDateJa })
      : renderUnavailable(data, { el, formatDateJa });
    box.replaceChildren(...nodes);
    if (savedAt) box.append(el('p', { class: 'small notice warn' }, `端末に保存された内容です（保存 ${formatDateTimeJa(savedAt)}）。`));
  }).catch(() => {
    box.replaceChildren(el('p', { class: 'notice warn' }, 'このデータはまだ用意されていないか、取得できませんでした。数値は表示していません。', el('a', { href: 'sources.html#environment' }, '出典・データ'), 'を確認してください。'));
  });
}
