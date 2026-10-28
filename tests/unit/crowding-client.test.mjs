import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReportPayload, postReport, describeSummary } from '../../site/assets/js/crowding-client.js';

test('送信内容は施設IDと区分のみ（GPS座標を含まない）', async () => {
  let sent = null;
  const fetchImpl = async (url, init) => { sent = { url, init }; return new Response(JSON.stringify({ ok: true, acceptedAt: 'x' }), { status: 201 }); };
  const r = await postReport('https://api.example', buildReportPayload('fjs-0123456789', 'some'), { fetchImpl });
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(sent.init.body), { facilityId: 'fjs-0123456789', level: 'some' });
  assert.ok(!/lat|lon|coord|position/i.test(sent.init.body));
  assert.equal(sent.init.credentials, 'omit');
});

test('API未設定・障害時に成功と表示しない', async () => {
  assert.equal((await postReport('', { facilityId: 'fjs-0123456789', level: 'some' })).ok, false);
  const down = async () => { throw new TypeError('network'); };
  const r1 = await postReport('https://api.example', { facilityId: 'fjs-0123456789', level: 'some' }, { fetchImpl: down });
  assert.equal(r1.ok, false);
  assert.match(r1.message, /送信できませんでした/);
  const e500 = async () => new Response('oops', { status: 500 });
  assert.equal((await postReport('https://api.example', { facilityId: 'fjs-0123456789', level: 'some' }, { fetchImpl: e500 })).ok, false);
  const fake200 = async () => new Response(JSON.stringify({ ok: false }), { status: 200 });
  assert.equal((await postReport('https://api.example', { facilityId: 'fjs-0123456789', level: 'some' }, { fetchImpl: fake200 })).ok, false);
  const r429 = async () => new Response(JSON.stringify({ ok: false, error: 'too_soon' }), { status: 429 });
  assert.match((await postReport('https://api.example', { facilityId: 'fjs-0123456789', level: 'some' }, { fetchImpl: r429 })).message, /時間をおいて/);
});

test('不正な入力は送信前に拒否', () => {
  assert.throws(() => buildReportPayload('x', 'some'));
  assert.throws(() => buildReportPayload('fjs-0123456789', 'full'));
});

test('少数の報告では「情報不足」と表示', () => {
  assert.equal(describeSummary(undefined, 3).headline, '情報不足');
  assert.equal(describeSummary({ total: 2, status: 'insufficient', counts: { empty: 0, some: 0, crowded: 2, unknown: 0 } }, 3).headline, '情報不足');
  assert.match(describeSummary({ total: 3, status: 'leading', leading: 'crowded', counts: { empty: 0, some: 1, crowded: 2, unknown: 0 } }, 3).headline, /報告が多い/);
});
