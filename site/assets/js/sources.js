import { initCommon, fetchJson, el, formatDateJa, formatDateTimeJa, daysSince, STALE_DAYS } from './common.js';

initCommon();

const STATUS_LABEL = { ok: '掲載中', partial: '一部掲載', unavailable: '未取得', not_processed: '未処理' };

async function main() {
  const box = document.getElementById('data-status');
  try {
    const { data, savedAt } = await fetchJson('data/status.json');
    const list = el('ul');
    for (const d of data.datasets) {
      const age = daysSince(d.lastCheckedAt);
      list.append(el('li', {},
        el('strong', { text: d.name }), '：', STATUS_LABEL[d.status] ?? d.status,
        d.lastCheckedAt ? `（最終確認 ${formatDateJa(d.lastCheckedAt)}）` : '',
        age != null && age > STALE_DAYS ? el('span', { class: 'small' }, ' ※確認から時間が経っています。公式情報を確認してください。') : ''));
    }
    box.replaceChildren(list);
    if (savedAt) box.append(el('p', { class: 'small' }, `この一覧は端末に保存された内容です（保存 ${formatDateTimeJa(savedAt)}）。`));
  } catch {
    box.replaceChildren(el('p', { class: 'notice warn' }, 'データの更新状況を取得できませんでした。', el('a', { href: 'sources.html' }, '出典・データ'), ' を確認してください。'));
  }
}
main();
