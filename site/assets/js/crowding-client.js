// 混雑共有APIのクライアント（純粋関数＋fetch。位置情報は扱わない）
export const LEVELS = [
  { key: 'empty', label: '空いている' },
  { key: 'some', label: 'やや混雑' },
  { key: 'crowded', label: 'かなり混雑' },
  { key: 'unknown', label: 'わからない／確認できない' },
];
const LABEL = Object.fromEntries(LEVELS.map((l) => [l.key, l.label]));

// 送信内容は施設IDと混雑区分のみ
export function buildReportPayload(facilityId, level) {
  if (typeof facilityId !== 'string' || !/^fjs-[0-9a-f]{10}$/.test(facilityId)) throw new Error('施設IDが不正です');
  if (!LABEL[level]) throw new Error('混雑区分が不正です');
  return { facilityId, level };
}

const ERROR_TEXT = {
  too_soon: '同じ施設への報告は、しばらく時間をおいてからにしてください。',
  rate_limited: '短時間に多くの報告が送られたため、受け付けを一時停止しています。',
  facility_busy: 'この施設への報告が集中しているため、一時的に受け付けを停止しています。',
  unknown_facility: '施設が見つかりませんでした。',
  invalid_level: '混雑区分が不正です。',
  forbidden_origin: 'このページからの送信は許可されていません。',
  server_not_configured: '混雑共有の仕組みが設定されていません。',
};

export async function postReport(base, payload, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  if (!base) return { ok: false, message: '混雑共有は準備中のため、送信できません。' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/api/reports`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer',
    });
    let body = null;
    try { body = await res.json(); } catch { /* 応答が JSON でない */ }
    if (res.status === 201 && body?.ok === true) return { ok: true, message: '報告を受け付けました。ありがとうございます。', acceptedAt: body.acceptedAt };
    return { ok: false, message: `送信できませんでした。${ERROR_TEXT[body?.error] ?? `（エラー ${res.status}）`}` };
  } catch {
    return { ok: false, message: '送信できませんでした。通信状況を確認してください（報告は保存されていません）。' };
  } finally {
    clearTimeout(t);
  }
}

export async function fetchCrowding(base, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/api/crowding`, { signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// 集計結果を、強すぎない表現の文章にする
export function describeSummary(s, minReports) {
  if (!s || !s.total) return { headline: '情報不足', detail: '有効期間内の報告はありません。' };
  const counts = LEVELS.filter((l) => s.counts[l.key]).map((l) => `${l.label} ${s.counts[l.key]}件`).join('、');
  if (s.status === 'leading') {
    return { headline: `「${LABEL[s.leading]}」という報告が多い`, detail: `報告 ${s.total}件（${counts}）` };
  }
  if (s.status === 'mixed') return { headline: '報告にばらつきあり', detail: `報告 ${s.total}件（${counts}）` };
  return { headline: '情報不足', detail: `報告 ${s.total}件（${counts}）。${minReports}件未満などのため混雑度は判断しません。` };
}
