// 環境ページの描画。数値は textContent でのみ表示する。
import { el, fetchJson, formatDateJa } from './common.js';
import {
  cellValue, cellDiff, shareBin, diffClass, SHARE_COLORS, DIFF_COLORS, SHARE_BINS, DIFF_SMALL, DIFF_LARGE,
  cellCenter, nearestLabel, countByNearestLabel, summarizeDiff, makeProjection,
  airSeries, firstLast, niceMax, lineSegments, waterMatrix,
} from './env-core.js';

const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...children) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v));
  for (const c of children.flat()) if (c != null) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}
const fmt = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : null);
const link = (url, text) => (url ? el('a', { href: url, rel: 'noopener' }, text ?? url) : text);

// 各データ共通の「データの見方」（常に表示）
export function aboutBox({ what, when, scope, cannot, source }) {
  return el('div', { class: 'about' },
    el('h3', {}, 'データの見方'),
    el('dl', {},
      el('dt', {}, '何のデータ？'), el('dd', {}, what),
      el('dt', {}, 'いつの？'), el('dd', {}, when),
      el('dt', {}, 'どの範囲？'), el('dd', {}, scope),
      el('dt', {}, '判断できないこと'), el('dd', {}, el('ul', {}, ...cannot.map((t) => el('li', {}, t)))),
      el('dt', {}, '出典・利用条件'), el('dd', {}, source)));
}

function select(id, label, options, value) {
  return [el('label', { for: id }, label),
    el('select', { id }, ...options.map(([v, t]) => el('option', { value: v, selected: String(v) === String(value) }, t)))];
}

// ===================== 土地被覆 =====================
// 15分類→5区分（scripts/env/landcover_grid.py の GROUPS と同じ。テストで一致を確認）
export const LC_GROUPS = [
  { key: 'built', nameJa: '建物・道路など', codes: [2, 12] },
  { key: 'farm', nameJa: '農地', codes: [3, 4, 14] },
  { key: 'green', nameJa: '樹林・草地', codes: [5, 6, 7, 8, 9, 11] },
  { key: 'water', nameJa: '水域・湿地', codes: [1, 13, 15] },
  { key: 'bare', nameJa: '裸地', codes: [10] },
];

export function renderLandcover(box, d) {
  const versions = d.versions ?? [];
  const years = versions.map((v) => v.version.slice(0, 4));
  const sumPct = (v, codes) => codes.reduce((a, c) => a + ((v.classes ?? []).find((x) => x.code === c)?.pct ?? 0), 0);

  const summary = el('table', {},
    el('caption', { class: 'small' }, '藤沢市全体で各区分が占める割合（%）'),
    el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, '区分'), ...years.map((y) => el('th', { scope: 'col', class: 'num' }, `${y}年`)))),
    el('tbody', {}, ...LC_GROUPS.map((g) => el('tr', {}, el('th', { scope: 'row' }, g.nameJa),
      ...versions.map((v) => el('td', { class: 'num' }, `${fmt(sumPct(v, g.codes))}%`))))));

  const mapArea = el('div', { id: 'lc-map-area' });
  const loadBtn = el('button', { type: 'button', class: 'bigbtn secondary', id: 'lc-load' }, '地図で地域ごとに比べる（約20KBを読み込み）');
  loadBtn.addEventListener('click', async () => {
    loadBtn.disabled = true;
    loadBtn.textContent = '読み込み中…';
    try {
      const { data } = await fetchJson('data/environment/landcover-grid.json');
      if (data.status !== 'ok' || !Array.isArray(data.cells)) throw new Error('bad');
      loadBtn.remove();
      renderGridMap(mapArea, data);
    } catch {
      loadBtn.disabled = false;
      loadBtn.textContent = '地図で地域ごとに比べる（再試行）';
      mapArea.replaceChildren(el('p', { class: 'notice warn' }, '地図のデータを読み込めませんでした。'));
    }
  });

  const s = d.source ?? {};
  box.replaceChildren(
    el('p', {}, '衛星画像を自動で分類した地図（JAXA）で、藤沢市の土地が「建物・道路など」「農地」「樹林・草地」などのどれに分類されたかを、2020・2022・2024年で比べます。'),
    el('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '市全体の割合の表' }, summary),
    el('p', { class: 'small' }, (() => {
      const maxDiff = Math.max(...LC_GROUPS.map((g) => { const v = versions.map((x) => sumPct(x, g.codes)); return Math.max(...v) - Math.min(...v); }));
      return `市全体では、どの区分も年ごとの差は最大${fmt(maxDiff)}ポイントです。この程度の差では、実際の変化と分類のゆらぎ（誤分類）を区別できません。`;
    })()),
    loadBtn, mapArea,
    aboutBox({
      what: '人工衛星の画像をJAXAが自動で15分類に分けた「土地被覆」を、当サイトで5区分にまとめたもの。土地の用途（住宅地・商業地などの指定）や所有ではありません。',
      when: `${years.join('・')}年（各年1年分の画像から分類。季節の違いは平均化）。取得日 ${formatDateJa(versions[0]?.retrievedAt)}`,
      scope: '藤沢市域。地図は地域メッシュの約250m四方（南北約231m×東西約285m）ごとの割合で、市域が区画の25%未満の区画は表示しません。1区画は約500画素（1画素 約10m）の分類結果です。',
      cannot: [
        '年ごとの差には分類のゆらぎが含まれます。5ポイント未満の差は色を付けず「差が小さい」としています。それ以上の差でも、実際に変わったかは現地や他の資料で確かめる必要があります。',
        '変化の原因（開発・耕作の変化・造成など）や、気温・生きものへの影響は、このデータからは分かりません。「環境が良く／悪くなった」とは判断できません。',
        '2022年版は作り方が一部異なり（JAXAの説明による）、2020・2024年版と完全に同じ条件の比較ではありません。',
        '公表されている分類の精度（約93〜96%）は日本全体の値で、藤沢市内の精度は示されていません。',
      ],
      source: el('span', {}, link(s.productUrl ?? s.url, s.name), '（', link(s.termsUrl, 'JAXA 研究データ等の利用条件'), '。出所表示が必要、商用利用は事前連絡）。', s.attribution ?? '',
        ' 市の境界：', link(d.boundary?.url, '国土数値情報 行政区域データ'), '（CC BY 4.0）。'),
    }),
    renderLandcoverDetails(d),
  );
}

function renderLandcoverDetails(d) {
  const versions = d.versions ?? [];
  const years = versions.map((v) => v.version.slice(0, 4));
  const rows = (d.classes ?? []).map((c) => ({ c, vals: versions.map((v) => (v.classes ?? []).find((x) => x.code === c.code)) }))
    .filter((r) => r.vals.some((x) => x?.areaKm2 > 0))
    .sort((a, b) => (b.vals.at(-1)?.areaKm2 ?? 0) - (a.vals.at(-1)?.areaKm2 ?? 0));
  const table = el('table', { class: 'small' },
    el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, '分類'), ...years.map((y) => el('th', { scope: 'col', class: 'num' }, `${y}年`)))),
    el('tbody', {}, ...rows.map(({ c, vals }) => el('tr', {}, el('th', { scope: 'row' }, c.nameJa),
      ...vals.map((x) => el('td', { class: 'num' }, typeof x?.pct === 'number' ? (x.pct > 0 && x.pct < 0.05 ? '0.1%未満' : `${fmt(x.pct)}%`) : '不明'))))));
  const maps = el('details', {}, el('summary', {}, `元の15分類の概観図（画像${versions.length}枚・各約7KB）`));
  let loaded = false;
  maps.addEventListener('toggle', () => {
    if (!maps.open || loaded) return;
    loaded = true;
    for (const v of versions) {
      if (!v.map?.file) continue;
      const w = v.map.widthPx; const h = Math.round(v.map.heightPx * (v.map.pixelAspectHW ?? 1));
      maps.append(el('figure', {},
        el('img', { src: `data/environment/${v.map.file}`, width: w, height: h, style: `width:100%;max-width:${w * 1.5}px;height:auto;image-rendering:pixelated`, alt: `${v.version.slice(0, 4)}年の15分類の概観図（色は下の表と同じJAXAの凡例）` }),
        el('figcaption', { class: 'small' }, `${v.version.slice(0, 4)}年（約40m四方に縮小した概観。細部は正確ではありません）`)));
    }
  });
  return el('details', {}, el('summary', {}, '15分類ごとの市全体の割合と概観図'),
    el('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '15分類の表' }, table),
    el('p', { class: 'small' }, '0.1km²未満の分類は誤分類の影響を受けやすいため、有無や増減の判断に使わないでください。'),
    maps,
    el('ul', { class: 'small' }, ...(d.limitations ?? []).map((t) => el('li', {}, t))));
}

function renderGridMap(area, grid) {
  const years = grid.years;
  const state = { group: 2, mode: 'share', year: years.at(-1), from: years[0], to: years.at(-1), selected: null };
  const proj = makeProjection(grid, 1000);
  const groupOpts = grid.groups.map((g, i) => [i, g.nameJa]);

  const controls = el('div', { class: 'controls' },
    ...select('lc-group', '区分', groupOpts, state.group),
    el('fieldset', { class: 'radio-list inline' }, el('legend', {}, '表示'),
      el('label', { for: 'lc-mode-share' }, el('input', { type: 'radio', name: 'lc-mode', id: 'lc-mode-share', value: 'share', checked: true }), 'ある年の割合'),
      el('label', { for: 'lc-mode-diff' }, el('input', { type: 'radio', name: 'lc-mode', id: 'lc-mode-diff', value: 'diff' }), '2つの年の差')),
    el('div', { id: 'lc-year-wrap' }, ...select('lc-year', '年', years.map((y) => [y, `${y}年`]), state.year)),
    el('div', { id: 'lc-diff-wrap', hidden: true }, el('div', { class: 'row2' },
      el('div', {}, ...select('lc-from', '比べる年（前）', years.map((y) => [y, `${y}年`]), state.from)),
      el('div', {}, ...select('lc-to', '比べる年（後）', years.map((y) => [y, `${y}年`]), state.to)))));

  const cellsG = svg('g', { 'shape-rendering': 'crispEdges' });
  const rects = grid.cells.map(([row, col], i) => {
    const r = svg('rect', {
      x: fmt(proj.x(col / grid.grid.colsPerDeg), 2), y: fmt(proj.y((row + 1) / grid.grid.rowsPerDeg), 2),
      width: fmt(proj.cellW + 0.3, 2), height: fmt(proj.cellH + 0.3, 2), 'data-i': i,
    });
    cellsG.append(r);
    return r;
  });
  const outline = svg('g', { fill: 'none', stroke: '#222', 'stroke-width': 3 },
    ...(grid.outline ?? []).map((ring) => svg('path', { d: `M${ring.map(([lon, lat]) => `${fmt(proj.x(lon), 1)},${fmt(proj.y(lat), 1)}`).join('L')}Z` })));
  const labels = svg('g', { 'font-size': 30, 'font-weight': 700, 'text-anchor': 'middle', fill: '#111', stroke: '#fff', 'stroke-width': 7, 'paint-order': 'stroke' },
    ...(grid.labels ?? []).map((l) => svg('text', { x: fmt(proj.x(l.lon), 1), y: fmt(proj.y(l.lat), 1) }, l.name)));
  const highlight = svg('rect', { fill: 'none', stroke: '#000', 'stroke-width': 6, visibility: 'hidden' });
  const map = svg('svg', { viewBox: `0 0 ${proj.width} ${proj.height}`, class: 'gridmap', role: 'img', 'aria-labelledby': 'lc-map-title', id: 'lc-map' },
    svg('title', { id: 'lc-map-title' }, '藤沢市の約250m区画ごとの土地被覆の地図（内容は地図の下の文章と表でも説明しています）'),
    cellsG, outline, labels, highlight);

  const legend = el('div', { class: 'legend', id: 'lc-legend' });
  const info = el('div', { class: 'cell-info', id: 'lc-cell', 'aria-live': 'polite' }, el('p', { class: 'small muted' }, '地図の区画をタップすると、その区画の内訳を表示します。'));
  const text = el('div', { id: 'lc-summary', 'aria-live': 'polite' });

  function draw() {
    const g = state.group;
    rects.forEach((r, i) => {
      let color;
      if (state.mode === 'share') {
        const b = shareBin(cellValue(grid, state.year, g, i));
        color = b == null ? 'url(#none)' : SHARE_COLORS[b];
      } else {
        const c = diffClass(cellDiff(grid, state.from, state.to, g, i));
        color = c == null ? '#ffffff' : DIFF_COLORS[c];
      }
      r.setAttribute('fill', color === 'url(#none)' ? '#ffffff' : color);
    });
    renderLegend();
    renderSummary();
    if (state.selected != null) showCell(state.selected);
  }

  function renderLegend() {
    const name = grid.groups[state.group].nameJa;
    const sw = (color, t) => el('li', {}, el('span', { class: 'swatch', style: `background:${color}` }), t);
    if (state.mode === 'share') {
      const edges = [0, ...SHARE_BINS, 100];
      legend.replaceChildren(el('p', { class: 'small' }, `${state.year}年：区画のうち「${name}」に分類された割合`),
        el('ul', {}, ...SHARE_COLORS.map((c, k) => sw(c, `${edges[k]}〜${k === SHARE_COLORS.length - 1 ? 100 : edges[k + 1] - 1}%`))));
    } else {
      legend.replaceChildren(el('p', { class: 'small' }, `${state.from}年→${state.to}年：「${name}」の割合の差（ポイント）`),
        el('ul', {},
          sw(DIFF_COLORS.largeDown, `${DIFF_LARGE}以上減`), sw(DIFF_COLORS.down, `${DIFF_SMALL}〜${DIFF_LARGE - 1}減`),
          sw(DIFF_COLORS.small, `差が${DIFF_SMALL}未満（誤差の範囲の可能性）`),
          sw(DIFF_COLORS.up, `${DIFF_SMALL}〜${DIFF_LARGE - 1}増`), sw(DIFF_COLORS.largeUp, `${DIFF_LARGE}以上増`)));
    }
  }

  function places(indices) {
    const top = countByNearestLabel(grid, indices).slice(0, 3);
    return top.length ? `（多いのは ${top.map(([n, c]) => `${n}市民センター付近 ${c}区画`).join('、')}）` : '';
  }

  function renderSummary() {
    const name = grid.groups[state.group].nameJa;
    const n = grid.cells.length;
    if (state.mode === 'share') {
      const vals = grid.cells.map((_, i) => cellValue(grid, state.year, state.group, i));
      const high = vals.map((v, i) => (v != null && v >= 50 ? i : -1)).filter((i) => i >= 0);
      text.replaceChildren(el('p', {}, `${state.year}年、表示中の${n}区画のうち「${name}」が半分以上を占める区画は${high.length}区画${places(high)}。`));
    } else {
      if (state.from === state.to) { text.replaceChildren(el('p', {}, '異なる2つの年を選んでください。')); return; }
      const s = summarizeDiff(grid, state.from, state.to, state.group);
      text.replaceChildren(
        el('p', {}, `${state.from}年→${state.to}年で「${name}」の割合が${DIFF_SMALL}ポイント以上増えた区画は${s.up.length}、減った区画は${s.down.length}${s.down.length ? places(s.down) : ''}、差が${DIFF_SMALL}ポイント未満の区画は${s.small.length}です。`),
        el('p', { class: 'small' }, '色の付いた区画は「分類の結果が変わった」区画です。実際に土地の状態が変わったか、分類のゆらぎかは、このデータだけでは区別できません。'));
    }
  }

  function showCell(i) {
    state.selected = i;
    const [row, col, inside] = grid.cells[i];
    const c = cellCenter(grid, i);
    const near = nearestLabel(grid.labels, c);
    highlight.setAttribute('x', fmt(proj.x(col / grid.grid.colsPerDeg), 2));
    highlight.setAttribute('y', fmt(proj.y((row + 1) / grid.grid.rowsPerDeg), 2));
    highlight.setAttribute('width', fmt(proj.cellW, 2));
    highlight.setAttribute('height', fmt(proj.cellH, 2));
    highlight.setAttribute('visibility', 'visible');
    info.replaceChildren(
      el('p', {}, el('strong', {}, near ? `${near.name}市民センターから約${near.km.toFixed(1)}kmの区画` : '選んだ区画'),
        el('span', { class: 'small muted' }, `（地域メッシュ ${meshCode(row, col)}、市域内 ${inside}%）`)),
      el('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '選んだ区画の内訳' },
        el('table', { class: 'small' },
          el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, '区分'), ...years.map((y) => el('th', { scope: 'col', class: 'num' }, `${y}年`)))),
          el('tbody', {}, ...grid.groups.map((g, gi) => el('tr', { class: gi === state.group ? 'hl' : null }, el('th', { scope: 'row' }, g.nameJa),
            ...years.map((y) => { const v = cellValue(grid, y, gi, i); return el('td', { class: 'num' }, v == null ? '欠測' : `${v}%`); })))))));
  }

  map.addEventListener('click', (ev) => {
    const t = ev.target.closest('rect[data-i]');
    if (t) showCell(Number(t.getAttribute('data-i')));
  });

  area.replaceChildren(controls, legend, el('div', { class: 'map-wrap' }, map),
    el('p', { class: 'small muted' }, '地区名は、各市民センターの位置に表示した目安です（地区の境界ではありません）。太線は市の境界です。'),
    info, text);

  area.querySelector('#lc-group').addEventListener('change', (e) => { state.group = Number(e.target.value); draw(); });
  area.querySelector('#lc-year').addEventListener('change', (e) => { state.year = e.target.value; draw(); });
  area.querySelector('#lc-from').addEventListener('change', (e) => { state.from = e.target.value; draw(); });
  area.querySelector('#lc-to').addEventListener('change', (e) => { state.to = e.target.value; draw(); });
  for (const r of area.querySelectorAll('input[name="lc-mode"]')) {
    r.addEventListener('change', (e) => {
      state.mode = e.target.value;
      area.querySelector('#lc-year-wrap').hidden = state.mode !== 'share';
      area.querySelector('#lc-diff-wrap').hidden = state.mode !== 'diff';
      draw();
    });
  }
  draw();
}

// 1/4 細分区画の地域メッシュコード（scripts/env/landcover_grid.py の mesh_code と同じ計算）
export function meshCode(row, col) {
  const [p, r1] = [Math.floor(row / 320), row % 320];
  const [u, c1] = [Math.floor(col / 320), col % 320];
  const [q, r2] = [Math.floor(r1 / 40), r1 % 40];
  const [v, c2] = [Math.floor(c1 / 40), c1 % 40];
  const [r, r3] = [Math.floor(r2 / 4), r2 % 4];
  const [w, c3] = [Math.floor(c2 / 4), c2 % 4];
  const half = Math.floor(r3 / 2) * 2 + Math.floor(c3 / 2) + 1;
  const quarter = (r3 % 2) * 2 + (c3 % 2) + 1;
  return `${String(p).padStart(2, '0')}${String(u - 100).padStart(2, '0')}${q}${v}${r}${w}${half}${quarter}`;
}

// ===================== 大気 =====================
const STATION_STYLE = [
  { color: '#0072B2', marker: 'circle' }, { color: '#D55E00', marker: 'square' },
  { color: '#009E73', marker: 'triangle' }, { color: '#CC79A7', marker: 'diamond' },
];
const ROADSIDE_STYLE = { color: '#333333', marker: 'square', dash: '8 5' };

function markerPath(kind, x, y, s = 5) {
  switch (kind) {
    case 'square': return `M${x - s},${y - s}h${2 * s}v${2 * s}h${-2 * s}Z`;
    case 'triangle': return `M${x},${y - s * 1.2}L${x + s * 1.1},${y + s * 0.8}L${x - s * 1.1},${y + s * 0.8}Z`;
    case 'diamond': return `M${x},${y - s * 1.3}L${x + s * 1.3},${y}L${x},${y + s * 1.3}L${x - s * 1.3},${y}Z`;
    default: return `M${x - s},${y}a${s},${s} 0 1,0 ${2 * s},0a${s},${s} 0 1,0 ${-2 * s},0`;
  }
}

export function renderAir(box, d) {
  const stations = d.stations ?? [];
  const general = stations.filter((s) => s.type === '一般局');
  const roadside = stations.filter((s) => s.type !== '一般局');
  const styleOf = (name) => {
    const gi = general.findIndex((s) => s.name === name);
    return gi >= 0 ? STATION_STYLE[gi % STATION_STYLE.length] : ROADSIDE_STYLE;
  };
  const short = (n) => n.replace(/^藤沢市(?!役所)/, '');
  const allYears = [...new Set((d.series ?? []).map((s) => s.fiscalYear))].sort((a, b) => a - b);
  const state = { item: (d.items ?? [])[0]?.code, from: allYears[0], to: allYears.at(-1), on: new Set(general.map((s) => s.name)) };

  const checks = (list, title, note) => el('fieldset', { class: 'radio-list' }, el('legend', {}, title),
    note ? el('p', { class: 'small muted' }, note) : null,
    ...list.map((s) => {
      const id = `air-st-${stations.indexOf(s)}`;
      const st = styleOf(s.name);
      return el('label', { for: id }, el('input', { type: 'checkbox', id, value: s.name, checked: state.on.has(s.name) }),
        el('span', { class: 'swatch line', style: `border-top:3px ${st.dash ? 'dashed' : 'solid'} ${st.color}` }), short(s.name));
    }));

  const controls = el('div', { class: 'controls' },
    ...select('air-item', '項目', (d.items ?? []).map((i) => [i.code, `${i.nameJa}（${i.code}）`]), state.item),
    el('div', { class: 'row2' },
      el('div', {}, ...select('air-from', '期間（から）', allYears.map((y) => [y, `${y}年度`]), state.from)),
      el('div', {}, ...select('air-to', '期間（まで）', allYears.map((y) => [y, `${y}年度`]), state.to))),
    checks(general, '一般環境大気測定局（住宅地などの一般的な環境）'),
    checks(roadside, '自動車排出ガス測定局（交通量の多い道路沿い）', '一般局とは設置の目的が違うため、同じ高さで比べないでください（グラフでは破線）。'));
  const chartBox = el('div', { class: 'chart', id: 'air-chart' });
  const findings = el('div', { id: 'air-findings', 'aria-live': 'polite' });
  const tableBox = el('details', {}, el('summary', {}, 'グラフの数値（表）'));

  function draw() {
    const item = (d.items ?? []).find((i) => i.code === state.item);
    const from = Math.min(state.from, state.to); const to = Math.max(state.from, state.to);
    const shown = stations.filter((s) => state.on.has(s.name));
    const series = shown.map((s) => ({ station: s, pts: airSeries(d, state.item, s.name, from, to) }))
      .filter((x) => x.pts.some((p) => p.measured));
    const years = [...new Set(series.flatMap((x) => x.pts.map((p) => p.year)))].sort((a, b) => a - b);
    const max = niceMax(Math.max(0, ...series.flatMap((x) => x.pts.map((p) => p.value ?? 0))));
    const W = 360; const H = 230; const L = 48; const R = 18; const T = 14; const B = 34;
    const xs = (y) => (years.length < 2 ? L + (W - L - R) / 2 : L + ((y - years[0]) / (years.at(-1) - years[0])) * (W - L - R));
    const ys = (v) => T + (1 - v / max) * (H - T - B);
    const digits = item?.unit === 'µg/m³' ? 1 : 3;
    const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-labelledby': 'air-chart-title', class: 'linechart' },
      svg('title', { id: 'air-chart-title' }, `${item?.nameJa}の${item?.metric}の推移（${from}〜${to}年度）。数値はグラフの下の表にもあります。`));
    for (let k = 0; k <= 4; k++) {
      const v = (max * k) / 4;
      g.append(svg('line', { x1: L, x2: W - R, y1: ys(v), y2: ys(v), stroke: 'currentColor', 'stroke-opacity': k ? 0.15 : 0.5 }),
        svg('text', { x: L - 4, y: ys(v) + 4, 'text-anchor': 'end', 'font-size': 10, fill: 'currentColor' }, fmt(v, digits)));
    }
    const step = years.length > 7 ? 2 : 1;
    years.forEach((y, k) => { if (k % step === 0 || k === years.length - 1) g.append(svg('text', { x: xs(y), y: H - B + 16, 'text-anchor': 'middle', 'font-size': 10, fill: 'currentColor' }, String(y))); });
    g.append(svg('text', { x: L, y: 10, 'font-size': 10, fill: 'currentColor' }, item?.unit ?? ''));
    g.append(svg('text', { x: W - R, y: H - 4, 'text-anchor': 'end', 'font-size': 10, fill: 'currentColor' }, '年度'));
    for (const { station, pts } of series) {
      const st = styleOf(station.name);
      for (const seg of lineSegments(pts)) {
        g.append(svg('polyline', { points: seg.map((p) => `${fmt(xs(p.year), 1)},${fmt(ys(p.value), 1)}`).join(' '), fill: 'none', stroke: st.color, 'stroke-width': 2.5, 'stroke-dasharray': st.dash ?? null }));
        for (const p of seg) g.append(svg('path', { d: markerPath(st.marker, xs(p.year), ys(p.value), 3.5), fill: st.color }));
      }
      // 欠測等（測定はしたが評価基準未満）は × で示す
      for (const p of pts.filter((q) => q.measured && q.value == null)) {
        g.append(svg('text', { x: xs(p.year), y: H - B - 4, 'text-anchor': 'middle', 'font-size': 12, fill: st.color }, '×'));
      }
    }
    chartBox.replaceChildren(g,
      el('p', { class: 'small muted' }, `${item?.nameJa}：${item?.metric}（${item?.unit}）。× は測定時間・日数が評価の基準に満たず値を示していない年度（0ではありません）。線が途切れているところも同じです。`));

    // 言えること：各局の、期間内で値がある最初と最後の年度の比較（事実のみ）
    const lines = series.map(({ station, pts }) => {
      const fl = firstLast(pts);
      if (!fl) return el('li', {}, `${short(station.name)}：比べられる年度が2つ未満です。`);
      const word = { down: '低い値になっています', up: '高い値になっています', flat: 'ほぼ同じ（差が5%未満）です' }[fl.direction];
      return el('li', {}, `${short(station.name)}：${fl.from.year}年度 ${fmt(fl.from.value, digits)} → ${fl.to.year}年度 ${fmt(fl.to.value, digits)} ${item?.unit}。${word}。`);
    });
    findings.replaceChildren(
      el('h3', {}, 'このグラフから言えること'),
      lines.length ? el('ul', {}, ...lines) : el('p', {}, '表示する測定局を選んでください。'),
      el('h3', {}, '言えないこと'),
      el('ul', {},
        el('li', {}, '値が変わった原因（工場や車の排出量、交通量、気象、ほかの地域から運ばれてくる汚染など）は、このデータからは分かりません。'),
        el('li', {}, '健康への影響や、環境基準を満たしているかどうか（年平均値は基準の判定に使う指標ではありません）。'),
        el('li', {}, '測定局のない場所の空気の状態。各局は1地点の値です。'),
        state.item === 'Ox' ? el('li', {}, '光化学オキシダントは、神奈川県内のすべての測定局で環境基準（1時間値0.06ppm以下）を達成していない状態が続いています（県の資料による）。') : null));

    tableBox.replaceChildren(el('summary', {}, 'グラフの数値（表）'),
      el('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '大気の数値の表' },
        el('table', { class: 'small' },
          el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, '年度'), ...series.map((x) => el('th', { scope: 'col', class: 'num' }, short(x.station.name))))),
          el('tbody', {}, ...years.slice().reverse().map((y) => el('tr', {}, el('th', { scope: 'row' }, `${y}`),
            ...series.map((x) => { const p = x.pts.find((q) => q.year === y); return el('td', { class: 'num' }, !p?.measured ? '—' : (p.value == null ? '欠測等' : fmt(p.value, digits))); })))))));
  }

  const s1 = d.sources?.[0];
  box.replaceChildren(
    el('p', {}, '市内の測定局で測った大気汚染物質の年平均値が、年度ごとにどう変わってきたかを比べます。'),
    controls, chartBox, findings, tableBox,
    aboutBox({
      what: '大気汚染常時監視測定局で測定された二酸化窒素・浮遊粒子状物質・微小粒子状物質（PM2.5）・光化学オキシダントの年平均値（県の公表値。当サイトで再計算はしていません）。',
      when: `${d.period ?? ''}。取得日 ${formatDateJa(d.retrievedAt)}。最新年度は年報の刊行前の資料によるため、今後修正される場合があります。`,
      scope: `藤沢市内の${stations.length}か所の測定局の地点の値（一般局${general.length}、自排局${roadside.length}）。`,
      cannot: [
        '値の変化の原因、健康への影響、環境基準の達成状況。',
        '一般局と自排局（藤沢橋）の値の優劣。目的が違う局どうしは同列に比べられません。',
        '測定時間・日数が足りない年度の値（「欠測等」とし、0としては扱っていません）。',
      ],
      source: el('span', {}, link(s1?.pageUrl, s1?.name ?? '神奈川県の大気汚染常時監視結果'), ' ほか（', link(d.terms?.url, '神奈川県サイトポリシー'), '：引用など著作権法上認められる範囲で利用し出典を記載。公表された数値を抜粋しています）。'),
    }),
  );
  box.querySelector('#air-item').addEventListener('change', (e) => { state.item = e.target.value; draw(); });
  box.querySelector('#air-from').addEventListener('change', (e) => { state.from = Number(e.target.value); draw(); });
  box.querySelector('#air-to').addEventListener('change', (e) => { state.to = Number(e.target.value); draw(); });
  for (const cb of box.querySelectorAll('input[type=checkbox][id^="air-st-"]')) {
    cb.addEventListener('change', (e) => { if (e.target.checked) state.on.add(e.target.value); else state.on.delete(e.target.value); draw(); });
  }
  draw();
}

// ===================== 水質 =====================
const GRADE_CLASS = { 水質AA: 'g-aa', 水質A: 'g-a', 水質B: 'g-b', 水質C: 'g-c' };

export function renderWater(box, d) {
  const m = waterMatrix(d.records ?? []);
  const md = (iso) => { const [, mo, da] = iso.split('-').map(Number); return `${mo}/${da}`; };
  const dates = (t) => (t?.periodFrom ? `採水 ${md(t.periodFrom)}〜${md(t.periodTo)}のうち${t.days ?? '?'}日` : '採水日不明');
  const table = el('table', { class: 'water' },
    el('caption', { class: 'small' }, '藤沢市内の海水浴場の水質判定（新しい順）。色は判定区分を表し、文字でも示しています。'),
    el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, '年度・検査'), ...m.beaches.map((b) => el('th', { scope: 'col' }, b)))),
    el('tbody', {}, ...m.rows.map((r) => el('tr', {},
      el('th', { scope: 'row' }, `${r.fiscalYear}年度`, el('br'), `第${r.round}回（${r.roundLabel ?? ''}）`, el('br'), el('span', { class: 'small muted' }, dates(r.testDates))),
      ...r.cells.map((c) => (c ? el('td', { class: GRADE_CLASS[c.grade] ?? '' }, el('strong', {}, c.judgement ?? '不明'), el('br'), c.grade ? el('span', { class: 'small' }, c.grade.replace('水質', '水質 ')) : '', el('br'), el('a', { href: c.sourceUrl, rel: 'noopener', class: 'small' }, '出典')) : el('td', {}, '記載なし')))))));

  // 年度ごとの要約（事実のみ）
  const fys = [...new Set((d.records ?? []).map((r) => r.fiscalYear))].sort((a, b) => b - a);
  const summary = fys.map((fy) => {
    const rs = d.records.filter((r) => r.fiscalYear === fy);
    const counts = {};
    for (const r of rs) counts[r.judgementText ?? r.judgement] = (counts[r.judgementText ?? r.judgement] ?? 0) + 1;
    return el('li', {}, `${fy}年度：${Object.entries(counts).map(([k, n]) => `${k} ${n}件`).join('、')}（${rs.length}件中）`);
  });
  const crit = d.criteria?.classes ?? [];
  const s = d.source ?? {};
  box.replaceChildren(
    el('p', {}, '県が毎年、海水浴シーズン前とシーズン中に行う水質検査の判定を、年度・検査の回・海水浴場ごとに比べます。'),
    el('p', { class: 'notice small' }, el('strong', {}, '検査した日の結果です。今日の水質ではありません。'), '雨の後などは変わることがあります。泳げるか・海水浴場が開いているかは、藤沢市や各海水浴場の案内を確認してください。'),
    el('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '水質判定の表' }, table),
    el('h3', {}, '判定の意味'),
    el('ul', { class: 'grade-legend small' },
      el('li', {}, el('span', { class: 'g-aa' }, '適（水質AA・A）'), '：水浴に適している。AA は特に良好'),
      el('li', {}, el('span', { class: 'g-b' }, '可（水質B・C）'), '：水浴に使える（「適」より基準がゆるい区分。遊泳禁止ではありません）'),
      el('li', {}, el('span', {}, '不適'), '：水浴に適さない')),
    crit.length ? el('details', {}, el('summary', {}, '判定基準の数値（環境省の水浴場水質判定基準）'),
      el('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '判定基準の表' }, el('table', { class: 'small' },
        el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, '区分'), el('th', { scope: 'col' }, 'ふん便性大腸菌群数'), el('th', { scope: 'col' }, 'COD'), el('th', { scope: 'col' }, '透明度'), el('th', { scope: 'col' }, '油膜'))),
        el('tbody', {}, ...crit.map((k) => el('tr', {}, el('th', { scope: 'row' }, `${k.judgement}${k.grade ? `（${k.grade}）` : ''}`), el('td', {}, k.fecalColiform), el('td', {}, k.cod), el('td', {}, k.transparency), el('td', {}, k.oilFilm))))))) : null,
    el('h3', {}, 'この表から言えること'),
    el('ul', {}, ...summary),
    aboutBox({
      what: '神奈川県などが行う海水浴場の水質検査の「判定区分」（測定値そのものは発表資料にないため収録していません）。腸管出血性大腸菌O157の検査結果（県の発表文による）。',
      when: `${d.period ?? ''}。各年度2回（シーズン前・シーズン中）、期間内の2日間に1日2回採水。取得日 ${formatDateJa(d.retrievedAt)}。`,
      scope: `藤沢市内の${m.beaches.length}か所の海水浴場（${m.beaches.join('・')}）の採水地点。`,
      cannot: [
        '検査日以外（雨の後など）の水質。今日泳いでよいかどうか。',
        '海水浴場ごとの正確な採水日（県全体の期間しか公表されていません）。',
        '水質が変わった原因。「可」が続いていることだけでは、悪化・改善の傾向とは言えません（判定は2日分の採水に基づく区分です）。',
      ],
      source: el('span', {}, s.attribution ?? '神奈川県 記者発表資料', '（', link(s.termsUrl, '神奈川県サイトポリシー'), '：引用など著作権法上認められる範囲で利用し出典を記載。判定区分を抜粋しています）。各セルの「出典」から発表資料を開けます。'),
    }),
  );
}
