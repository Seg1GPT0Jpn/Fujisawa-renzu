"""JAXA HRLULC v25.04 -> 藤沢市の地域メッシュ（1/4細分区画、約250m）ごとの土地被覆割合。

格子：JIS X 0410 地域メッシュの 1/4 細分区画（緯度 7.5秒 × 経度 11.25秒、藤沢付近で約231m×285m）。
     地域メッシュはコード体系であり、格子そのものに利用条件はない。
入力：landcover.py と同じ JAXA Earth API 配信版 COG（.cache に保存済みなら再取得しない）と N03 行政区域。
出力：site/data/environment/landcover-grid.json（環境ページで「地図を表示」を押したときだけ読み込む）

集計：
  - 画素の中心が市域内にある画素だけを数える（landcover.py と同じ判定）。
  - 区画内の市域内画素が区画全体の 25% 未満の区画は、割合が不安定なため出力しない。
  - 15分類を5区分にまとめ、市域内の分類済み画素に対する割合（整数%）を出す。欠測画素は分母から除く。
  - 区画内の市域内画素がすべて欠測の年は null。

Run with: .cache/env/venv/bin/python -I scripts/env/landcover_grid.py
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import envcommon as ec  # noqa: E402
import landcover as lc  # noqa: E402
import numpy as np  # noqa: E402
import rasterio  # noqa: E402
import rasterio.features  # noqa: E402
import rasterio.merge  # noqa: E402
from shapely.geometry import mapping  # noqa: E402

ROWS_PER_DEG = 480   # 1/4 細分区画の緯度方向の分割数（7.5秒）
COLS_PER_DEG = 320   # 経度方向（11.25秒）
MIN_INSIDE_FRAC = 0.25
OUT_NAME = "landcover-grid.json"
MAX_BYTES = 150_000

# 15分類 -> 5区分（分類の定義は JAXA v25.04 のカテゴリ表）
GROUPS = [
    {"key": "built", "nameJa": "建物・道路など", "codes": [2, 12],
     "note": "人工構造物（建物・道路・舗装面など）とソーラーパネル"},
    {"key": "farm", "nameJa": "農地", "codes": [3, 4, 14],
     "note": "水田・畑地・農業用温室"},
    {"key": "green", "nameJa": "樹林・草地", "codes": [5, 6, 7, 8, 9, 11],
     "note": "草地・広葉樹林・針葉樹林・竹林（公園の芝生、河川敷、ゴルフ場なども草地に含まれうる）"},
    {"key": "water", "nameJa": "水域・湿地", "codes": [1, 13, 15],
     "note": "水域・湿地・岩礁・干潟"},
    {"key": "bare", "nameJa": "裸地", "codes": [10],
     "note": "裸地（造成地・駐車場の一部・砂浜なども含まれうる）"},
]


def mesh_code(row, col):
    """格子の行・列（緯度×480、経度×320 の整数部）から 1/4 細分区画の地域メッシュコード（10桁）を作る。"""
    # 1次（40分×1度）
    p, rr = divmod(row, 320)          # 40分 = 2/3度 = 320行
    u, cc = divmod(col, 320)          # 1度 = 320列
    # 2次（5分×7.5分）：1次を8×8
    q, rr = divmod(rr, 40)
    v, cc = divmod(cc, 40)
    # 3次（30秒×45秒）：2次を10×10
    r, rr = divmod(rr, 4)
    w, cc = divmod(cc, 4)
    # 1/2（2×2）と 1/4（2×2）。番号は南西=1, 南東=2, 北西=3, 北東=4
    h_lat, rr = divmod(rr, 2)
    h_lon, cc = divmod(cc, 2)
    half = h_lat * 2 + h_lon + 1
    quarter = rr * 2 + cc + 1
    return f"{p:02d}{u - 100:02d}{q}{v}{r}{w}{half}{quarter}"


def load_year(year, city, coll, base, jdir):
    paths = []
    for lon_band, lat_band in lc.tiles_for(city.bounds):
        item_url = f"{base}/{year}/{lc.COG_LEVEL}/{lon_band}/{lat_band}.json"
        item = lc.read_json(item_url, os.path.join(jdir, year, lon_band, lat_band + ".json"))
        asset = item["assets"]["HRLULC"]
        if asset["je:rasters"]["dn2value"] != {"slope": 1.0, "offset": 0.0}:
            ec.fail(f"unexpected scaling in {item_url}")
        tif_url = f"{base}/{year}/{lc.COG_LEVEL}/{lon_band}/" + asset["href"].lstrip("./")
        paths.append(ec.fetch(tif_url, os.path.join(ec.CACHE, "jaxa", "cog", year, os.path.basename(asset["href"])),
                              min_bytes=1000, expect_prefix=b"II*\x00"))
    srcs = [rasterio.open(p) for p in paths]
    for s in srcs:
        if s.count != 1 or s.dtypes[0] != "uint8" or s.crs.to_epsg() != 4326 or s.nodata != 0:
            ec.fail(f"unexpected raster profile in {s.name}")
    mosaic, transform = rasterio.merge.merge(srcs, bounds=city.bounds, nodata=0)
    for s in srcs:
        s.close()
    return mosaic[0], transform


def main():
    city, _ = lc.load_boundary()
    jdir = os.path.join(ec.CACHE, "jaxa", "stac")
    coll = lc.read_json(lc.STAC_COLLECTION, os.path.join(jdir, "collection.json"))
    if coll.get("id") != lc.EXPECTED_COLLECTION_ID:
        ec.fail(f"unexpected collection id {coll.get('id')}")
    base = lc.STAC_COLLECTION.rsplit("/", 1)[0]
    years = sorted(l["href"].split("/")[1] for l in coll["links"] if l["rel"] == "child")
    if not years or not all(y.isdigit() for y in years):
        ec.fail(f"unexpected year children {years}")

    code_to_group = np.zeros(256, dtype=np.int8) - 1
    for gi, g in enumerate(GROUPS):
        for c in g["codes"]:
            code_to_group[c] = gi
    if sorted(c for g in GROUPS for c in g["codes"]) != list(range(1, 16)):
        ec.fail("GROUPS must cover classes 1..15 exactly once")

    per_year = {}
    grid_shape = None
    cell_keys = None
    inside_counts = None
    total_counts = None
    for year in years:
        arr, transform = load_year(year, city, coll, base, jdir)
        inside = rasterio.features.geometry_mask([mapping(city)], out_shape=arr.shape, transform=transform,
                                                 invert=True, all_touched=False)
        dlon, dlat = transform.a, -transform.e
        lats = transform.f - (np.arange(arr.shape[0]) + 0.5) * dlat
        lons = transform.c + (np.arange(arr.shape[1]) + 0.5) * dlon
        rows = np.floor(lats * ROWS_PER_DEG).astype(np.int64)
        cols = np.floor(lons * COLS_PER_DEG).astype(np.int64)
        r0, c0 = rows.min(), cols.min()
        nr, nc = rows.max() - r0 + 1, cols.max() - c0 + 1
        cell = (rows[:, None] - r0) * nc + (cols[None, :] - c0)
        ncell = int(nr * nc)
        if grid_shape is None:
            grid_shape = (int(r0), int(c0), int(nr), int(nc))
            total_counts = np.bincount(cell.ravel(), minlength=ncell)
            inside_counts = np.bincount(cell[inside], minlength=ncell)
        elif grid_shape != (int(r0), int(c0), int(nr), int(nc)):
            ec.fail(f"grid alignment differs in {year}")
        g = code_to_group[arr]
        counts = np.zeros((ncell, len(GROUPS)), dtype=np.int64)
        valid = inside & (g >= 0)
        for gi in range(len(GROUPS)):
            counts[:, gi] = np.bincount(cell[valid & (g == gi)], minlength=ncell)
        nodata = np.bincount(cell[inside & (arr == 0)], minlength=ncell)
        per_year[year] = (counts, nodata)

    r0, c0, nr, nc = grid_shape
    # 区画全体の画素数は区画が配信範囲の端で切れることがあるため、理論値で計算する
    full_px = (1 / ROWS_PER_DEG / dlat) * (1 / COLS_PER_DEG / dlon)
    cells, values = [], {y: [] for y in years}
    for idx in range(nr * nc):
        frac = inside_counts[idx] / full_px
        if frac < MIN_INSIDE_FRAC:
            continue
        row, col = r0 + idx // nc, c0 + idx % nc
        cells.append([int(row), int(col), int(round(min(frac, 1.0) * 100))])
        for y in years:
            counts, _ = per_year[y]
            tot = int(counts[idx].sum())
            if tot == 0:
                values[y].append(None)
                continue
            values[y].append([int(round(100 * x / tot)) for x in counts[idx]])

    nodata_cells = {y: sum(1 for v in values[y] if v is None) for y in years}
    if len(cells) < 500:
        ec.fail(f"too few cells ({len(cells)}); boundary or raster problem")

    # 市の輪郭（N03 を簡略化。約50m の許容誤差、表示用）
    simp = city.simplify(0.0005, preserve_topology=True)
    polys = [simp] if simp.geom_type == "Polygon" else list(simp.geoms)
    outline = []
    for poly in polys:
        if poly.area < 2e-6:   # 約0.02km²未満の小島は省略
            continue
        outline.append([[round(x, 5), round(y, 5)] for x, y in poly.exterior.coords])

    # 地区名の目安：国土地理院データにある各市民センター（公民館）の位置
    with open(os.path.join(ec.ROOT, "site", "data", "shelters.json"), encoding="utf-8") as f:
        sh = json.load(f)
    labels = []
    for fac in sh["facilities"]:
        name = fac["name"]
        if name.endswith("市民センター") or name.startswith("藤沢市民センター"):
            short = "藤沢" if name.startswith("藤沢市民センター") else name[:-len("市民センター")]
            if fac.get("latitude") is not None:
                labels.append({"name": short, "facility": name, "lat": fac["latitude"], "lon": fac["longitude"]})
    labels.sort(key=lambda x: x["name"])

    out = {
        "status": "ok",
        "generatedAt": ec.now_iso(),
        "retrievedAt": ec.today(),
        "grid": {
            "name": "地域メッシュ 1/4細分区画（JIS X 0410）",
            "rowsPerDeg": ROWS_PER_DEG, "colsPerDeg": COLS_PER_DEG,
            "approxSizeM": [231, 285],
            "note": "緯度7.5秒×経度11.25秒。藤沢付近で南北約231m×東西約285m。区画の市域内の部分だけを集計。",
            "minInsideFrac": MIN_INSIDE_FRAC,
        },
        "groups": [{k: g[k] for k in ("key", "nameJa", "note")} | {"jaxaCodes": g["codes"]} for g in GROUPS],
        "years": years,
        "cells": cells,             # [row, col, 市域内の割合%]
        "values": values,           # 年 -> 各区画の [5区分の割合%]（cells と同じ順）または null
        "noDataCells": nodata_cells,
        "outline": outline,
        "labels": labels,
        "source": {
            "name": "JAXA 高解像度土地利用土地被覆図（日本域）ver.25.04",
            "url": lc.PRODUCT_PAGE,
            "termsUrl": lc.TERMS_URL,
            "attribution": "提供：高解像度土地利用土地被覆図 ver.25.04（JAXA）。地域メッシュごとに集計・加工して作成。",
            "boundary": "国土数値情報 行政区域データ（N03、2025年1月1日時点、CC BY 4.0）を加工して作成",
            "boundaryUrl": lc.N03_PAGE,
            "labelsSource": "地区名の目安の位置：国土地理院「指定緊急避難場所・指定避難所データ」の各市民センター（ふじさわレンズの避難先データ）",
        },
    }
    text = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    if len(text.encode("utf-8")) > MAX_BYTES:
        ec.fail(f"{OUT_NAME} too large ({len(text.encode('utf-8'))} bytes)")
    path = os.path.join(ec.OUT_DIR, OUT_NAME)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"{path}: {len(text.encode('utf-8'))} bytes, cells={len(cells)}, years={years}, nodata={nodata_cells}, labels={len(labels)}")


if __name__ == "__main__":
    main()
