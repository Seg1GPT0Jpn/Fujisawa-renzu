// 混雑共有APIの中核ロジック（ストレージ非依存。D1 とメモリ実装の両方から使う）
//
// 保存するもの：施設ID・混雑区分・受付時刻のみ（reports）。
// レート制限用に、IPアドレスを「日替わりの秘密ソルト付きHMAC」で不可逆化した値を短時間だけ保存する（rate_events）。
// 生のIPアドレス・位置情報・端末識別子・User-Agent は保存しない。

export const LEVELS = ['empty', 'some', 'crowded', 'unknown'];
export const LEVEL_LABELS = {
  empty: '空いている', some: 'やや混雑', crowded: 'かなり混雑', unknown: 'わからない／確認できない',
};

export const DEFAULTS = {
  windowMinutes: 30,          // 集計対象とする報告の有効期間
  minReportsForSummary: 3,    // これ未満は「情報不足」
  perFacilityCooldownMinutes: 10, // 同じ端末（IP）から同じ施設への再報告を受け付けない時間
  perClientHourlyLimit: 10,   // 同じ端末（IP）から1時間に受け付ける報告数
  globalPerFacilityPerMinute: 30, // 1施設あたり全体で1分間に受け付ける報告数（大量投稿の抑止）
  retentionHours: 24,         // 報告データの保存期間（以降は削除）
  maxBodyBytes: 256,
};

export function readConfig(env = {}) {
  const num = (v, d, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? n : d;
  };
  return {
    windowMinutes: num(env.REPORT_WINDOW_MINUTES, DEFAULTS.windowMinutes, 5, 180),
    minReportsForSummary: num(env.MIN_REPORTS_FOR_SUMMARY, DEFAULTS.minReportsForSummary, 1, 50),
    perFacilityCooldownMinutes: num(env.PER_FACILITY_COOLDOWN_MINUTES, DEFAULTS.perFacilityCooldownMinutes, 1, 120),
    perClientHourlyLimit: num(env.PER_CLIENT_HOURLY_LIMIT, DEFAULTS.perClientHourlyLimit, 1, 100),
    globalPerFacilityPerMinute: num(env.GLOBAL_PER_FACILITY_PER_MINUTE, DEFAULTS.globalPerFacilityPerMinute, 1, 1000),
    retentionHours: num(env.RETENTION_HOURS, DEFAULTS.retentionHours, 1, 168),
    allowedOrigins: String(env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    salt: env.RATE_LIMIT_SECRET ?? '',
  };
}

const ID_RE = /^fjs-[0-9a-f]{10}$/;

// 入力検証：余計なフィールド（位置情報など）が含まれていたら拒否する
export function validateReport(body, facilityIds) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'invalid_body' };
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes('facilityId') || !keys.includes('level')) return { ok: false, error: 'unexpected_fields' };
  const { facilityId, level } = body;
  if (typeof facilityId !== 'string' || !ID_RE.test(facilityId) || !facilityIds.has(facilityId)) return { ok: false, error: 'unknown_facility' };
  if (typeof level !== 'string' || !LEVELS.includes(level)) return { ok: false, error: 'invalid_level' };
  return { ok: true, value: { facilityId, level } };
}

// 集計：有効期間内の報告だけを数え、少数なら断定しない
export function summarize(reports, { now, windowMinutes, minReportsForSummary }) {
  const since = now - windowMinutes * 60000;
  const recent = reports.filter((r) => r.createdAt >= since && r.createdAt <= now + 60000);
  const counts = Object.fromEntries(LEVELS.map((l) => [l, 0]));
  let latest = null;
  for (const r of recent) {
    if (!LEVELS.includes(r.level)) continue;
    counts[r.level] += 1;
    if (latest == null || r.createdAt > latest) latest = r.createdAt;
  }
  const total = LEVELS.reduce((s, l) => s + counts[l], 0);
  const known = counts.empty + counts.some + counts.crowded;
  let status = 'insufficient';
  let leading = null;
  if (total >= minReportsForSummary && known >= minReportsForSummary) {
    const ranked = ['crowded', 'some', 'empty'].map((l) => [l, counts[l]]).sort((a, b) => b[1] - a[1]);
    // 最多区分が過半数を占める場合だけ「多い報告」として示す。拮抗していれば「ばらつきあり」。
    if (ranked[0][1] * 2 > known) { status = 'leading'; leading = ranked[0][0]; } else status = 'mixed';
  }
  return {
    status, leading, counts, total,
    latestReportAt: latest == null ? null : new Date(latest).toISOString(),
    windowMinutes, windowStart: new Date(since).toISOString(), generatedAt: new Date(now).toISOString(),
  };
}

// IPアドレスを日替わりソルトで不可逆化（同一日内のレート制限にのみ使用）
export async function clientKey(ip, salt, now) {
  if (!salt) throw new Error('RATE_LIMIT_SECRET が未設定です');
  const day = new Date(now).toISOString().slice(0, 10);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(`${salt}:${day}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(String(ip ?? 'unknown')));
  return [...new Uint8Array(sig)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  });
}

function corsHeaders(request, cfg) {
  const origin = request.headers.get('Origin');
  if (origin && cfg.allowedOrigins.includes(origin)) {
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' };
  }
  return { Vary: 'Origin' };
}

// store インターフェース：
//   insertReport({facilityId, level, createdAt})
//   listReports(since) -> [{facilityId, level, createdAt}]
//   countRateEvents({clientKey, facilityId?, since}) -> number
//   countFacilityReports({facilityId, since}) -> number
//   insertRateEvent({clientKey, facilityId, createdAt})
//   purge({reportsBefore, rateEventsBefore})
export async function handle(request, { env = {}, store, facilityIds, now = Date.now() }) {
  const cfg = readConfig(env);
  const url = new URL(request.url);
  const cors = corsHeaders(request, cfg);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  if (url.pathname === '/api/health' && request.method === 'GET') {
    return json({ ok: true, windowMinutes: cfg.windowMinutes, minReportsForSummary: cfg.minReportsForSummary }, 200, cors);
  }

  if (url.pathname === '/api/crowding' && request.method === 'GET') {
    const reports = await store.listReports(now - cfg.windowMinutes * 60000);
    const byFacility = new Map();
    for (const r of reports) {
      if (!byFacility.has(r.facilityId)) byFacility.set(r.facilityId, []);
      byFacility.get(r.facilityId).push(r);
    }
    const facilities = {};
    for (const [id, rs] of byFacility) facilities[id] = summarize(rs, { now, ...cfg });
    return json({
      windowMinutes: cfg.windowMinutes, minReportsForSummary: cfg.minReportsForSummary,
      generatedAt: new Date(now).toISOString(), facilities,
    }, 200, cors);
  }

  if (url.pathname === '/api/reports' && request.method === 'POST') {
    const origin = request.headers.get('Origin');
    if (cfg.allowedOrigins.length && (!origin || !cfg.allowedOrigins.includes(origin))) return json({ ok: false, error: 'forbidden_origin' }, 403, cors);
    if (!(request.headers.get('Content-Type') ?? '').startsWith('application/json')) return json({ ok: false, error: 'unsupported_media_type' }, 415, cors);
    const text = await request.text();
    if (text.length > DEFAULTS.maxBodyBytes) return json({ ok: false, error: 'body_too_large' }, 413, cors);
    let body;
    try { body = JSON.parse(text); } catch { return json({ ok: false, error: 'invalid_json' }, 400, cors); }
    const v = validateReport(body, facilityIds);
    if (!v.ok) return json({ ok: false, error: v.error }, 400, cors);

    let key;
    try { key = await clientKey(request.headers.get('CF-Connecting-IP'), cfg.salt, now); } catch { return json({ ok: false, error: 'server_not_configured' }, 503, cors); }

    const sameFacility = await store.countRateEvents({ clientKey: key, facilityId: v.value.facilityId, since: now - cfg.perFacilityCooldownMinutes * 60000 });
    if (sameFacility > 0) return json({ ok: false, error: 'too_soon', retryAfterMinutes: cfg.perFacilityCooldownMinutes }, 429, cors);
    const lastHour = await store.countRateEvents({ clientKey: key, since: now - 3600000 });
    if (lastHour >= cfg.perClientHourlyLimit) return json({ ok: false, error: 'rate_limited' }, 429, cors);
    const facilityMinute = await store.countFacilityReports({ facilityId: v.value.facilityId, since: now - 60000 });
    if (facilityMinute >= cfg.globalPerFacilityPerMinute) return json({ ok: false, error: 'facility_busy' }, 429, cors);

    await store.insertReport({ ...v.value, createdAt: now });
    await store.insertRateEvent({ clientKey: key, facilityId: v.value.facilityId, createdAt: now });
    // 古いデータの削除（保存期間を過ぎた報告・1時間を過ぎたレート制限記録）
    await store.purge({ reportsBefore: now - cfg.retentionHours * 3600000, rateEventsBefore: now - 3600000 });
    return json({ ok: true, acceptedAt: new Date(now).toISOString() }, 201, cors);
  }

  return json({ ok: false, error: 'not_found' }, 404, cors);
}

// テスト・ローカル開発用のメモリ実装
export function createMemoryStore() {
  let reports = [];
  let events = [];
  return {
    async insertReport(r) { reports.push({ ...r }); },
    async listReports(since) { return reports.filter((r) => r.createdAt >= since); },
    async countRateEvents({ clientKey: k, facilityId, since }) {
      return events.filter((e) => e.clientKey === k && e.createdAt >= since && (!facilityId || e.facilityId === facilityId)).length;
    },
    async countFacilityReports({ facilityId, since }) {
      return reports.filter((r) => r.facilityId === facilityId && r.createdAt >= since).length;
    },
    async insertRateEvent(e) { events.push({ ...e }); },
    async purge({ reportsBefore, rateEventsBefore }) {
      reports = reports.filter((r) => r.createdAt >= reportsBefore);
      events = events.filter((e) => e.createdAt >= rateEventsBefore);
    },
    _dump() { return { reports, events }; },
  };
}
