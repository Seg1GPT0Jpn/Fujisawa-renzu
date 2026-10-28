import { initCommon, fetchJson, el, formatDateTimeJa } from './common.js';
import { renderLandcover, renderAir, renderWater } from './env-ui.js';

initCommon();

const SECTIONS = [
  ['landcover', 'data/environment/landcover.json', renderLandcover],
  ['air', 'data/environment/air-quality.json', renderAir],
  ['water', 'data/environment/water-quality.json', renderWater],
];

for (const [id, url, render] of SECTIONS) {
  const box = document.getElementById(`${id}-body`);
  // 該当ページを開いたときに初めて取得する（格子地図の詳細データはさらに「地図」ボタンを押したとき）
  fetchJson(url).then(({ data, savedAt }) => {
    if (data.status !== 'ok' && data.status !== 'partial') {
      box.replaceChildren(el('p', { class: 'notice warn' }, el('strong', {}, 'このデータは未掲載です。'), ` ${data.reason ?? ''}`,
        data.officialUrl ? [' ', el('a', { href: data.officialUrl, rel: 'noopener' }, '公式ページで確認する')] : ''));
      return;
    }
    render(box, data);
    if (savedAt) box.prepend(el('p', { class: 'small notice warn' }, `端末に保存された内容です（保存 ${formatDateTimeJa(savedAt)}）。`));
  }).catch(() => {
    box.replaceChildren(el('p', { class: 'notice warn' }, 'このデータを取得できませんでした。数値は表示していません。', el('a', { href: 'sources.html#environment' }, '出典・データ'), 'を確認してください。'));
  });
}
