"""Kanagawa sea-bathing water-quality press releases -> Fujisawa beaches JSON.

Discovers 「海水浴場の水質検査（令和N年度第M回）の結果について」 releases from
the prefecture's press-release lists (県政記者クラブ, per fiscal year), downloads
the PDFs, and extracts only the three Fujisawa beaches.

Output: site/data/environment/water-quality.json
Run with: .cache/env/venv/bin/python -I scripts/env/water_quality.py
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
SEED_RELEASE = BASE + "/docs/e8z/prs/r2533039.html"  # 令和8年度第2回 (2026-08-14)
SITE_POLICY = BASE + "/master/sitepolicy.html"
FUJISAWA_BEACHES = ["片瀬東浜", "片瀬西浜・鵠沼", "辻堂"]
WDIR = os.path.join(ec.CACHE, "water")
TITLE_RE = re.compile(r"海水浴場の水質検査（令和(\d+)年度第(\d+)回）の結果について")
JUDGE = r"(不適|適|可)"


def html_text(path):
    raw = open(path, "rb").read().decode("utf-8", errors="strict")
    raw = re.sub(r"<(script|style).*?</\1>", "", raw, flags=re.S | re.I)
    return raw


def get(url, name, **kw):
    return ec.fetch(url, os.path.join(WDIR, name), **kw)


def pdf_text(path):
    with pdfplumber.open(path) as p:
        return "\n".join((pg.extract_text() or "") for pg in p.pages)


def z2h(s):
    return unicodedata.normalize("NFKC", s)


def reiwa_to_year(n):
    return 2018 + int(n)


def parse_sampling(text, fy):
    t = z2h(text).replace(" ", "")
    m = re.search(r"令和(\d+)年(\d+)月(\d+)日から(?:令和(\d+)年)?(\d+)月(\d+)日までの間の(\d+)日間、1日につき(\d+)回実施", t)
    if not m:
        ec.fail("sampling-date sentence not found in method PDF")
    y1 = reiwa_to_year(m.group(1))
    y2 = reiwa_to_year(m.group(4)) if m.group(4) else y1
    if y1 != reiwa_to_year(fy):
        ec.fail(f"method PDF year {y1} != FY {fy}")
    return {
        "periodFrom": f"{y1}-{int(m.group(2)):02d}-{int(m.group(3)):02d}",
        "periodTo": f"{y2}-{int(m.group(5)):02d}-{int(m.group(6)):02d}",
        "days": int(m.group(7)),
        "samplesPerDay": int(m.group(8)),
        "note": (f"この期間のうち{int(m.group(7))}日間、1日につき{int(m.group(8))}回採水（県全体の記述。"
                 "海水浴場ごとの採水日は公表資料に記載なし）"),
    }


def parse_results_table(text, fy):
    """資料3 (第2回発表時): rows with 第2回 then 第1回 judgement columns."""
    t = z2h(text)
    flat = t.replace(" ", "")
    if f"令和{fy}年度海水浴場水質検査結果" not in flat:
        ec.fail(f"資料3 title for FY R{fy} not found")
    i2, i1 = flat.find("第2回判定結果"), flat.find("第1回判定結果")
    if i2 < 0 or i1 < 0 or not i2 < i1:
        ec.fail("資料3 column order (第2回, 第1回) not as expected")
    out = {}
    # after NFKC: e.g. "7月1日～9月13日可B可B" (第2回 judgement/grade, then 第1回)
    rgx = re.compile(r"(.*?)" + JUDGE + r"(AA|A|B|C|-|不適)" + JUDGE + r"(AA|A|B|C|-|不適)$")
    for line in t.splitlines():
        s = line.replace(" ", "").replace("\u3000", "")
        for b in FUJISAWA_BEACHES:  # the three names do not overlap each other
            if b not in s:
                continue
            m = rgx.match(s.split(b, 1)[1])
            if not m:
                ec.fail(f"row for {b} has unexpected format: {line!r}")
            if b in out:
                ec.fail(f"duplicate row for {b}")
            period = re.search(r"(\d+)月(\d+)日[～~〜](\d+)月(\d+)日", m.group(1))
            out[b] = {
                "raw": (m.group(2), m.group(3), m.group(4), m.group(5)),
                "opening": (f"{reiwa_to_year(fy)}-{int(period.group(1)):02d}-{int(period.group(2)):02d}",
                            f"{reiwa_to_year(fy)}-{int(period.group(3)):02d}-{int(period.group(4)):02d}")
                if period else None,
            }
    missing = [b for b in FUJISAWA_BEACHES if b not in out]
    if missing:
        ec.fail(f"Fujisawa beaches missing in 資料3: {missing}")
    res = {}
    for b, v in out.items():
        j2, g2, j1, g1 = v["raw"]
        res[b] = {"round2": (j2, g2), "round1": (j1, g1), "opening": v["opening"]}
    return res


def o157_from_release(html):
    t = re.sub(r"<[^>]+>", " ", html)
    t = z2h(t)
    if re.search(r"O157の有無を検査したところ、全ての海水浴場において検出されませんでした", t):
        return "不検出"
    return None


def discover_releases():
    seed = get(SEED_RELEASE, "r2533039.html", min_bytes=2000, refresh=True)
    lists = sorted(set(re.findall(r'href="(/prs/list-(\d{4})-1-1\.html)"', html_text(seed))))
    if not lists:
        ec.fail("press-release list links not found on seed page")
    rel = {}
    for path, fy_ad in lists:
        p = get(BASE + path, f"list-{fy_ad}.html", min_bytes=2000, refresh=True)
        for href, title in re.findall(r'<a href="(/docs/[^"]+\.html)">([^<]*)</a>', html_text(p)):
            m = TITLE_RE.search(title)
            if m:
                rel[(int(m.group(1)), int(m.group(2)))] = {"url": BASE + href, "title": title}
    if not rel:
        ec.fail("no sea-bathing releases found in lists")
    return rel


def pdf_links(html):
    links = []
    for href, label in re.findall(r'<a[^>]+href="([^"]+\.pdf)"[^>]*>([^<]*)', html):
        links.append((urllib.parse.urljoin(BASE, href), z2h(label).replace(" ", "")))
    return links


def main():
    retrieved = ec.today()
    rels = discover_releases()
    fys = sorted({fy for fy, _ in rels})
    records, sources, notes = [], [], []
    for fy in fys:
        rounds = sorted(r for f, r in rels if f == fy)
        info = {}
        table = None
        for rnd in rounds:
            r = rels[(fy, rnd)]
            name = r["url"].rsplit("/", 1)[1]
            html = html_text(get(r["url"], name, min_bytes=2000))
            pub = re.search(r"初期公開日：(\d{4})年(\d+)月(\d+)日", html)
            links = pdf_links(html)
            method = [u for u, lab in links if lab.startswith("調査方法等")]
            if len(method) != 1:
                ec.fail(f"method PDF not uniquely found in {r['url']}: {links}")
            mpath = get(method[0], f"R{fy}-{rnd}-method.pdf", min_bytes=1000, expect_prefix=b"%PDF")
            info[rnd] = {"sampling": parse_sampling(pdf_text(mpath), fy),
                         "o157": o157_from_release(html),
                         "published": f"{pub.group(1)}-{int(pub.group(2)):02d}-{int(pub.group(3)):02d}" if pub else None,
                         "url": r["url"]}
            sources.append({"title": r["title"], "url": r["url"], "published": info[rnd]["published"],
                             "pdfs": [u for u, _ in links]})
            tbl = [u for u, lab in links if lab.startswith(f"令和{fy}年度海水浴場水質検査結果")]
            if rnd == 2 and tbl:
                tpath = get(tbl[0], f"R{fy}-results.pdf", min_bytes=1000, expect_prefix=b"%PDF")
                table = parse_results_table(pdf_text(tpath), fy)
        if table is None:
            notes.append(f"令和{fy}年度は第2回の結果一覧（資料3）が見つからないため、海水浴場別の判定を収録していない。")
            continue
        for b in FUJISAWA_BEACHES:
            for rnd, key, label in ((1, "round1", "シーズン前"), (2, "round2", "シーズン中")):
                if rnd not in info:
                    ec.fail(f"R{fy} round {rnd} release missing but 資料3 present")
                j, g = table[b][key]
                records.append({
                    "fiscalYear": reiwa_to_year(fy),
                    "fiscalYearJa": f"令和{fy}年度",
                    "beach": b,
                    "round": rnd,
                    "roundLabel": label,
                    "testDates": info[rnd]["sampling"],
                    "judgement": j,
                    "grade": None if g in ("-", "不適") else f"水質{g}",
                    "judgementText": f"{j}（水質{g}）" if g not in ("-", "不適") else j,
                    "o157": info[rnd]["o157"],
                    "openingPeriod": ({"from": table[b]["opening"][0], "to": table[b]["opening"][1]}
                                      if table[b]["opening"] else None),
                    "sourceUrl": info[rnd]["url"],
                })
    if not records:
        ec.fail("no records extracted")
    years = sorted({r["fiscalYear"] for r in records})
    out = {
        "status": "ok",
        "generatedAt": ec.now_iso(),
        "retrievedAt": retrieved,
        "period": f"{years[0]}年度〜{years[-1]}年度（県の記者発表一覧で取得できた範囲）",
        "frequency": "毎年度2回（シーズン前の5〜6月頃、シーズン中の7月頃）。各回、期間内の2日間・1日2回採水。",
        "source": {
            "name": "神奈川県 記者発表資料「海水浴場の水質検査の結果について」（健康医療局生活衛生部生活衛生課）",
            "releases": sources,
            "termsUrl": SITE_POLICY,
            "termsSummary": ("神奈川県サイトポリシー: 掲載コンテンツは著作権の対象で、『引用』等の著作権法上認められる範囲で"
                             "自由に利用可、利用時は出典を記載。明示的なオープンデータライセンス（CC BY等）は付されていない。"
                             "本JSONは海水浴場名・判定・採水期間などの事実情報のみを抜き出し、出典URLを付している。"),
            "attribution": "出典：神奈川県『海水浴場の水質検査の結果について』（記者発表資料）",
        },
        "criteria": {
            "basis": "環境省の定める水浴場水質判定基準",
            "items": ["ふん便性大腸菌群数", "油膜の有無", "COD（化学的酸素要求量）", "透明度"],
            "classes": [
                {"judgement": "適", "grade": "水質AA", "fecalColiform": "不検出（検出下限2個/100mL）", "oilFilm": "油膜が認められない", "cod": "2mg/L以下", "transparency": "全透（1m以上）"},
                {"judgement": "適", "grade": "水質A", "fecalColiform": "100個/100mL以下", "oilFilm": "油膜が認められない", "cod": "2mg/L以下", "transparency": "全透（1m以上）"},
                {"judgement": "可", "grade": "水質B", "fecalColiform": "400個/100mL以下", "oilFilm": "常時は油膜が認められない", "cod": "5mg/L以下", "transparency": "1m未満〜50cm以上"},
                {"judgement": "可", "grade": "水質C", "fecalColiform": "1,000個/100mL以下", "oilFilm": "常時は油膜が認められない", "cod": "8mg/L以下", "transparency": "1m未満〜50cm以上"},
                {"judgement": "不適", "grade": None, "fecalColiform": "1,000個/100mLを超える", "oilFilm": "常時油膜が認められる", "cod": "8mg/L超", "transparency": "50cm未満"},
            ],
            "o157": "腸管出血性大腸菌O157の有無も併せて検査。",
            "sourceNote": "判定基準は各回の資料1『調査方法等』の表による。",
        },
        "records": records,
        "notes": notes + [
            "『適』『可』はいずれも水浴に適した水質。『可』（水質B・C）は『適』に比べふん便性大腸菌群数などの基準が緩い区分で、遊泳禁止を意味しない。",
            "判定は年2回・各2日間の採水に基づくもので、その日以外（雨の後など）の水質を保証しない。",
            "O157は『全ての海水浴場において検出されなかった』という県の発表文からの記載。海水浴場別の表は公表されていない。",
            "採水日は県全体の期間で、海水浴場ごとの採水日は公表資料に記載がない。",
            "開設期間は資料3の記載（PDFから読み取れた場合のみ）。実際の開設状況は藤沢市・各海水浴場の案内を確認のこと。",
            "測定値（大腸菌群数・COD等）は記者発表資料に掲載されておらず、判定区分のみを収録。",
        ],
    }
    ec.write_json("water-quality.json", out)


if __name__ == "__main__":
    main()
