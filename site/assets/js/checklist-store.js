// 防災チェックリストの進み具合を端末内（localStorage）にだけ保存する。サーバーには送らない。
export const STORAGE_KEY = 'fujisawa-lens-checklist-v1';

function storage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function loadState() {
  const s = storage();
  if (!s) return { checked: {}, hazards: [], total: 0, updatedAt: null };
  try {
    const v = JSON.parse(s.getItem(STORAGE_KEY) ?? 'null');
    if (!v || typeof v !== 'object' || typeof v.checked !== 'object' || v.checked === null) throw new Error('empty');
    return {
      checked: Object.fromEntries(Object.entries(v.checked).filter(([k, b]) => /^[a-z0-9-]{1,40}$/.test(k) && b === true)),
      hazards: Array.isArray(v.hazards) ? v.hazards.filter((h) => typeof h === 'string' && /^[a-z_]{1,20}$/.test(h)) : [],
      total: Number.isInteger(v.total) && v.total >= 0 ? v.total : 0,
      updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : null,
    };
  } catch {
    return { checked: {}, hazards: [], total: 0, updatedAt: null };
  }
}

// 保存できたら true。プライベートブラウズ等で保存できない場合は false
export function saveState(state, now = new Date()) {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify({ ...state, updatedAt: now.toISOString() }));
    return true;
  } catch {
    return false;
  }
}

export function clearState() {
  const s = storage();
  try { s?.removeItem(STORAGE_KEY); return true; } catch { return false; }
}

export function loadProgress() {
  const st = loadState();
  if (!st.updatedAt) return null;
  return { done: Object.keys(st.checked).length, total: st.total, updatedAt: st.updatedAt };
}
