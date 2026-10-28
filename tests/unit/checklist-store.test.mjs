import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadState, saveState, loadProgress, clearState, STORAGE_KEY } from '../../site/assets/js/checklist-store.js';

function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

beforeEach(() => { globalThis.localStorage = fakeStorage(); });

test('保存と読み込み（端末内のみ）', () => {
  assert.equal(loadProgress(), null);
  assert.ok(saveState({ checked: { 'water-3days': true }, hazards: ['tsunami'], total: 20 }, new Date('2026-10-28T00:00:00Z')));
  const s = loadState();
  assert.deepEqual(s.checked, { 'water-3days': true });
  assert.deepEqual(s.hazards, ['tsunami']);
  assert.deepEqual(loadProgress(), { done: 1, total: 20, updatedAt: '2026-10-28T00:00:00.000Z' });
  clearState();
  assert.equal(loadProgress(), null);
});

test('壊れた・不正な保存内容は無視', () => {
  localStorage.setItem(STORAGE_KEY, '{bad');
  assert.deepEqual(loadState().checked, {});
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ checked: { '<script>': true, ok: 'yes', good: true }, hazards: ['x;y', 'flood'], total: -1 }));
  const s = loadState();
  assert.deepEqual(s.checked, { good: true });
  assert.deepEqual(s.hazards, ['flood']);
  assert.equal(s.total, 0);
});

test('保存できない環境（プライベートブラウズ等）でも例外にならない', () => {
  globalThis.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.equal(saveState({ checked: {}, hazards: [], total: 1 }), false);
  assert.deepEqual(loadState().checked, {});
  assert.equal(loadProgress(), null);
});
