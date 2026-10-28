import { initCommon } from './common.js';
import { loadProgress } from './checklist-store.js';

initCommon();

// 備えの進み具合（この端末の保存内容のみ。通信はしない）
const p = loadProgress();
const box = document.getElementById('prepare-progress');
if (box && p && p.total > 0) {
  box.textContent = `この端末の記録：${p.total}項目中 ${p.done}項目を確認済み（最終更新 ${new Date(p.updatedAt).toLocaleDateString('ja-JP')}）`;
}
