"""Kanagawa official annual air-quality statistics -> Fujisawa stations JSON.

Primary source: 神奈川県環境科学センター『神奈川の大気汚染』(最新年度版) 資料編III
「大気汚染常時監視測定結果（まとめ）」の経年変化表（年平均値, 10年分）。
Supplement: 神奈川県環境農政局『令和N年度大気環境の状況について』資料1 表8/表9
（年報より新しい年度がある場合のみ、その年度だけ追加）。

Officially published annual values are used as-is (no recomputation from hourly
data). Values printed in parentheses (測定時間6000時間未満 / PM2.5は測定日数250日
未満) are stored as null.

Output: site/data/environment/air-quality.json
Run with: .cache/env/venv/bin/python -I scripts/env/air_quality.py
"""
import os
import re
import sys
import unicodedata
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import envcommon as ec  # noqa: E402

import pdfplumber  # noqa: E402

BASE = "https://www.pref.kanagawa.jp"
ANNUAL_INDEX = BASE + "/docs/b4f/taikiosen/index.html"     # 神奈川の大気汚染（年度選択）
SITE_POLICY = BASE + "/master/sitepolicy.html"
FUJISAWA_PAGE = "https://www.city.fujisawa.kanagawa.jp/khozen/machizukuri/kankyo/kogai/taiki/sokutekekka.html"
# 『大気環境の状況について』資料1 (環境農政局). Only URLs actually located are listed;
# no page lists them all, so they are recorded here explicitly.
SHIRYO1 = {
    2025: BASE + "/documents/137234/02-5_05shiryo1r7taiki.pdf",
    2024: BASE + "/documents/123220/02-5_05shiryo1r6taiki.pdf",
    2022: BASE + "/documents/101780/05_shiryo1_r4taiki.pdf",
    2021: BASE + "/documents/89899/05_shiryou1_r3taiki.pdf",
}
ADIR = os.path.join(ec.CACHE, "air")

STATIONS = [
    # name in report, type, address/setup from 資料編II 測定局属性 (checked in parse_attributes)
    ("藤沢市役所", "一般局"),
    ("藤沢市湘南台小学校", "一般局"),
    ("藤沢市御所見小学校", "一般局"),
    ("藤沢市明治市民センター", "一般局"),
    ("藤沢橋", "自排局"),
]
ITEMS = [
    # code, nameJa, unit, section title in 資料編III (NFKC), 資料1 表8/9 token index, metric label
    ("NO2", "二酸化窒素", "ppm", "3.2二酸化窒素濃度の経年変化(年平均値)", 2, "年平均値"),
    ("SPM", "浮遊粒子状物質", "mg/m³", "4.2浮遊粒子状物質濃度の経年変化(年平均値)", 5, "年平均値"),
    ("PM2.5", "微小粒子状物質", "µg/m³", "2.2微小粒子状物質濃度の経年変化(年平均値)", 10, "年平均値（日平均値の年平均）"),
    ("Ox", "光化学オキシダント", "ppm", "7.2光化学オキシダント濃度の経年変化(昼間の日最高1時間値の年平均値)", 15,
     "昼間（5〜20時）の日最高1時間値の年平均値"),
]
NUM = re.compile(r"^\(?\d+(\.\d+)?\)?$")


def n(s):
    return unicodedata.normalize("NFKC", s)


def fy_from_label(lbl):
    m = re.fullmatch(r"(H|R)(\d+)年度", lbl)
    if not m:
        ec.fail(f"bad fiscal-year label {lbl!r}")
    return (1988 if m.group(1) == "H" else 2018) + int(m.group(2))


def to_value(tok):
    """'0.009' -> (0.009, None); '(0.013)' -> (None, 'insufficient'); '-'/'－' -> (None, 'not_measured')."""
    t = n(tok)
    if t in ("-", "－", "‐"):
        return None, "not_measured"
    if not NUM.match(t):
        ec.fail(f"unexpected value token {tok!r}")
    if t.startswith("("):
        return None, "insufficient"
    return float(t), None


def latest_annual_report():
    idx = ec.fetch(ANNUAL_INDEX, os.path.join(ADIR, "taikiosen_index.html"), refresh=True, min_bytes=2000)
    html = open(idx, encoding="utf-8").read()
    years = sorted({int(y) for y in re.findall(r'href="/docs/b4f/taikiosen/(\d{4})taiki\.html"', html)})
    if not years:
        ec.fail("no yearly report pages found on 神奈川の大気汚染 index")
    for y in reversed(years):
        url = f"{BASE}/docs/b4f/taikiosen/{y}taiki.html"
        p = ec.fetch(url, os.path.join(ADIR, f"{y}taiki.html"), refresh=True, min_bytes=2000)
        page = open(p, encoding="utf-8").read()
        links = dict((n(lab).replace(" ", ""), urllib.parse.urljoin(BASE, href))
                     for href, lab in re.findall(r'<a[^>]+href="([^"]+\.pdf)"[^>]*>([^<]*)', page))
        s3 = [u for lab, u in links.items() if lab.startswith("III:") and "測定結果(まとめ)" in lab]
        s2 = [u for lab, u in links.items() if lab.startswith("II:") and "測定局属性" in lab]
        if len(s3) == 1 and len(s2) == 1:
            return y, url, s3[0], s2[0]
    ec.fail("no yearly report with 資料編III found")


def parse_attributes(path):
    out = {}
    with pdfplumber.open(path) as pdf:
        for pg in pdf.pages:
            for line in (pg.extract_text() or "").splitlines():
                parts = line.split()
                if len(parts) >= 6 and parts[1] in dict(STATIONS):
                    kind = {"環": "一般局", "自": "自排局"}.get(parts[2])
                    out[parts[1]] = {"typeCode": parts[2], "type": kind, "operator": parts[3],
                                     "since": parts[4], "address": parts[5]}
    for name, typ in STATIONS:
        if name not in out:
            ec.fail(f"station {name} missing in 測定局属性")
        if out[name]["type"] != typ:
            ec.fail(f"station {name} type {out[name]['type']} != {typ}")
    return out


def parse_trend_tables(path):
    """Return {(station, item): {fy: (value, flag)}} from 経年変化 tables."""
    with pdfplumber.open(path) as pdf:
        pages = [n(pg.extract_text() or "") for pg in pdf.pages]
    res = {}
    for code, _, _, title, _, _ in ITEMS:
        start = [i for i, t in enumerate(pages) if title in t.replace(" ", "").replace("　", "")]
        if len(start) != 1:
            ec.fail(f"section {title} found {len(start)} times")
        i = start[0]
        seen = set()
        for j in (i, i + 1):  # (1) 一般局 page, (2) 自排局 page (if the section has one)
            lines = pages[j].splitlines()
            if j > i and (re.match(r"^\s*\d+\.\d+\s*\S", lines[0] if lines else "")
                          or "自動車排出ガス測定局" not in pages[j]):
                break  # next page already belongs to another section
            hdr = [l for l in lines if re.fullmatch(r"((H|R)\d+年度\s*){5,}", l.strip())]
            if len(hdr) != 1:
                ec.fail(f"{title}: year header not found on page {j + 1}")
            fys = [fy_from_label(x) for x in hdr[0].split()]
            if fys != list(range(fys[0], fys[0] + len(fys))):
                ec.fail(f"{title}: non-consecutive years {fys}")
            for line in lines:
                m = re.match(r"^\d*\s*(\S+)\s+(.+)$", line.strip())
                if not m or m.group(1) not in dict(STATIONS):
                    continue
                toks = m.group(2).split()
                if len(toks) != len(fys):
                    ec.fail(f"{title}: {m.group(1)} has {len(toks)} values for {len(fys)} years")
                res[(m.group(1), code)] = {fy: to_value(t) for fy, t in zip(fys, toks)}
                seen.add(m.group(1))
        # every Fujisawa station that measures the item must appear (Ox not at 藤沢橋)
        expected = {s for s, _ in STATIONS} - ({"藤沢橋"} if code == "Ox" else set())
        if seen != expected:
            ec.fail(f"{title}: stations found {sorted(seen)} != expected {sorted(expected)}")
    return res, fys[-1]


def tokens(chars, gap=1.2):
    cs = sorted(chars, key=lambda c: c["x0"])
    out, cur = [], [cs[0]]
    for c in cs[1:]:
        if c["x0"] - cur[-1]["x1"] > gap:
            out.append(cur)
            cur = [c]
        else:
            cur.append(c)
    out.append(cur)
    return ["".join(c["text"] for c in t) for t in out]


def parse_shiryo1(path, fy):
    """表8/表9 rows (25 tokens each) -> {station: tokens}."""
    rows_out = {}
    with pdfplumber.open(path) as pdf:
        text0 = n(pdf.pages[0].extract_text() or "")
        reiwa = fy - 2018
        if f"令和{reiwa}年度大気環境の状況について" not in text0.replace(" ", "") and \
                not any(f"令和{reiwa}年度大気環境の状況について" in n(p.extract_text() or "").replace(" ", "")
                        for p in pdf.pages[:2]):
            ec.fail(f"資料1 title for FY{fy} not found")
        for pg in pdf.pages:
            t = n(pg.extract_text() or "")
            if "測定結果一覧" not in t or not ("表8" in t or "表9" in t):
                continue
            rows = {}
            for c in pg.chars:
                rows.setdefault(round(c["top"]), []).append(c)
            flat = n("".join("".join(c["text"] for c in sorted(rows[k], key=lambda c: c["x0"]))
                             for k in sorted(rows))).replace(" ", "")
            pos = [flat.find(w) for w in ("二酸化窒素", "浮遊粒子状物質", "微小粒子状物質")]
            if min(pos) < 0 or pos != sorted(pos):
                ec.fail(f"資料1 FY{fy}: column headers not found in expected order")
            for k in sorted(rows):
                tk = tokens(rows[k])
                if len(tk) >= 2 and tk[1] in dict(STATIONS):
                    if len(tk) != 25:
                        ec.fail(f"資料1 FY{fy}: row {tk[1]} has {len(tk)} tokens (expected 25)")
                    rows_out[tk[1]] = tk
    if set(rows_out) != {s for s, _ in STATIONS}:
        ec.fail(f"資料1 FY{fy}: stations {sorted(rows_out)}")
    return rows_out


def main():
    retrieved = ec.today()
    rep_year, rep_url, s3_url, s2_url = latest_annual_report()
    s3 = ec.fetch(s3_url, os.path.join(ADIR, f"{rep_year}_shiryou3.pdf"), min_bytes=10_000, expect_prefix=b"%PDF")
    s2 = ec.fetch(s2_url, os.path.join(ADIR, f"{rep_year}_shiryou2.pdf"), min_bytes=10_000, expect_prefix=b"%PDF")
    attrs = parse_attributes(s2)
    trend, last_fy = parse_trend_tables(s3)
    if last_fy != rep_year:
        ec.fail(f"report {rep_year} trend tables end at FY{last_fy}")

    series_src = {}
    checks = []
    for fy, url in sorted(SHIRYO1.items()):
        p = ec.fetch(url, os.path.join(ADIR, f"shiryo1_FY{fy}.pdf"), min_bytes=10_000, expect_prefix=b"%PDF")
        rows = parse_shiryo1(p, fy)
        for code, _, _, _, col, _ in ITEMS:
            for st, _ in STATIONS:
                if code == "Ox" and st == "藤沢橋":
                    continue
                v = to_value(rows[st][col])
                key = (st, code)
                if fy in trend.get(key, {}):
                    if trend[key][fy] != v:
                        ec.fail(f"cross-check mismatch {key} FY{fy}: 年報 {trend[key][fy]} vs 資料1 {v}")
                    checks.append(fy)
                elif fy > last_fy:
                    trend.setdefault(key, {})[fy] = v
                    series_src[(st, code, fy)] = url

    series = []
    for st, _ in STATIONS:
        for code, *_ in ITEMS:
            for fy, (val, flag) in sorted(trend.get((st, code), {}).items()):
                if flag == "not_measured":
                    continue  # station did not measure this item that year
                note = None
                if flag == "insufficient":
                    note = ("有効測定日数250日未満のため年平均値は参考値扱い（収録せず）" if code == "PM2.5"
                            else "年間測定時間6000時間未満のため年平均値は参考値扱い（収録せず）")
                src = series_src.get((st, code, fy))
                rec = {"station": st, "item": code, "fiscalYear": fy, "value": val}
                if note:
                    rec["note"] = note
                rec["source"] = "shiryo1" if src else "annualReport"
                series.append(rec)
    fys = sorted({s["fiscalYear"] for s in series})
    out = {
        "status": "ok",
        "generatedAt": ec.now_iso(),
        "retrievedAt": retrieved,
        "period": f"{fys[0]}年度〜{fys[-1]}年度（年度＝4月〜翌3月）",
        "sources": [
            {"id": "annualReport",
             "name": f"神奈川県環境科学センター『神奈川の大気汚染』{rep_year}年度版 資料編III 大気汚染常時監視測定結果（まとめ）経年変化表",
             "pageUrl": rep_url, "pdfUrl": s3_url, "stationAttributesPdf": s2_url,
             "covers": f"{fys[0]}〜{last_fy}年度"},
            {"id": "shiryo1",
             "name": "神奈川県環境農政局『大気環境の状況について』資料1 表8・表9（年報未刊行の年度の補完、および重複年度の照合に使用）",
             "pdfUrls": [SHIRYO1[k] for k in sorted(SHIRYO1)],
             "covers": ", ".join(f"{k}年度" for k in sorted(SHIRYO1)),
             "crossCheckedYears": sorted(set(checks))},
            {"id": "fujisawa", "name": "藤沢市『大気の測定結果』（測定局の説明、月別速報値PDF）", "pageUrl": FUJISAWA_PAGE},
        ],
        "terms": {
            "url": SITE_POLICY,
            "summary": ("神奈川県サイトポリシー: 掲載コンテンツは著作権の対象で、『引用』等の著作権法上認められる範囲で自由に利用可、"
                        "利用時は出典を記載。明示的なオープンデータライセンスは付されていない。本JSONは公表された測定値（事実データ）"
                        "のみを抜き出し、出典を付している。"),
            "attribution": "出典：神奈川県『神奈川の大気汚染』『大気環境の状況について』（藤沢市内の測定局の値を抜粋）",
        },
        "stations": [{"name": st, "type": typ,
                      "typeJa": "一般環境大気測定局" if typ == "一般局" else "自動車排出ガス測定局",
                      "address": attrs[st]["address"], "operator": attrs[st]["operator"] + "市",
                      "since": attrs[st]["since"]} for st, typ in STATIONS],
        "items": [{"code": c, "nameJa": nm, "unit": u, "metric": metric} for c, nm, u, _, _, metric in ITEMS],
        "series": series,
        "method": [
            "県が公表した年平均値（確定値）をそのまま転記。1時間値からの再計算は行っていない。",
            "年平均値は年度（4月〜翌3月）単位。NO2・SPMは1時間値の年平均、PM2.5は日平均値の年平均、Oxは昼間（5〜20時）の日最高1時間値の年平均。",
            "公表資料で（）付きの値（年間測定時間6000時間未満、PM2.5は測定日数250日未満）は環境省の評価方法に満たないためnullとした。",
            "未測定（－）の年度・項目は系列に含めていない。",
            f"{last_fy}年度までは『神奈川の大気汚染』経年変化表、それより新しい年度は『大気環境の状況について』資料1の表から取得。重複年度は両資料の値が一致することを確認。",
        ],
        "limitations": [
            "一般局（住宅地などの一般的な生活環境）と自排局（藤沢橋：交通量の多い道路沿い）は設置目的が異なるため、値を同列に比較しないこと。",
            "測定局は市内5か所の点の値であり、市全域や特定の地区の大気を代表するものではない。",
            "光化学オキシダントの環境基準（1時間値0.06ppm以下）は県内全測定局で非達成が続いており、ここに示す年平均値は環境基準の達成判定に使う指標ではない。",
            "NO2・SPM・PM2.5の環境基準の達成判定は年平均値だけでは行わない（日平均値の98%値・2%除外値など別の指標を使う）。",
            "最新年度の値は年報（神奈川の大気汚染）刊行前の資料による。",
            "月別の速報値（藤沢市PDF・県の速報）は確定前で変わる可能性があるため収録していない。",
            "国立環境研究所（環境数値データベース）のデータは今回の取得環境から接続できず、使用していない。",
        ],
    }
    ec.write_json("air-quality.json", out)


if __name__ == "__main__":
    main()
