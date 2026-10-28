import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  cellValue, cellDiff, shareBin, diffClass, summarizeDiff, airSeries, firstLast, lineSegments, niceMax, waterMatrix, nearestLabel,
} from '../../site/assets/js/env-core.js';

const grid = {
  grid: { rowsPerDeg: 480, colsPerDeg: 320 },
  cells: [[16962, 44636, 100], [16963, 44636, 80], [16964, 44636, 50]],
  values: { 2020: [[70, 10, 20, 0, 0], null, [10, 10, 80, 0, 0]], 2024: [[70, 5, 25, 0, 0], [50, 0, 50, 0, 0], [30, 10, 58, 1, 1]] },
  labels: [{ name: 'A', lat: 35.339, lon: 139.488 }, { name: 'B', lat: 35.5, lon: 139.6 }],
};

test('土地被覆：欠測の区画は null のまま（0にしない）', () => {
  assert.equal(cellValue(grid, '2020', 2, 1), null);
  assert.equal(cellDiff(grid, '2020', '2024', 2, 1), null);
  assert.equal(cellValue(grid, '2020', 2, 0), 20);
  assert.equal(cellValue(grid, '2099', 2, 0), null);
});

test('土地被覆：差が5ポイント未満は「差が小さい」、大きな差は段階分け', () => {
  assert.equal(diffClass(4.9), 'small');
  assert.equal(diffClass(-4), 'small');
  assert.equal(diffClass(5), 'up');
  assert.equal(diffClass(-5), 'down');
  assert.equal(diffClass(15), 'largeUp');
  assert.equal(diffClass(-22), 'largeDown');
  assert.equal(diffClass(null), null);
  assert.deepEqual([0, 19, 20, 59, 80, 100].map(shareBin), [0, 0, 1, 2, 4, 4]);
  assert.equal(shareBin(null), null);
  const s = summarizeDiff(grid, '2020', '2024', 2);
  assert.deepEqual([s.up, s.down, s.small, s.missing], [[0], [2], [], 1]);
});

test('最寄りの地区名の目安', () => {
  assert.equal(nearestLabel(grid.labels, { lat: 35.34, lon: 139.49 }).name, 'A');
  assert.equal(nearestLabel([], { lat: 0, lon: 0 }), null);
});

const air = {
  series: [
    { station: 'X', item: 'PM2.5', fiscalYear: 2015, value: 12 },
    { station: 'X', item: 'PM2.5', fiscalYear: 2016, value: null, note: '有効測定日数不足' },
    { station: 'X', item: 'PM2.5', fiscalYear: 2017, value: 10 },
    { station: 'Y', item: 'PM2.5', fiscalYear: 2017, value: 11 },
  ],
};

test('大気：評価基準未満の年は null、未測定は measured:false（どちらも0にしない）', () => {
  const x = airSeries(air, 'PM2.5', 'X');
  assert.deepEqual(x.map((p) => [p.year, p.value, p.measured]), [[2015, 12, true], [2016, null, true], [2017, 10, true]]);
  const y = airSeries(air, 'PM2.5', 'Y');
  assert.deepEqual(y.map((p) => [p.year, p.value, p.measured]), [[2015, null, false], [2016, null, false], [2017, 11, true]]);
  assert.deepEqual(lineSegments(x).map((s) => s.map((p) => p.year)), [[2015], [2017]], '欠測で線を区切る');
  assert.deepEqual(airSeries(air, 'PM2.5', 'X', 2016, 2017).map((p) => p.year), [2016, 2017]);
});

test('大気：最初と最後の値の比較（原因は述べない）', () => {
  const fl = firstLast(airSeries(air, 'PM2.5', 'X'));
  assert.equal(fl.from.year, 2015);
  assert.equal(fl.to.year, 2017);
  assert.equal(fl.direction, 'down');
  assert.equal(firstLast(airSeries(air, 'PM2.5', 'Y')), null, '値が1つでは比較しない');
  assert.equal(niceMax(0.0172), 0.02);
  assert.equal(niceMax(0), 1);
});

test('水質：年度・回×海水浴場の表（新しい順）、記載のないものは null', () => {
  const recs = [
    { fiscalYear: 2025, round: 1, beach: 'A', judgement: '可' },
    { fiscalYear: 2026, round: 2, beach: 'A', judgement: '可' },
    { fiscalYear: 2026, round: 2, beach: 'B', judgement: '適' },
  ];
  const m = waterMatrix(recs);
  assert.deepEqual(m.beaches, ['A', 'B']);
  assert.deepEqual(m.rows.map((r) => `${r.fiscalYear}-${r.round}`), ['2026-2', '2025-1']);
  assert.equal(m.rows[1].cells[1], null);
});

test('格子データ：形式・割合・null の扱い・区分の定義が画面側と一致', async () => {
  const g = JSON.parse(await readFile(new URL('../../site/data/environment/landcover-grid.json', import.meta.url), 'utf8'));
  const { LC_GROUPS, meshCode } = await import('../../site/assets/js/env-ui.js');
  assert.equal(g.status, 'ok');
  assert.ok(g.cells.length > 900);
  for (const y of g.years) {
    assert.equal(g.values[y].length, g.cells.length);
    for (const v of g.values[y]) {
      if (v === null) continue;
      assert.equal(v.length, g.groups.length);
      const sum = v.reduce((a, b) => a + b, 0);
      assert.ok(sum >= 97 && sum <= 103, `sum=${sum}`);
      assert.ok(v.every((x) => Number.isInteger(x) && x >= 0 && x <= 100));
    }
  }
  assert.deepEqual(g.groups.flatMap((x) => x.jaxaCodes).sort((a, b) => a - b), Array.from({ length: 15 }, (_, i) => i + 1));
  assert.deepEqual(LC_GROUPS.map((x) => [x.key, x.codes]), g.groups.map((x) => [x.key, x.jaxaCodes]));
  assert.ok(/JAXA/.test(g.source.attribution));
  assert.ok(g.labels.length >= 10);
});

test('地域メッシュコード（1/4細分区画）：藤沢駅付近', async () => {
  const { meshCode } = await import('../../site/assets/js/env-ui.js');
  assert.equal(meshCode(Math.floor(35.3389 * 480), Math.floor(139.4877 * 320)), '5339030931');
});
