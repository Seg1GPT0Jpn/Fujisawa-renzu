import { initCommon, t, ready } from './common.js';
import { locale } from './i18n.js';
import { loadProgress } from './checklist-store.js';

initCommon();

// 備えの進み具合（この端末の保存内容のみ。通信はしない）
ready.then(() => {
  const p = loadProgress();
  const box = document.getElementById('prepare-progress');
  if (box && p && p.total > 0) {
    box.textContent = t('home.progress', 'この端末の記録：{total}項目中 {done}項目を確認済み（最終更新 {date}）',
      { total: p.total, done: p.done, date: new Date(p.updatedAt).toLocaleDateString(locale()) });
  }
});
