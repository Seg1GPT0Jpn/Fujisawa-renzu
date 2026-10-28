"""Shared helpers for the environment-data scripts (download, JSON output).

Downloads are treated as untrusted data: nothing from them is executed.
All raw files go under .cache/env/ (gitignored); only small aggregated JSON
is written under site/data/environment/.
"""
import datetime as _dt
import hashlib
import json
import os
import sys
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CACHE = os.path.join(ROOT, ".cache", "env")
OUT_DIR = os.path.join(ROOT, "site", "data", "environment")
UA = "fujisawa-renzu-envdata/1.0 (+static site build script)"
JST = _dt.timezone(_dt.timedelta(hours=9))


def today():
    return _dt.datetime.now(JST).date().isoformat()


def now_iso():
    return _dt.datetime.now(JST).replace(microsecond=0).isoformat()


class FormatError(RuntimeError):
    """Raised when a source does not look the way the script expects."""


def fail(msg):
    raise FormatError(msg)


def fetch(url, dest, refresh=False, min_bytes=1, expect_prefix=None):
    """Download url to dest (unless cached). Fails loudly on HTTP errors,
    suspiciously small files, or unexpected magic bytes."""
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    refresh = refresh or os.environ.get("ENV_REFRESH") == "1"
    if refresh or not os.path.exists(dest):
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=120) as r:
            if r.status != 200:
                fail(f"HTTP {r.status} for {url}")
            data = r.read()
        tmp = dest + ".part"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, dest)
    size = os.path.getsize(dest)
    if size < min_bytes:
        fail(f"{dest} is only {size} bytes (expected >= {min_bytes})")
    if expect_prefix is not None:
        with open(dest, "rb") as f:
            head = f.read(len(expect_prefix))
        if head != expect_prefix:
            fail(f"{dest}: unexpected file signature {head!r}")
    return dest


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def write_json(name, obj, max_bytes=30_000):
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, name)
    text = json.dumps(obj, ensure_ascii=False, indent=1, allow_nan=False)
    data = text.encode("utf-8") + b"\n"
    if len(data) > max_bytes:  # fall back to compact encoding before giving up
        text = json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        data = text.encode("utf-8") + b"\n"
    if len(data) > max_bytes:
        fail(f"{name} would be {len(data)} bytes (> {max_bytes}); refusing to write")
    with open(path + ".tmp", "wb") as f:
        f.write(data)
    os.replace(path + ".tmp", path)
    print(f"wrote {path} ({len(data)} bytes)", file=sys.stderr)
    return path
