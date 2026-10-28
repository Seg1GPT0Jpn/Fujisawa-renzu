// 環境データの描画（データの状態に応じて正直に表示する。欠測は「欠測」と表示し、0として扱わない）

function fmt(v, digits) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : null;
}

function decimals(values) {
  let d = 0;
  for (const v of values) {
    if (typeof v !== 'number') continue;
    const s = String(v);
    const i = s.indexOf('.');
    if (i >= 0) d = Math.max(d, s.length - i - 1);
  }
  return Math.min(d, 4);
}

function list(el, items, cls = 'small') {
  return items?.length ? el('ul', { class: cls }, ...items.map((t) => el('li', {}, t))) : null;
}

function link(el, url, text) {
  return url ? el('a', { href: url, rel: 'noopener' }, text ?? url) : text;
}

function aboutBlock(el, { sources, terms, attribution, retrievedAt, period, frequency, method, limitations, extra }, formatDateJa) {
  return el('details', {},
    el('summary', {}, '出典・対象期間・加工方法・データの限界'),
    el('dl', { class: 'small' },
      el('dt', {}, '出典'), el('dd', {}, el('ul', {}, ...sources.map((s) => el('li', {}, link(el, s.url, s.name), s.note ? `（${s.note}）` : '')))),
      terms ? [el('dt', {}, '利用条件'), el('dd', {}, terms.summary ?? '', ' ', link(el, terms.url, '利用条件のページ'))] : null,
      attribution ? [el('dt', {}, '出典表記'), el('dd', {}, attribution)] : null,
      retrievedAt ? [el('dt', {}, '取得日'), el('dd', {}, formatDateJa(retrievedAt))] : null,
      period ? [el('dt', {}, '対象期間'), el('dd', {}, period)] : null,
      frequency ? [el('dt', {}, '更新頻度'), el('dd', {}, frequency)] : null,
      el('dt', {}, '更新方法'), el('dd', {}, '自動更新ではありません。保守担当者が取込スクリプトを実行して更新します。'),
      extra ?? null,
    ),
    method?.length ? [el('p', { class: 'small' }, el('strong', {}, '加工方法')), list(el, method)] : null,
    limitations?.length ? [el('p', { class: 'small' }, el('strong', {}, 'データの限界・注意')), list(el, limitations)] : null,
  );
}

export function renderUnavailable(d, { el, formatDateJa }) {
  return [
    el('div', { class: 'notice warn' },
      el('p', {}, el('strong', {}, 'このデータは未掲載です。'), ` ${d.reason ?? ''}`),
      d.officialUrl ? el('p', {}, link(el, d.officialUrl, '公式ページで確認する')) : null),
    d.source ? aboutBlock(el, { sources: [d.source], terms: null, retrievedAt: d.retrievedAt, limitations: d.limitations }, formatDateJa) : null,
  ];
}

export const renderers = {
  landcover(d, { el, formatDateJa }) {
    const out = [];
    const versions = d.versions ?? [];
    const years = versions.map((v) => v.version.slice(0, 4));
    out.push(el('p', {}, '衛星データから土地の状態を分類した地図（JAXA）をもとに、藤沢市域で各分類が占める面積の割合を集計しました。'));
    out.push(el('p', { class: 'notice small' },
      el('strong', {}, '年ごとの差は実際の変化だけでなく、分類のゆらぎ（誤分類）を含みます。'),
      '数値の差だけで「緑が増えた・減った」「環境が良く／悪くなった」とは言えません。0.1km²未満の分類は判断に使わないでください。'));

    const rows = (d.classes ?? []).map((c) => {
      const vals = versions.map((v) => (v.classes ?? []).find((x) => x.code === c.code));
      return { c, vals };
    }).filter((r) => r.vals.some((x) => typeof x?.areaKm2 === 'number' && x.areaKm2 > 0));
    rows.sort((a, b) => (b.vals.at(-1)?.areaKm2 ?? 0) - (a.vals.at(-1)?.areaKm2 ?? 0));

    const table = el('table', {},
      el('caption', { class: 'small' }, `藤沢市域の土地被覆の割合（%）と面積（km²）。市域の画素面積合計 ${fmt(versions[0]?.cityTotalKm2, 2) ?? '不明'} km²`),
      el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, '分類'), ...years.map((y) => el('th', { scope: 'col', class: 'num' }, `${y}年`)))),
      el('tbody', {}, ...rows.map(({ c, vals }) => {
        const small = vals.every((x) => !(typeof x?.areaKm2 === 'number') || x.areaKm2 < 0.1);
        return el('tr', {},
          el('th', { scope: 'row' }, el('span', { 'aria-hidden': 'true', style: `display:inline-block;width:0.9em;height:0.9em;margin-right:4px;border:1px solid currentColor;background:${c.color}` }), c.nameJa, small ? el('span', { class: 'small muted' }, '（0.1km²未満・参考）') : ''),
          ...vals.map((x) => el('td', { class: 'num' },
            typeof x?.pct === 'number' ? (x.pct > 0 && x.pct < 0.05 ? '0.1%未満' : `${fmt(x.pct, 1)}%`) : '不明',
            typeof x?.areaKm2 === 'number' ? el('br') : '', typeof x?.areaKm2 === 'number' ? el('span', { class: 'small muted' }, `${fmt(x.areaKm2, 2)}`) : '')));
      })));
    out.push(el('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '表（横にスクロールできます）' }, table));

    // 地図画像は利用者が開いたときだけ読み込む（通信量削減）
    const maps = el('details', {}, el('summary', {}, `分類地図を表示（画像 ${versions.length} 枚・各約7KB）`));
    let loaded = false;
    maps.addEventListener('toggle', () => {
      if (!maps.open || loaded) return;
      loaded = true;
      for (const v of versions) {
        if (!v.map?.file) continue;
        const w = v.map.widthPx; const hgt = Math.round(v.map.heightPx * (v.map.pixelAspectHW ?? 1));
        maps.append(el('figure', { style: 'margin:12px 0' },
          el('img', { src: `data/environment/${v.map.file}`, width: w, height: hgt, style: `width:100%;max-width:${w * 1.5}px;height:auto;aspect-ratio:${w}/${hgt};image-rendering:pixelated;border:1px solid var(--line)`, alt: `${v.version.slice(0, 4)}年の藤沢市の土地被覆分類図（概観。凡例は上の表の色を参照）` }),
          el('figcaption', { class: 'small' }, `${v.version.slice(0, 4)}年（${v.map.downsample ?? ''}で縮小した概観図。細部は正確ではありません）`)));
      }
    });
    out.push(maps);

    out.push(el('h3', {}, '各年のデータについて'));
    out.push(el('ul', { class: 'small' }, ...versions.map((v) => el('li', {}, `${v.version}：${v.targetPeriod ?? ''}。${v.resolutionNote ?? ''}`, ...(v.notes ?? []).map((n) => ` ${n}`)))));

    const s = d.source ?? {};
    out.push(aboutBlock(el, {
      sources: [
        { name: s.name, url: s.productUrl ?? s.url },
        { name: '配信元（JAXA Earth API）', url: s.distributionUrl, note: s.distributionNote },
        { name: d.boundary?.name, url: d.boundary?.url, note: d.boundary?.license },
      ],
      terms: { url: s.termsUrl, summary: s.termsSummary },
      attribution: s.attribution,
      retrievedAt: versions[0]?.retrievedAt,
      period: years.length ? `${years.join('・')}年（取得できた時点のみ）` : null,
      frequency: 'JAXAの新バージョン公開時（不定期）',
      method: d.method, limitations: d.limitations,
    }, formatDateJa));
    return out;
  },

  'water-quality'(d, { el, formatDateJa }) {
    const out = [];
    out.push(el('p', { class: 'notice small' }, el('strong', {}, '検査日時点の結果です。'), '現在の水質や遊泳の可否をリアルタイムで示すものではありません。海水浴場の開設状況は藤沢市・各海水浴場の案内を確認してください。'));
    if (d.frequency) out.push(el('p', { class: 'small' }, `検査の頻度：${d.frequency}`));
    const recs = [...(d.records ?? [])].sort((a, b) => b.fiscalYear - a.fiscalYear || b.round - a.round || a.beach.localeCompare(b.beach, 'ja'));
    const range = (t) => (t?.periodFrom ? `${formatDateJa(t.periodFrom)}〜${formatDateJa(t.periodTo)}のうち${t.days ?? '?'}日間` : '不明');
    const table = el('table', {},
      el('caption', { class: 'small' }, '藤沢市の海水浴場の水質判定（新しい順）'),
      el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, '年度・回'), el('th', { scope: 'col' }, '海水浴場'), el('th', { scope: 'col' }, '判定'), el('th', { scope: 'col' }, '採水期間（県全体）'), el('th', { scope: 'col' }, 'O157'))),
      el('tbody', {}, ...recs.map((r) => el('tr', {},
        el('td', {}, `${r.fiscalYearJa ?? r.fiscalYear}`, el('br'), `第${r.round}回（${r.roundLabel ?? ''}）`),
        el('td', {}, r.beach),
        el('td', {}, el('strong', {}, r.judgementText ?? r.judgement ?? '不明')),
        el('td', { class: 'small' }, range(r.testDates)),
        el('td', {}, r.o157 ?? '記載なし', ' ', link(el, r.sourceUrl, '出典'))))));
    out.push(el('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '表（横にスクロールできます）' }, table));

    const c = d.criteria;
    if (c?.classes?.length) {
      out.push(el('details', {}, el('summary', {}, '判定基準（環境省の水浴場水質判定基準）'),
        el('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '表（横にスクロールできます）' }, el('table', { class: 'small' },
          el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, '区分'), el('th', { scope: 'col' }, 'ふん便性大腸菌群数'), el('th', { scope: 'col' }, '油膜'), el('th', { scope: 'col' }, 'COD'), el('th', { scope: 'col' }, '透明度'))),
          el('tbody', {}, ...c.classes.map((k) => el('tr', {}, el('th', { scope: 'row' }, `${k.judgement}${k.grade ? `（${k.grade}）` : ''}`), el('td', {}, k.fecalColiform), el('td', {}, k.oilFilm), el('td', {}, k.cod), el('td', {}, k.transparency)))))),
        c.o157 ? el('p', { class: 'small' }, c.o157) : null));
    }
    const s = d.source ?? {};
    out.push(aboutBlock(el, {
      sources: (s.releases ?? []).map((r) => ({ name: `${r.title}（${r.published}）`, url: r.url })),
      terms: { url: s.termsUrl, summary: s.termsSummary },
      attribution: s.attribution, retrievedAt: d.retrievedAt, period: d.period, frequency: d.frequency,
      method: ['県の記者発表資料（PDF）から藤沢市内の海水浴場の判定区分のみを抜き出して整理。測定値は発表資料に掲載がないため収録していない。'],
      limitations: d.notes,
    }, formatDateJa));
    return out;
  },

  'air-quality'(d, { el, formatDateJa }) {
    const out = [];
    out.push(el('p', { class: 'small' }, '藤沢市内の大気汚染常時監視測定局の、県が公表した年平均値（確定値）です。'));
    out.push(el('p', { class: 'notice small' }, el('strong', {}, '自排局（藤沢橋：交通量の多い道路沿い）と一般局は設置目的が違うため、同列に比べないでください。'),
      '年平均値は環境基準の達成判定に使う指標ではありません。各測定局は1地点の値で、市全域や地区を代表しません。'));
    const stations = d.stations ?? [];
    const general = stations.filter((s) => s.type === '一般局');
    const roadside = stations.filter((s) => s.type !== '一般局');
    const short = (n) => n.replace(/^藤沢市/, '');
    for (const it of d.items ?? []) {
      const series = (d.series ?? []).filter((s) => s.item === it.code);
      if (!series.length) continue;
      const cols = [...general, ...roadside].filter((st) => series.some((s) => s.station === st.name));
      const years = [...new Set(series.map((s) => s.fiscalYear))].sort((a, b) => b - a);
      const digits = decimals(series.map((s) => s.value));
      out.push(el('h3', {}, `${it.nameJa}（${it.code}）`));
      out.push(el('p', { class: 'small muted' }, `${it.metric}・単位 ${it.unit}`));
      const table = el('table', {},
        el('caption', { class: 'small' }, `${it.nameJa}の${it.metric}（${it.unit}）。空欄は未測定、「欠測等」は評価基準を満たさない年度。`),
        el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, '年度'), ...cols.map((st) => el('th', { scope: 'col', class: 'num' }, short(st.name), el('br'), el('span', { class: 'small muted' }, st.type))))),
        el('tbody', {}, ...years.map((y) => el('tr', {}, el('th', { scope: 'row' }, `${y}年度`), ...cols.map((st) => {
          const s = series.find((x) => x.station === st.name && x.fiscalYear === y);
          if (!s) return el('td', { class: 'num' }, el('span', { class: 'muted' }, '—'));
          const v = fmt(s.value, digits);
          return el('td', { class: 'num', title: s.note ?? null }, v ?? '欠測等');
        })))));
      out.push(el('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '表（横にスクロールできます）' }, table));
    }
    const notes = (d.series ?? []).filter((s) => s.value === null && s.note);
    if (notes.length) out.push(el('p', { class: 'small' }, '「欠測等」：', notes.map((s) => `${short(s.station)} ${s.item} ${s.fiscalYear}年度（${s.note}）`).join('／')));
    out.push(el('details', {}, el('summary', {}, '測定局の一覧'),
      el('ul', { class: 'small' }, ...stations.map((s) => el('li', {}, `${s.name}（${s.typeJa ?? s.type}）${s.address ?? ''}`)))));
    out.push(aboutBlock(el, {
      sources: (d.sources ?? []).map((s) => ({ name: s.name, url: s.pageUrl ?? s.url ?? s.pdfUrl ?? s.pdfUrls?.at(-1), note: s.covers })),
      terms: d.terms, attribution: d.terms?.attribution, retrievedAt: d.retrievedAt, period: d.period,
      frequency: '年1回（県の年報・速報の公表時）',
      method: d.method, limitations: d.limitations,
    }, formatDateJa));
    return out;
  },
};
