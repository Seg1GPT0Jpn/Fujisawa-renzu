// 公開するデータファイルそのものの検証
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { validateShelterData } from '../../scripts/lib/shelters-core.mjs';

const read = async (p) => JSON.parse(await readFile(new URL(`../../${p}`, import.meta.url), 'utf8'));

test('shelters.json が検証を通り、サイズ目安（250KB）以内', async () => {
  const raw = await readFile(new URL('../../site/data/shelters.json', import.meta.url));
  assert.ok(raw.length < 250 * 1024, `size=${raw.length}`);
  const data = JSON.parse(raw);
  const { errors } = validateShelterData(data);
  assert.deepEqual(errors, []);
  assert.ok(data.sources.every((s) => s.url && s.retrievedAt));
  assert.ok(data.lastCheckedAt);
  // 検索の選択肢はデータに実在する災害種別だけ
  for (const h of data.hazards) assert.ok(data.facilities.some((f) => f.supportedHazards.includes(h.key)), h.key);
  // 選択肢にない災害種別は missingHazards として案内される
  for (const m of data.missingHazards ?? []) assert.ok(!data.hazards.some((h) => h.key === m.key));
});

test('Worker の許可IDは shelters.json の（休止以外の）施設と一致', async () => {
  const data = await read('site/data/shelters.json');
  const ids = (await read('worker/src/facility-ids.json')).ids;
  const expected = data.facilities.filter((f) => !(f.notice?.type === 'suspended')).map((f) => f.id).sort();
  assert.deepEqual(ids, expected);
});

// 環境データ：数値は number か null（欠測を0や文字列で埋めない）。出典が必須。
function walkNumbers(obj, path, out) {
  if (Array.isArray(obj)) obj.forEach((v, i) => walkNumbers(v, `${path}[${i}]`, out));
  else if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) walkNumbers(v, `${path}.${k}`, out);
  else out.push([path, obj]);
}

test('環境データ：出典・状態が記載され、欠測を0で埋めていない', async () => {
  const dir = new URL('../../site/data/environment/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const d = JSON.parse(await readFile(new URL(f, dir), 'utf8'));
    assert.ok(['ok', 'partial', 'unavailable', 'not_processed'].includes(d.status), `${f}: status`);
    const s = JSON.stringify(d);
    assert.ok(/https?:\/\//.test(s), `${f}: 出典URLがない`);
    const leaves = [];
    walkNumbers(d, f, leaves);
    for (const [p, v] of leaves) {
      if (typeof v === 'string') assert.ok(!/^(NaN|-|欠測|N\/A)$/.test(v.trim()) || /note|label|text|reason|unit|name/i.test(p), `${p}: 欠測が文字列で埋められている可能性 (${v})`);
    }
  }
});
