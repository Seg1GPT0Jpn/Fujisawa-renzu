import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, createMemoryStore, summarize, validateReport, clientKey } from '../../worker/src/logic.js';

const ID = 'fjs-0123456789';
const ID2 = 'fjs-abcdefabcd';
const ids = new Set([ID, ID2]);
const env = { RATE_LIMIT_SECRET: 'test-secret', ALLOWED_ORIGINS: 'https://lens.example' };
const T0 = Date.parse('2026-10-28T03:00:00Z');

function post(body, { ip = '203.0.113.1', origin = 'https://lens.example', type = 'application/json' } = {}) {
  return new Request('https://api.example/api/reports', {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': type, Origin: origin, 'CF-Connecting-IP': ip },
  });
}
const get = () => new Request('https://api.example/api/crowding', { headers: { Origin: 'https://lens.example' } });

test('ログインなしで投稿でき、集計に反映される', async () => {
  const store = createMemoryStore();
  const r = await handle(post({ facilityId: ID, level: 'crowded' }), { env, store, facilityIds: ids, now: T0 });
  assert.equal(r.status, 201);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://lens.example');
  const g = await (await handle(get(), { env, store, facilityIds: ids, now: T0 + 1000 })).json();
  assert.equal(g.facilities[ID].total, 1);
  assert.equal(g.facilities[ID].status, 'insufficient', '1件では断定しない');
});

test('保存されるのは施設ID・区分・時刻のみ（IPは不可逆化して短期保存）', async () => {
  const store = createMemoryStore();
  await handle(post({ facilityId: ID, level: 'some' }, { ip: '198.51.100.7' }), { env, store, facilityIds: ids, now: T0 });
  const { reports, events } = store._dump();
  assert.deepEqual(Object.keys(reports[0]).sort(), ['createdAt', 'facilityId', 'level']);
  assert.ok(!JSON.stringify(events).includes('198.51.100.7'));
  assert.match(events[0].clientKey, /^[0-9a-f]{32}$/);
});

test('不正な施設ID・混雑値・余計な項目（位置情報など）を拒否', async () => {
  const store = createMemoryStore();
  const cases = [
    [{ facilityId: 'fjs-ffffffffff', level: 'some' }, 'unknown_facility'],
    [{ facilityId: '<script>', level: 'some' }, 'unknown_facility'],
    [{ facilityId: ID, level: 'full' }, 'invalid_level'],
    [{ facilityId: ID, level: 'some', latitude: 35.3, longitude: 139.4 }, 'unexpected_fields'],
    [{ facilityId: ID }, 'unexpected_fields'],
    [[ID, 'some'], 'invalid_body'],
  ];
  for (const [body, err] of cases) {
    const r = await handle(post(body), { env, store, facilityIds: ids, now: T0 });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal((await r.json()).error, err);
  }
  assert.equal((await handle(post('{bad json'), { env, store, facilityIds: ids, now: T0 })).status, 400);
  assert.equal((await handle(post('x'.repeat(1000)), { env, store, facilityIds: ids, now: T0 })).status, 413);
  assert.equal((await handle(post({ facilityId: ID, level: 'some' }, { type: 'text/plain' }), { env, store, facilityIds: ids, now: T0 })).status, 415);
  assert.equal((await handle(post({ facilityId: ID, level: 'some' }, { origin: 'https://evil.example' }), { env, store, facilityIds: ids, now: T0 })).status, 403);
  assert.equal(store._dump().reports.length, 0);
});

test('連投・大量リクエストを制限', async () => {
  const store = createMemoryStore();
  const ctx = (now) => ({ env, store, facilityIds: ids, now });
  assert.equal((await handle(post({ facilityId: ID, level: 'some' }), ctx(T0))).status, 201);
  assert.equal((await handle(post({ facilityId: ID, level: 'some' }), ctx(T0 + 60000))).status, 429, '同じ施設への再投稿は10分間不可');
  assert.equal((await handle(post({ facilityId: ID, level: 'some' }), ctx(T0 + 11 * 60000))).status, 201);
  // 1時間あたりの上限
  const env2 = { ...env, PER_CLIENT_HOURLY_LIMIT: '2', PER_FACILITY_COOLDOWN_MINUTES: '1' };
  const s2 = createMemoryStore();
  const c2 = (now) => ({ env: env2, store: s2, facilityIds: ids, now });
  assert.equal((await handle(post({ facilityId: ID, level: 'some' }), c2(T0))).status, 201);
  assert.equal((await handle(post({ facilityId: ID2, level: 'some' }), c2(T0 + 1000))).status, 201);
  assert.equal((await handle(post({ facilityId: ID, level: 'some' }), c2(T0 + 120000))).status, 429);
  // 施設ごとの全体上限（多数のIPからの集中）
  const env3 = { ...env, GLOBAL_PER_FACILITY_PER_MINUTE: '3' };
  const s3 = createMemoryStore();
  for (let i = 0; i < 3; i++) assert.equal((await handle(post({ facilityId: ID, level: 'some' }, { ip: `10.0.0.${i}` }), { env: env3, store: s3, facilityIds: ids, now: T0 + i })).status, 201);
  assert.equal((await handle(post({ facilityId: ID, level: 'some' }, { ip: '10.0.0.9' }), { env: env3, store: s3, facilityIds: ids, now: T0 + 10 })).status, 429);
});

test('有効期限切れの投稿は集計しない', () => {
  const now = T0;
  const reports = [
    { level: 'crowded', createdAt: now - 31 * 60000 },
    { level: 'crowded', createdAt: now - 40 * 60000 },
    { level: 'empty', createdAt: now - 5 * 60000 },
  ];
  const s = summarize(reports, { now, windowMinutes: 30, minReportsForSummary: 3 });
  assert.equal(s.total, 1);
  assert.equal(s.counts.crowded, 0);
  assert.equal(s.status, 'insufficient');
});

test('件数が少ない・拮抗している場合は断定しない', () => {
  const mk = (levels) => levels.map((level, i) => ({ level, createdAt: T0 - i * 1000 }));
  const opt = { now: T0, windowMinutes: 30, minReportsForSummary: 3 };
  assert.equal(summarize(mk(['crowded', 'crowded']), opt).status, 'insufficient');
  assert.equal(summarize(mk(['unknown', 'unknown', 'unknown', 'crowded']), opt).status, 'insufficient', '「わからない」は判断材料にしない');
  assert.equal(summarize(mk(['crowded', 'empty', 'some']), opt).status, 'mixed');
  const s = summarize(mk(['crowded', 'crowded', 'empty']), opt);
  assert.equal(s.status, 'leading');
  assert.equal(s.leading, 'crowded');
});

test('期限切れデータは投稿時に削除される', async () => {
  const store = createMemoryStore();
  await store.insertReport({ facilityId: ID, level: 'some', createdAt: T0 - 25 * 3600000 });
  await handle(post({ facilityId: ID2, level: 'some' }), { env, store, facilityIds: ids, now: T0 });
  assert.equal(store._dump().reports.length, 1);
});

test('秘密値が未設定なら投稿を受け付けない', async () => {
  const r = await handle(post({ facilityId: ID, level: 'some' }), { env: { ALLOWED_ORIGINS: 'https://lens.example' }, store: createMemoryStore(), facilityIds: ids, now: T0 });
  assert.equal(r.status, 503);
});

test('clientKey は日付で変わる', async () => {
  const a = await clientKey('1.2.3.4', 's', T0);
  const b = await clientKey('1.2.3.4', 's', T0 + 86400000);
  assert.notEqual(a, b);
  assert.equal(validateReport({ facilityId: ID, level: 'empty' }, ids).ok, true);
});
