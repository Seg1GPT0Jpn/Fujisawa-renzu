// 環境ページの計算（DOM に依存しない純粋関数。欠測は null のまま扱い、0 にしない）

// ---- 土地被覆の格子 ----
export const SHARE_BINS = [20, 40, 60, 80];          // 割合の区切り（%）
export const DIFF_SMALL = 5;                          // |差| がこれ未満は「差が小さい」（誤差の範囲の可能性）
export const DIFF_LARGE = 15;
export const SHARE_COLORS = ['#f1eef6', '#bdc9e1', '#74a9cf', '#2b8cbe', '#045a8d'];
export const DIFF_COLORS = { largeDown: '#b35806', down: '#f1a340', small: '#e0e0e0', up: '#998ec3', largeUp: '#542788' };

export function cellValue(grid, year, groupIndex, i) {
  const v = grid?.values?.[year]?.[i];
  return Array.isArray(v) && typeof v[groupIndex] === 'number' ? v[groupIndex] : null;
}

export function cellDiff(grid, from, to, groupIndex, i) {
  const a = cellValue(grid, from, groupIndex, i);
  const b = cellValue(grid, to, groupIndex, i);
  return a == null || b == null ? null : b - a;
}

export function shareBin(v) {
  if (v == null) return null;
  let k = 0;
  while (k < SHARE_BINS.length && v >= SHARE_BINS[k]) k += 1;
  return k;
}

export function diffClass(d) {
  if (d == null) return null;
  if (Math.abs(d) < DIFF_SMALL) return 'small';
  if (d <= -DIFF_LARGE) return 'largeDown';
  if (d < 0) return 'down';
  if (d >= DIFF_LARGE) return 'largeUp';
  return 'up';
}

// 区画の中心の緯度経度
export function cellCenter(grid, i) {
  const [row, col] = grid.cells[i];
  return { lat: (row + 0.5) / grid.grid.rowsPerDeg, lon: (col + 0.5) / grid.grid.colsPerDeg };
}

export function distanceKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const x = toRad(b.lon - a.lon) * Math.cos(toRad((a.lat + b.lat) / 2));
  const y = toRad(b.lat - a.lat);
  return Math.sqrt(x * x + y * y) * 6371;
}

export function nearestLabel(labels, p) {
  let best = null;
  for (const l of labels ?? []) {
    const d = distanceKm(p, { lat: l.lat, lon: l.lon });
    if (!best || d < best.km) best = { name: l.name, facility: l.facility, km: d };
  }
  return best;
}

// 条件に合う区画を、近い市民センター（地区名の目安）ごとに数える（多い順）
export function countByNearestLabel(grid, indices) {
  const m = new Map();
  for (const i of indices) {
    const n = nearestLabel(grid.labels, cellCenter(grid, i));
    if (!n) continue;
    m.set(n.name, (m.get(n.name) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

export function summarizeDiff(grid, from, to, groupIndex) {
  const out = { up: [], down: [], small: [], missing: 0 };
  grid.cells.forEach((_, i) => {
    const d = cellDiff(grid, from, to, groupIndex, i);
    if (d == null) out.missing += 1;
    else if (Math.abs(d) < DIFF_SMALL) out.small.push(i);
    else if (d > 0) out.up.push(i);
    else out.down.push(i);
  });
  return out;
}

// 地図の投影（正距円筒図法を緯度で補正。区画の大きさを見るための簡易なもの）
export function makeProjection(grid, width = 1000) {
  let minLat = Infinity; let maxLat = -Infinity; let minLon = Infinity; let maxLon = -Infinity;
  for (const ring of grid.outline ?? []) for (const [lon, lat] of ring) {
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat); minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
  }
  if (!Number.isFinite(minLat)) {
    for (let i = 0; i < grid.cells.length; i++) {
      const c = cellCenter(grid, i);
      minLat = Math.min(minLat, c.lat); maxLat = Math.max(maxLat, c.lat); minLon = Math.min(minLon, c.lon); maxLon = Math.max(maxLon, c.lon);
    }
  }
  const k = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  const scale = width / ((maxLon - minLon) * k);
  const height = (maxLat - minLat) * scale;
  return {
    width, height: Math.ceil(height),
    x: (lon) => (lon - minLon) * k * scale,
    y: (lat) => (maxLat - lat) * scale,
    cellW: (1 / grid.grid.colsPerDeg) * k * scale,
    cellH: (1 / grid.grid.rowsPerDeg) * scale,
  };
}

// ---- 大気 ----
export function airSeries(data, item, station, from = -Infinity, to = Infinity) {
  const years = [...new Set((data.series ?? []).filter((s) => s.item === item).map((s) => s.fiscalYear))]
    .filter((y) => y >= from && y <= to).sort((a, b) => a - b);
  return years.map((y) => {
    const s = (data.series ?? []).find((x) => x.item === item && x.station === station && x.fiscalYear === y);
    // 未測定（系列なし）は undefined ではなく missing:true、評価基準未満（null）は value:null
    return { year: y, value: s && typeof s.value === 'number' ? s.value : null, note: s?.note ?? (s ? null : '未測定'), measured: !!s };
  });
}

export function firstLast(series) {
  const valid = series.filter((p) => p.value != null);
  if (valid.length < 2) return null;
  const a = valid[0]; const b = valid[valid.length - 1];
  const rel = (b.value - a.value) / a.value;
  const direction = Math.abs(rel) < 0.05 ? 'flat' : (rel < 0 ? 'down' : 'up');
  return { from: a, to: b, rel, direction };
}

export function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

// 欠測（null）で線を区切った区間のリスト
export function lineSegments(points) {
  const segs = [];
  let cur = [];
  for (const p of points) {
    if (p.value == null) { if (cur.length) segs.push(cur); cur = []; } else cur.push(p);
  }
  if (cur.length) segs.push(cur);
  return segs;
}

// ---- 水質 ----
export function waterMatrix(records) {
  const beaches = [...new Set(records.map((r) => r.beach))];
  const keys = [...new Map(records.map((r) => [`${r.fiscalYear}-${r.round}`, { fiscalYear: r.fiscalYear, fiscalYearJa: r.fiscalYearJa, round: r.round, roundLabel: r.roundLabel, testDates: r.testDates }])).values()]
    .sort((a, b) => b.fiscalYear - a.fiscalYear || b.round - a.round);
  return {
    beaches,
    rows: keys.map((k) => ({ ...k, cells: beaches.map((b) => records.find((r) => r.beach === b && r.fiscalYear === k.fiscalYear && r.round === k.round) ?? null) })),
  };
}

export const GRADE_ORDER = ['水質AA', '水質A', '水質B', '水質C'];
