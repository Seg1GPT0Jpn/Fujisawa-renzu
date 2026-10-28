import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeGsiFeatures, parseCityTable, crossCheckWithCity, applyNotices, validateShelterData, normalizeAddress, stableId,
} from '../../scripts/lib/shelters-core.mjs';

const pt = (name, address, lon, lat, props = {}) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { name, address, ...props } });

test('国土地理院データ：藤沢市以外を除外し、災害種別を統合', () => {
  const flood = { features: [pt('A小学校', '神奈川県藤沢市辻堂1-1', 139.45, 35.32, { disaster1: 1 }), pt('B', '神奈川県茅ヶ崎市1', 139.40, 35.33, { disaster1: 1 })] };
  const quake = { features: [pt('A小学校', '神奈川県藤沢市辻堂1-1', 139.45, 35.32, { disaster4: 1 })] };
  const sih = { features: [pt('A小学校', '神奈川県藤沢市辻堂1-1', 139.45, 35.32)] };
  const { facilities } = mergeGsiFeatures({ emergencyLayers: [flood, quake], shelterLayer: sih });
  assert.equal(facilities.length, 1);
  assert.deepEqual(facilities[0].supportedHazards, ['flood', 'earthquake']);
  assert.deepEqual(facilities[0].facilityTypes, ['指定緊急避難場所', '指定避難所']);
  assert.equal(facilities[0].coordinateSource, 'gsi');
});

test('不正・範囲外の座標は null にして推測しない', () => {
  const layer = { features: [pt('X', '神奈川県藤沢市辻堂1-1', 0, 0, { disaster1: 1 }), pt('Y', '神奈川県藤沢市辻堂2-2', 'abc', 35, { disaster1: 1 })] };
  const { facilities, problems } = mergeGsiFeatures({ emergencyLayers: [layer], shelterLayer: { features: [] } });
  assert.ok(facilities.every((f) => f.latitude === null && f.longitude === null));
  assert.equal(problems.length, 2);
});

test('ID は名称・住所から安定して決まる', () => {
  assert.equal(stableId('A', '神奈川県藤沢市辻堂1-1'), stableId('Ａ', '藤沢市辻堂１－１'));
  assert.match(stableId('A', 'B'), /^fjs-[0-9a-f]{10}$/);
});

test('住所の正規化', () => {
  assert.equal(normalizeAddress('神奈川県藤沢市辻堂東海岸１－１７－１'), '辻堂東海岸1-17-1');
  assert.equal(normalizeAddress('下土棚590他'), '下土棚590');
});

const cityHtml = (extraHead = '', extraCell = '') => `
<table><caption>辻堂地区　避難先一覧</caption><tbody>
<tr><td>名称</td><td>所在地</td><td colspan="5">指定緊急避難場所</td><td>指定避難所</td><td><p>福祉避難所</p></td></tr>
<tr><td>地震</td><td>火山現象</td><td><p>洪水</p><p>・崖崩れ</p></td><td>大規模火災</td><td>津波</td>${extraHead}</tr>
<tr><td><a href="#">A小学校（外部サイトへリンク）</a></td><td>辻堂1-1</td><td>〇</td><td>&nbsp;</td><td>〇</td><td>&nbsp;</td><td>&nbsp;</td>${extraCell}<td>〇</td><td>&nbsp;</td></tr>
</tbody></table>`;

test('市ページの表を解析し、指定内容を照合する', () => {
  const rows = parseCityTable(cityHtml());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].district, '辻堂');
  const { facilities } = mergeGsiFeatures({
    emergencyLayers: [{ features: [pt('A小学校', '神奈川県藤沢市辻堂1-1', 139.45, 35.32, { disaster1: 1, disaster4: 1 })] }],
    shelterLayer: { features: [pt('A小学校', '神奈川県藤沢市辻堂1-1', 139.45, 35.32)] },
  });
  crossCheckWithCity(facilities, rows);
  assert.equal(facilities[0].cityPageCheck.status, 'match');
  assert.equal(facilities[0].district, '辻堂');

  facilities[0].supportedHazards = ['flood'];
  crossCheckWithCity(facilities, rows);
  assert.equal(facilities[0].cityPageCheck.status, 'mismatch');
});

test('高潮列のある表にも対応', () => {
  const rows = parseCityTable(cityHtml('<td>高潮</td>', '<td>〇</td>'));
  assert.equal(rows[0].stormSurge, true);
});

test('市ページのレイアウト変更を検出して失敗する', () => {
  assert.throws(() => parseCityTable('<html>no table</html>'), /見つかりません/);
  assert.throws(() => parseCityTable(cityHtml('<td>未知の列</td>', '<td></td>')), /想定外/);
});

test('休止告知を適用', () => {
  const fs = [{ name: '藤沢市民会館' }, { name: 'B' }];
  const { unused } = applyNotices(fs, [{ nameIncludes: '藤沢市民会館', type: 'suspended', text: 't', sourceUrl: 'u' }, { nameIncludes: 'Z', type: 'suspended' }]);
  assert.equal(fs[0].notice.type, 'suspended');
  assert.equal(fs[1].notice, undefined);
  assert.equal(unused.length, 1);
});

test('検証：重複ID・他市の住所・空データを検出', () => {
  const ok = { id: 'fjs-0000000001', name: 'A', address: '神奈川県藤沢市A', latitude: 35.3, longitude: 139.45, facilityTypes: ['指定緊急避難場所'], supportedHazards: ['flood'], sourceUrl: 'u' };
  assert.deepEqual(validateShelterData({ facilities: [ok] }, { minFacilities: 1 }).errors, []);
  assert.ok(validateShelterData({ facilities: [ok, { ...ok }] }, { minFacilities: 1 }).errors.some((e) => e.includes('重複')));
  assert.ok(validateShelterData({ facilities: [{ ...ok, address: '神奈川県茅ヶ崎市' }] }, { minFacilities: 1 }).errors.length);
  assert.ok(validateShelterData({ facilities: [] }).errors.length);
  assert.ok(validateShelterData(null).errors.length);
  assert.ok(validateShelterData({ facilities: [{ ...ok, latitude: 35.3, longitude: null }] }, { minFacilities: 1 }).errors.length);
});
