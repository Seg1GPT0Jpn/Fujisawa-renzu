// 環境データの描画（データの状態に応じて正直に表示する。欠測は「欠測」と表示し、0として扱わない）

function sourceBlock(d, { el, formatDateJa }) {
  const s = d.source ?? {};
  return el('details', {},
    el('summary', {}, '出典・対象期間・データの限界'),
    el('dl', { class: 'small' },
      el('dt', {}, '出典'), el('dd', {}, s.url ? el('a', { href: s.url, rel: 'noopener' }, s.name ?? s.url) : (s.name ?? '不明')),
      s.termsUrl || s.termsSummary ? [el('dt', {}, '利用条件'), el('dd', {}, s.termsSummary ?? '', s.termsUrl ? [' ', el('a', { href: s.termsUrl, rel: 'noopener' }, '利用条件のページ')] : '')] : null,
      s.attribution ? [el('dt', {}, '出典表記'), el('dd', {}, s.attribution)] : null,
      d.retrievedAt ? [el('dt', {}, '取得日'), el('dd', {}, formatDateJa(d.retrievedAt))] : null,
      d.period ? [el('dt', {}, '対象期間'), el('dd', {}, d.period)] : null,
      d.updateFrequency ? [el('dt', {}, '更新頻度'), el('dd', {}, d.updateFrequency)] : null,
      d.processing ? [el('dt', {}, '加工内容'), el('dd', {}, d.processing)] : null,
    ),
    d.limitations?.length ? [el('p', { class: 'small' }, el('strong', {}, 'データの限界')), el('ul', { class: 'small' }, ...d.limitations.map((t) => el('li', {}, t)))] : null,
  );
}

export function renderUnavailable(d, h) {
  const { el } = h;
  return [
    el('div', { class: 'notice warn' },
      el('p', {}, el('strong', {}, 'このデータは未掲載です。'), ` ${d.reason ?? ''}`),
      d.officialUrl ? el('p', {}, el('a', { href: d.officialUrl, rel: 'noopener' }, '公式ページで確認する')) : null),
    sourceBlock(d, h),
  ];
}

function num(v, digits = 1) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : null;
}

export const renderers = {
  landcover(d, h) {
    const { el } = h;
    const out = [];
    out.push(el('p', { class: 'small' }, '衛星データから土地の状態を分類した地図をもとに、藤沢市域で各分類が占める面積の割合を集計しました。分類の違いは「変化」とは限りません（下の注意を参照）。'));
    const classes = d.classes ?? [];
    for (const v of d.versions ?? []) {
      const rows = (v.classes ?? []).filter((c) => typeof c.pct === 'number');
      out.push(el('h3', {}, `${v.version}（対象 ${v.targetPeriod ?? '不明'}、解像度 ${v.resolutionM ?? '不明'} m）`));
      const list = el('div', { role: 'list' });
      for (const c of rows) {
        const meta = classes.find((k) => k.code === c.code) ?? {};
        const pct = Math.max(0, Math.min(100, c.pct));
        list.append(el('div', { class: 'bar-row', role: 'listitem' },
          el('span', {}, meta.nameJa ?? String(c.code)),
          el('span', { class: 'bar', 'aria-hidden': 'true' }, el('span', { style: `width:${pct}%` })),
          el('span', { class: 'num' }, `${num(c.pct)}%`)));
      }
      out.push(list);
      if (v.notes?.length) out.push(el('ul', { class: 'small' }, ...v.notes.map((t) => el('li', {}, t))));
    }
    out.push(sourceBlock(d, h));
    return out;
  },

  'water-quality'(d, h) {
    const { el } = h;
    const out = [];
    if (d.frequencyNote) out.push(el('p', { class: 'small' }, d.frequencyNote));
    out.push(el('p', { class: 'notice small' }, '検査日時点の結果です。現在の水質をリアルタイムで示すものではありません。'));
    const table = el('table', {},
      el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, '海水浴場'), el('th', { scope: 'col' }, '検査'), el('th', { scope: 'col' }, '検査日'), el('th', { scope: 'col' }, '判定'), el('th', { scope: 'col' }, 'O157'))),
      el('tbody', {}, ...(d.records ?? []).map((r) => el('tr', {},
        el('td', {}, r.beach), el('td', {}, r.round ?? '—'), el('td', {}, Array.isArray(r.testDates) ? r.testDates.join('、') : (r.testDates ?? '不明')),
        el('td', {}, r.judgement ?? '不明'), el('td', {}, r.o157 ?? '記載なし')))));
    out.push(el('div', { class: 'table-wrap' }, table));
    if (d.criteria) out.push(el('p', { class: 'small' }, d.criteria));
    out.push(sourceBlock(d, h));
    return out;
  },

  'air-quality'(d, h) {
    const { el } = h;
    const out = [];
    const items = d.items ?? [];
    for (const it of items) {
      const series = (d.series ?? []).filter((s) => s.item === it.code);
      if (!series.length) continue;
      const years = [...new Set(series.map((s) => s.year))].sort();
      const stations = [...new Set(series.map((s) => s.station))];
      out.push(el('h3', {}, `${it.nameJa}（${it.unit}・年平均）`));
      const table = el('table', {},
        el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, '測定局'), ...years.map((y) => el('th', { scope: 'col', class: 'num' }, `${y}年度`)))),
        el('tbody', {}, ...stations.map((st) => {
          const meta = (d.stations ?? []).find((s) => s.name === st);
          return el('tr', {}, el('th', { scope: 'row' }, st, meta?.type ? el('span', { class: 'small muted' }, `（${meta.type}）`) : ''),
            ...years.map((y) => {
              const s = series.find((x) => x.station === st && x.year === y);
              const v = s ? num(s.value, it.digits ?? 3) : null;
              return el('td', { class: 'num' }, v ?? '欠測・対象外');
            }));
        })));
      out.push(el('div', { class: 'table-wrap' }, table));
    }
    if (d.method) out.push(el('p', { class: 'small' }, d.method));
    out.push(sourceBlock(d, h));
    return out;
  },
};
