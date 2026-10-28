import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  haversineMeters, isValidCoordinate, filterFacilities, sortByDistance, searchFacilities,
  googleMapsSearchUrl, googleMapsDirectionsUrl, formatDistance,
} from '../../site/assets/js/geo.js';

const F = (o) => ({ id: 'fjs-0000000000', name: 'A', address: '神奈川県藤沢市朝日町1-1', facilityTypes: ['指定緊急避難場所'], supportedHazards: [], latitude: null, longitude: null, ...o });

test('直線距離：既知の座標（藤沢駅付近〜江の島付近 約4.2km）', () => {
  const d = haversineMeters(35.3389, 139.4877, 35.3002, 139.4805);
  assert.ok(d > 4200 && d < 4400, `distance=${d}`);
});

test('直線距離：同一点は0、東京駅〜大阪駅は約400km', () => {
  assert.equal(haversineMeters(35.3, 139.4, 35.3, 139.4), 0);
  const d = haversineMeters(35.6812, 139.7671, 34.7025, 135.4959);
  assert.ok(d > 395000 && d < 410000);
});

test('不正な座標は距離計算しない', () => {
  assert.equal(haversineMeters(null, 139.4, 35.3, 139.4), null);
  assert.equal(haversineMeters(NaN, 139.4, 35.3, 139.4), null);
  assert.equal(haversineMeters(95, 139.4, 35.3, 139.4), null);
  assert.equal(haversineMeters('35.3', 139.4, 35.3, 139.4), null);
  assert.equal(isValidCoordinate(0, 0), false);
});

test('災害種別に対応していない施設は結果に出ない', () => {
  const list = [
    F({ id: 'fjs-a', supportedHazards: ['flood'] }),
    F({ id: 'fjs-b', supportedHazards: ['earthquake'] }),
    F({ id: 'fjs-c', supportedHazards: ['flood', 'earthquake'] }),
    F({ id: 'fjs-d', facilityTypes: ['指定避難所'], supportedHazards: [] }),
  ];
  assert.deepEqual(filterFacilities(list, { hazard: 'flood' }).map((f) => f.id), ['fjs-a', 'fjs-c']);
  assert.deepEqual(filterFacilities(list, { hazard: 'tsunami' }), []);
  assert.deepEqual(filterFacilities(list, { hazard: null }), [], '災害種別未選択では緊急避難場所を返さない');
  assert.deepEqual(filterFacilities(list, { mode: 'shelter' }).map((f) => f.id), ['fjs-d']);
});

test('休止告知のある施設は結果から除外', () => {
  const list = [F({ id: 'fjs-a', supportedHazards: ['flood'], notice: { type: 'suspended' } }), F({ id: 'fjs-b', supportedHazards: ['flood'] })];
  assert.deepEqual(filterFacilities(list, { hazard: 'flood' }).map((f) => f.id), ['fjs-b']);
});

test('緯度経度がない施設を近さの計算に使わない', () => {
  const list = [
    F({ id: 'far', latitude: 35.40, longitude: 139.45 }),
    F({ id: 'none' }),
    F({ id: 'near', latitude: 35.34, longitude: 139.49 }),
    F({ id: 'bad', latitude: 'x', longitude: 139.49 }),
  ];
  const { withDistance, noCoordinates } = sortByDistance(list, { latitude: 35.339, longitude: 139.488 });
  assert.deepEqual(withDistance.map((x) => x.facility.id), ['near', 'far']);
  assert.deepEqual(noCoordinates.map((f) => f.id).sort(), ['bad', 'none']);
});

test('空・不正なデータに安全に対処', () => {
  assert.deepEqual(filterFacilities(null, { hazard: 'flood' }), []);
  assert.deepEqual(filterFacilities([null, 1, 'x'], { hazard: 'flood' }), []);
  assert.deepEqual(sortByDistance([], { latitude: 35, longitude: 139 }), { withDistance: [], noCoordinates: [] });
  assert.deepEqual(searchFacilities([], '藤沢'), []);
});

test('手動検索：全角半角・空白・ハイフンの違いを吸収', () => {
  const list = [F({ name: '辻堂小学校', address: '神奈川県藤沢市辻堂東海岸1-17-1', district: '辻堂' })];
  assert.equal(searchFacilities(list, '辻堂').length, 1);
  assert.equal(searchFacilities(list, '東海岸１－１７').length, 1);
  assert.equal(searchFacilities(list, '  ').length, 0);
  assert.equal(searchFacilities(list, '鵠沼').length, 0);
});

test('Google Maps URLs：APIキーなし・現在地を含めない', () => {
  const f = F({ name: '辻堂小学校', latitude: 35.32, longitude: 139.45 });
  const s = googleMapsSearchUrl(f);
  const d = googleMapsDirectionsUrl(f);
  assert.match(s, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=35\.32%2C139\.45$/);
  assert.match(d, /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1/);
  assert.ok(!d.includes('origin='), '出発地（現在地）を付けない');
  assert.ok(!/key=/.test(s + d));
  assert.match(googleMapsSearchUrl(F({ name: 'X' })), /query=X\+/);
});

test('距離の表示', () => {
  assert.equal(formatDistance(null), '距離不明');
  assert.equal(formatDistance(123), '約120 m');
  assert.equal(formatDistance(4321), '約4.3 km');
});
