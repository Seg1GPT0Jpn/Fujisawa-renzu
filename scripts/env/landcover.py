"""JAXA HRLULC (Japan, v25.04) -> Fujisawa city-wide land-cover area table.

Source: JAXA Earth API STAC/COG distribution (no login), which republishes
JAXA EORC "High-Resolution Land-Use and Land-Cover Map of Japan v25.04".
Boundary: MLIT 国土数値情報 行政区域 N03 (2025-01-01), CC BY 4.0.

Outputs:
  site/data/environment/landcover.json
  site/data/environment/landcover-<year>.png  (tiny downsampled class map)

Run with: .cache/env/venv/bin/python -I scripts/env/landcover.py
"""
import json
import math
import os
import struct
import sys
import zipfile
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import envcommon as ec  # noqa: E402

import numpy as np  # noqa: E402
import rasterio  # noqa: E402
import rasterio.features  # noqa: E402
import rasterio.merge  # noqa: E402
import shapefile  # noqa: E402
from shapely.geometry import mapping, shape  # noqa: E402
from shapely.ops import unary_union  # noqa: E402

CITY_CODE = "14205"  # 藤沢市 (全国地方公共団体コード, 5桁)
STAC_COLLECTION = ("https://s3.ap-northeast-1.wasabisys.com/je-pds/cog/v1/"
                   "JAXA.EORC_ALOS_HRLULC.v25.04_japan/collection.json")
EXPECTED_COLLECTION_ID = "JAXA.EORC_ALOS_HRLULC.v25.04_japan"
PRODUCT_PAGE = "https://www.eorc.jaxa.jp/ALOS/jp/dataset/lulc/lulc_v2504_j.htm"
DATASET_PAGE = "https://www.eorc.jaxa.jp/ALOS/jp/dataset/lulc_j.htm"
TERMS_URL = "https://earth.jaxa.jp/ja/data/policy/"
N03_PAGE = "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2025.html"
N03_ZIP = "https://nlftp.mlit.go.jp/ksj/gml/data/N03/N03-2025/N03-20250101_14_GML.zip"
N03_SHP = "N03-20250101_14.shp"
COG_LEVEL = 4      # highest COG level published (0.1 deg item tiles)
TILE_DEG = 0.1
PNG_BLOCK = 4      # majority-downsample factor for the preview PNG
PNG_MAX_BYTES = 40_000

# Japanese names as given on the JAXA v25.04 product page (section 4).
CLASS_JA = {
    1: "水域", 2: "人工構造物", 3: "水田", 4: "畑地", 5: "草地",
    6: "落葉広葉樹林", 7: "落葉針葉樹林", 8: "常緑広葉樹林", 9: "常緑針葉樹林",
    10: "裸地", 11: "竹林", 12: "ソーラーパネル", 13: "湿地",
    14: "農業用温室", 15: "岩礁・干潟",
}

# WGS84 ellipsoid
A_WGS = 6378137.0
F_WGS = 1 / 298.257223563
E2 = F_WGS * (2 - F_WGS)
E = math.sqrt(E2)
B2 = (A_WGS * (1 - F_WGS)) ** 2


def _q(phi):
    s = math.sin(phi)
    return s / (1 - E2 * s * s) + (1 / (2 * E)) * math.log((1 + E * s) / (1 - E * s))


def cell_area_m2(lat_top, lat_bottom, dlon_deg):
    """Exact ellipsoidal area of a lat/lon cell on WGS84."""
    return (B2 * math.radians(dlon_deg) / 2) * abs(
        _q(math.radians(lat_top)) - _q(math.radians(lat_bottom)))


def load_boundary():
    zpath = ec.fetch(N03_ZIP, os.path.join(ec.CACHE, "n03", "N03-20250101_14_GML.zip"),
                     min_bytes=100_000, expect_prefix=b"PK")
    xdir = os.path.join(ec.CACHE, "n03", "x")
    os.makedirs(xdir, exist_ok=True)
    with zipfile.ZipFile(zpath) as z:
        names = z.namelist()
        need = [n for n in names if os.path.basename(n).startswith("N03-20250101_14.")
                and n.endswith((".shp", ".shx", ".dbf", ".prj"))]
        if len(need) != 4:
            ec.fail(f"N03 zip layout changed: {names}")
        for n in need:  # extract only the shapefile members, flat, no path traversal
            with z.open(n) as src, open(os.path.join(xdir, os.path.basename(n)), "wb") as dst:
                dst.write(src.read())
    r = shapefile.Reader(os.path.join(xdir, N03_SHP), encoding="utf-8")
    fields = [f[0] for f in r.fields[1:]]
    if "N03_007" not in fields or "N03_004" not in fields:
        ec.fail(f"N03 attribute layout changed: {fields}")
    geoms, names = [], set()
    for rec, shp in zip(r.records(), r.shapes()):
        if rec["N03_007"] == CITY_CODE:
            geoms.append(shape(shp.__geo_interface__))
            names.add(rec["N03_004"])
    if not geoms or names != {"藤沢市"}:
        ec.fail(f"Fujisawa polygons not found as expected: {names}")
    city = unary_union(geoms)
    if not city.is_valid:
        city = city.buffer(0)
    minx, miny, maxx, maxy = city.bounds
    if not (139.3 < minx < maxx < 139.6 and 35.2 < miny < maxy < 35.5):
        ec.fail(f"Unexpected Fujisawa bounds {city.bounds}")
    return city, len(geoms)


def read_json(url, dest):
    ec.fetch(url, dest, min_bytes=50)
    with open(dest, encoding="utf-8") as f:
        return json.load(f)


def tiles_for(bounds):
    minx, miny, maxx, maxy = bounds
    xs = range(math.floor(minx / TILE_DEG), math.floor(maxx / TILE_DEG) + 1)
    ys = range(math.floor(miny / TILE_DEG), math.floor(maxy / TILE_DEG) + 1)
    for ix in xs:
        for iy in ys:
            lon0, lat0 = ix * TILE_DEG, iy * TILE_DEG
            yield (f"E{lon0:.2f}-E{lon0 + TILE_DEG:.2f}", f"N{lat0:.2f}-N{lat0 + TILE_DEG:.2f}")


def write_png(path, idx, palette, transparent_index=0):
    """Minimal palette PNG writer (no external deps)."""
    h, w = idx.shape
    raw = b"".join(b"\x00" + idx[y].astype(np.uint8).tobytes() for y in range(h))

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
    plte = b"".join(bytes.fromhex(c) for c in palette)
    trns = bytes(0 if i == transparent_index else 255 for i in range(len(palette)))
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 3, 0, 0, 0))
           + chunk(b"PLTE", plte) + chunk(b"tRNS", trns)
           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    return len(png)


def majority_downsample(arr, k):
    h, w = arr.shape
    H, W = math.ceil(h / k), math.ceil(w / k)
    pad = np.zeros((H * k, W * k), dtype=arr.dtype)
    pad[:h, :w] = arr
    blocks = pad.reshape(H, k, W, k).transpose(0, 2, 1, 3).reshape(H, W, k * k)
    counts = np.zeros((H, W, 16), dtype=np.int32)
    for c in range(16):
        counts[..., c] = (blocks == c).sum(axis=2)
    out = counts[..., 1:].argmax(axis=2) + 1          # majority among classes 1..15
    out[counts[..., 1:].sum(axis=2) * 2 < k * k] = 0  # mostly outside city -> transparent
    return out.astype(np.uint8)


def main():
    retrieved = ec.today()
    os.makedirs(ec.OUT_DIR, exist_ok=True)
    city, npoly = load_boundary()
    jdir = os.path.join(ec.CACHE, "jaxa", "stac")
    coll = read_json(STAC_COLLECTION, os.path.join(jdir, "collection.json"))
    if coll.get("id") != EXPECTED_COLLECTION_ID:
        ec.fail(f"unexpected collection id {coll.get('id')}")
    classes = coll["assets"]["HRLULC"]["classification:classes"]
    legend = {c["value"]: c for c in classes if not c.get("nodata")}
    if sorted(legend) != list(range(1, 16)):
        ec.fail(f"unexpected class list {sorted(legend)}")
    base = STAC_COLLECTION.rsplit("/", 1)[0]
    years = sorted(l["href"].split("/")[1] for l in coll["links"] if l["rel"] == "child")
    if not years or not all(y.isdigit() for y in years):
        ec.fail(f"unexpected year children {years}")

    versions = []
    for year in years:
        paths = []
        for lon_band, lat_band in tiles_for(city.bounds):
            item_url = f"{base}/{year}/{COG_LEVEL}/{lon_band}/{lat_band}.json"
            item = read_json(item_url, os.path.join(jdir, year, lon_band, lat_band + ".json"))
            asset = item["assets"]["HRLULC"]
            if [c["value"] for c in asset["classification:classes"]] != [c["value"] for c in classes]:
                ec.fail(f"class table differs in {item_url}")
            if asset["je:rasters"]["dn2value"] != {"slope": 1.0, "offset": 0.0}:
                ec.fail(f"unexpected scaling in {item_url}")
            if not item["properties"]["start_datetime"].startswith(year):
                ec.fail(f"item period mismatch {item_url}")
            tif_url = f"{base}/{year}/{COG_LEVEL}/{lon_band}/" + asset["href"].lstrip("./")
            paths.append(ec.fetch(tif_url, os.path.join(ec.CACHE, "jaxa", "cog", year,
                                                         os.path.basename(asset["href"])),
                                  min_bytes=1000, expect_prefix=b"II*\x00"))
        srcs = [rasterio.open(p) for p in paths]
        for s in srcs:
            if s.count != 1 or s.dtypes[0] != "uint8" or s.crs.to_epsg() != 4326 or s.nodata != 0:
                ec.fail(f"unexpected raster profile in {s.name}")
        res = srcs[0].res
        mosaic, transform = rasterio.merge.merge(srcs, bounds=city.bounds, nodata=0)
        for s in srcs:
            s.close()
        arr = mosaic[0]
        inside = rasterio.features.geometry_mask([mapping(city)], out_shape=arr.shape,
                                                 transform=transform, invert=True,
                                                 all_touched=False)
        dlon, dlat = transform.a, -transform.e
        top = transform.f
        row_area = np.array([cell_area_m2(top - r * dlat, top - (r + 1) * dlat, dlon)
                             for r in range(arr.shape[0])])
        area_grid = np.broadcast_to(row_area[:, None], arr.shape)
        total = float(area_grid[inside].sum())
        nodata_area = float(area_grid[inside & (arr == 0)].sum())
        rows = []
        for code in range(1, 16):
            m = inside & (arr == code)
            a = float(area_grid[m].sum())
            rows.append({"code": code, "pixels": int(m.sum()),
                         "areaKm2": round(a / 1e6, 3),
                         "pct": round(100 * a / (total - nodata_area), 2) if total > nodata_area else None})
        clipped = np.where(inside, arr, 0).astype(np.uint8)
        png_name = f"landcover-{year}.png"
        palette = ["000000"] + [legend[c]["color_hint"] for c in range(1, 16)]
        small = majority_downsample(clipped, PNG_BLOCK)
        nbytes = write_png(os.path.join(ec.OUT_DIR, png_name), small, palette)
        if nbytes > PNG_MAX_BYTES:
            os.remove(os.path.join(ec.OUT_DIR, png_name))
            png_name = None
        versions.append({
            "version": f"{year}JPN_v25.04",
            "productVersion": "25.04",
            "targetPeriod": f"{year}年（観測年。2か月毎コンポジットの年間時系列から分類）",
            "resolutionM": None,
            "resolutionNote": (f"配信COGの画素サイズ {res[0] * 3600:.2f}秒（1/{round(1 / res[0])}度、"
                               f"藤沢付近で東西約{dlon * 111320 * math.cos(math.radians(35.36)):.1f}m×"
                               f"南北約{dlat * 110950:.1f}m）。原版GeoTIFFは1/12000度（約10m）。"),
            "retrievedAt": retrieved,
            "cityTotalKm2": round(total / 1e6, 3),
            "noDataKm2": round(nodata_area / 1e6, 3),
            "classes": rows,
            "map": {"file": png_name, "downsample": f"{PNG_BLOCK}×{PNG_BLOCK}画素の多数決",
                    "widthPx": int(small.shape[1]), "heightPx": int(small.shape[0]),
                    "pixelAspectHW": round((dlat * 110950) / (dlon * 111320 * math.cos(math.radians(35.36))), 3),
                    "bboxLonLat": [round(transform.c, 6), round(top - arr.shape[0] * dlat, 6),
                                   round(transform.c + arr.shape[1] * dlon, 6), round(top, 6)]}
            if png_name else None,
            "notes": [],
        })
        print(year, round(total / 1e6, 3), file=sys.stderr)

    for v in versions:
        if v["version"].startswith("2022"):
            v["notes"].append("2022年版は2022JPN_v23.12の分類結果に「岩礁・干潟」を追加し、"
                              "2020年と2024年が同じカテゴリの画素を2022年もそのカテゴリにそろえる"
                              "「はさみうち処理」（畑地・水田・裸地・農業用温室を除く）を行ったもの（JAXA説明より）。")
    acc = {"2020": "94.49", "2022": "95.53", "2024": "92.99"}
    for v in versions:
        y = v["version"][:4]
        if y in acc:
            extra = "。JAXAの注記では2022年の値は2022JPN_v23.12の精度検証結果" if y == "2022" else ""
            v["notes"].append(f"JAXA公表の全国全体精度: {acc[y]}%（独立検証点による。藤沢市内の精度ではない{extra}）。")

    out = {
        "status": "ok",
        "generatedAt": ec.now_iso(),
        "source": {
            "name": "JAXA 高解像度土地利用土地被覆図（日本域）ver.25.04（HRLULC Japan v25.04）",
            "url": DATASET_PAGE,
            "productUrl": PRODUCT_PAGE,
            "distributionUrl": STAC_COLLECTION,
            "distributionNote": ("ダウンロードはJAXA Earth API（JAXA EORC運営）のSTAC/COG配信を利用（ユーザー登録不要）。"
                                 "EORCの原版GeoTIFF（1/12000度）はユーザー登録が必要なため使用していない。"),
            "termsUrl": TERMS_URL,
            "termsSummary": ("JAXA第一宇宙技術部門「研究データ等の利用条件」: 出所表示を条件に改変・第三者配布を含め"
                             "無償で自由に利用可。二次的著作物の公表時もJAXAが原初データの配布者である旨の表示が必要。"
                             "商用目的の利用は事前にJAXAへ連絡が必要。JAXAは品質・利用結果に責任を負わない。"),
            "attribution": "提供：高解像度土地利用土地被覆図 ver.25.04（JAXA）。藤沢市域で集計・加工して作成。",
            "doi": "10.57746/EO.01kkfxamy0sngbwgn5ezsn90cw",
        },
        "boundary": {
            "name": "国土数値情報 行政区域データ（N03）2025年1月1日時点 神奈川県 — 藤沢市（コード14205）",
            "url": N03_PAGE,
            "license": "CC BY 4.0（出典：国土交通省 国土数値情報（行政区域データ）を加工して作成）",
            "polygons": npoly,
            "note": "海岸線で区切られた陸域ポリゴン（江の島などの島を含む）。JGD2011とWGS84の差は本集計では無視。",
        },
        "method": [
            "JAXA Earth APIのCOG（最上位レベル4、0.1度タイル）を藤沢市の外接範囲でモザイク。",
            "画素中心が行政区域ポリゴン内にある画素を市内とみなした（境界上の画素は中心位置で判定）。",
            "各画素の面積はWGS84楕円体上の緯度経度セル面積で計算し、カテゴリ別に合計。",
            "pctは市内の分類済み画素の合計面積（欠測=0値を除く）に対する割合。",
        ],
        "classes": [{"code": c, "nameJa": CLASS_JA[c], "nameEn": legend[c]["name"].strip(),
                     "color": "#" + legend[c]["color_hint"]} for c in range(1, 16)],
        "versions": versions,
        "limitations": [
            "衛星画像の自動分類（深層学習）による推定図であり、個々の場所の実際の土地利用を保証するものではない。誤分類を含む。",
            "公表されている全体精度は日本全域の検証点に基づく値で、藤沢市内・カテゴリ別の精度は示されていない。",
            "画素は約10mで、狭い道路・小規模な緑地・住宅の庭などは周囲のカテゴリに含まれることがある。",
            "二毛作・果樹園・茶畑などのカテゴリは定義されておらず、実情と異なる場合がある（JAXA注記）。",
            "年間の時系列画像から分類しており、特定の季節の状態ではない。",
            "年ごとの面積差には実際の変化だけでなく分類のゆらぎが含まれる。数値差をそのまま『増えた・減った』『環境が良く/悪くなった』と評価しないこと。",
            "3時期とも同一バージョン（v25.04）だが、2022年版の作り方は2020・2024年版と一部異なる（v23.12結果＋後処理）。",
            "旧バージョン（v21.11・v23.12など）とはカテゴリ数・手法が異なり、本データには含めていない（比較不可）。",
            "使用したのはJAXA Earth APIの配信版（1/9000度格子、最頻値リサンプリング）で、原版（1/12000度）から直接集計した値とはわずかに異なりうる。",
            "市域の面積（cityTotalKm2）は画素面積の合計であり、国土地理院『全国都道府県市区町村別面積調』の公式面積と一致するとは限らない。",
            "面積が0.1km²未満のカテゴリ（例：落葉針葉樹林・岩礁・干潟・ソーラーパネル）は誤分類の影響を受けやすく、存在の有無や増減の判断には使わないこと。",
            "地図画像は緯度経度格子のままの粗い（約40〜50m相当）概観図。表示時は縦横比を map.pixelAspectHW で補正すること。",
        ],
    }
    ec.write_json("landcover.json", out)


if __name__ == "__main__":
    main()
