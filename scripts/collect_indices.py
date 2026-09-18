#!/usr/bin/env python3
"""Collect third-party GPU rental price *indices* into data/indices.json.

Sources are configured in data/index_sources.json (endpoints editable without code changes):
  cgi   Computable GPU Index      – open flat files / API, no key
  ocpi  Ornn Compute Price Index  – free tier (latest + 3 months, 5 GPUs), no key
  sdh   Silicon Data indices      – paid API; needs SILICONDATA_USERNAME / SILICONDATA_PASSWORD
  gci   AxonIndex                 – no public API; values come from data/index_manual.json
Manual entries in data/index_manual.json are always merged in.

Run:  python3 scripts/collect_indices.py [--only cgi,ocpi] [--days 90] [--dry-run]
Rows: [date, index_id, gpu_id, value_usd_per_gpu_hour, source]
"""
from __future__ import annotations
import argparse, datetime as dt, json, os, pathlib, re, sys, urllib.error, urllib.parse, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
CFG = json.loads((DATA / "index_sources.json").read_text())
SOURCES = {s["id"]: s for s in CFG["indices"]}
GPUS = {g["id"] for g in json.loads((DATA / "catalog.json").read_text())["gpus"]}
UA = "ai-compute-price-tracker/1.0 (+https://github.com)"
DATE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})")


def http_json(url, *, method="GET", body=None, headers=None, form=None, timeout=30):
    data = None
    hdrs = {"User-Agent": UA, "Accept": "application/json", **(headers or {})}
    if form is not None:
        data = urllib.parse.urlencode(form).encode(); hdrs["Content-Type"] = "application/x-www-form-urlencoded"
    elif body is not None:
        data = json.dumps(body).encode(); hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


# ----------------------------------------------------------------- tolerant record extraction
NUM_KEYS = ("value", "index_value", "indexPerGpuHour", "indexPerHour", "index_per_gpu_hour", "price", "settlement", "settle", "close", "usd_per_gpu_hour", "index")
TS_KEYS = ("date", "day", "ts", "timestamp", "time", "observed_at", "as_of", "settled_at", "fixing_date")


def walk(obj):
    """yield every dict anywhere inside a JSON document"""
    if isinstance(obj, dict):
        yield obj
        for v in obj.values(): yield from walk(v)
    elif isinstance(obj, list):
        for v in obj: yield from walk(v)


def extract_points(doc, default_date=None):
    """Return {date: value} from any JSON shape that has (numeric value, date-like) pairs.
    Later points on the same day overwrite earlier ones (= closing value)."""
    pts = {}
    for d in walk(doc):
        val = next((d[k] for k in NUM_KEYS if isinstance(d.get(k), (int, float)) and not isinstance(d.get(k), bool)), None)
        if val is None or val <= 0:
            continue
        ts = next((d[k] for k in TS_KEYS if isinstance(d.get(k), (str, int, float))), None)
        date = None
        if isinstance(ts, str):
            m = DATE_RE.match(ts); date = m.group(1) if m else None
        elif isinstance(ts, (int, float)):
            date = dt.datetime.fromtimestamp(ts / (1000 if ts > 1e11 else 1), dt.timezone.utc).date().isoformat()
        date = date or default_date
        if date:
            pts[date] = round(float(val), 4)
    return pts


# ----------------------------------------------------------------- adapters
def collect_cgi(days):
    src = SOURCES["cgi"]; base = src["endpoint"]["flat_base"].rstrip("/")
    latest = http_json(f"{base}/latest.json")
    # find every dict that names a SKU, wherever it sits in the document
    entries = [d for d in walk(latest) if isinstance(d.get("sku") or d.get("gpu") or d.get("model"), str)]
    if not entries:
        print(f"  [cgi] no sku entries found; latest.json top-level keys={list(latest)[:8]} head={json.dumps(latest)[:400]}", file=sys.stderr)
    out = []
    today = dt.date.today()
    for gpu_id, sku in src["gpus"].items():
        entry = next((v for v in entries if str(v.get("sku") or v.get("gpu") or v.get("model")).lower() == sku), None)
        if not entry:
            print(f"  [cgi] sku {sku} not in latest.json (have: {sorted({str(v.get('sku') or v.get('gpu') or v.get('model')) for v in entries})[:12]})", file=sys.stderr); continue
        prefix = entry.get("history_path") or entry.get("path") or f"{sku}/v{entry.get('current_version') or entry.get('version') or 1}"
        got = 0; first_url = None; misses = 0
        for i in range(days):
            day = today - dt.timedelta(days=i)
            url = f"{base}/{prefix.strip('/')}/observations/{day:%Y}/{day:%m}/{day:%d}.json"
            first_url = first_url or url
            try:
                doc = http_json(url)
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    misses += 1
                    if misses >= 5 and got == 0: break   # layout is wrong; stop hammering the CDN
                    continue
                raise
            pts = extract_points(doc, default_date=day.isoformat())
            if day.isoformat() in pts:
                out.append((day.isoformat(), "cgi", gpu_id, pts[day.isoformat()])); got += 1
        if got == 0:
            print(f"  [cgi] {sku}: flat files 404 (entry={json.dumps(entry)[:300]} first_url={first_url}); trying API", file=sys.stderr)
            api = src["endpoint"].get("api_base", "https://api.getcomputable.com/v1/index").rstrip("/")
            for url in (f"{api}/{sku}/history?days={days}", f"{api}/{sku}/history", f"{api}/{sku}/latest", f"{api}/{sku}", f"{api}/latest?sku={sku}"):
                try:
                    doc = http_json(url)
                except urllib.error.HTTPError as e:
                    print(f"  [cgi] {url} -> {e.code}", file=sys.stderr); continue
                pts = extract_points(doc, default_date=today.isoformat())
                if pts:
                    out += [(d, "cgi", gpu_id, v) for d, v in pts.items()]; got = len(pts)
                    print(f"  [cgi] {sku}: {got} days via {url}"); break
                print(f"  [cgi] {url} answered but no points; head={json.dumps(doc)[:250]}", file=sys.stderr)
        else:
            print(f"  [cgi] {sku}: {got} days")
    return out


def collect_ocpi(days):
    src = SOURCES["ocpi"]; ep = src["endpoint"]; base = ep["api_base"].rstrip("/")
    key = os.environ.get("ORNN_API_KEY")
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    try:
        types = http_json(base + ep["types_path"], headers=headers)
        items = types if isinstance(types, list) else types.get("data", types.get("gpuTypes", types.get("gpu_types", [])))
        names = {str((x.get("gpu_name") or x.get("gpuName") or x.get("name") or x.get("id")) if isinstance(x, dict) else x) for x in items}
        print(f"  [ocpi] free-tier GPUs: {sorted(names)}")
    except Exception as e:  # noqa: BLE001
        names = set(); print(f"  [ocpi] gpu-types-free failed: {e}", file=sys.stderr)
    end = dt.date.today(); start = end - dt.timedelta(days=days)
    out = []
    for gpu_id, gpu_name in src["gpus"].items():
        if names and gpu_name not in names and not key:
            continue
        pts = None; tried = []
        for param in dict.fromkeys([ep.get("gpu_param", "gpu_name"), "gpu_name", "gpuName"]):
            for path in ep["price_paths"]:
                doc = None
                # free tier caps the range; a range the tier does not allow can come back as 401/403 -> retry without dates
                for qs in ({param: gpu_name, "startDate": start.isoformat(), "endDate": end.isoformat()}, {param: gpu_name}):
                    url = f"{base}{path}?" + urllib.parse.urlencode(qs); tried.append(url)
                    try:
                        doc = http_json(url, headers=headers); break
                    except urllib.error.HTTPError as e:
                        try: body = e.read().decode()[:160]
                        except Exception: body = ""
                        print(f"  [ocpi] {path}?{param}=... -> {e.code} {body}", file=sys.stderr)
                        if e.code in (400, 401, 403, 404, 405, 422): continue
                        raise
                if doc is None: continue
                pts = extract_points(doc)
                if pts:
                    print(f"  [ocpi] {gpu_name}: {len(pts)} days via {path}?{param}="); break
                print(f"  [ocpi] {gpu_name}: {path} answered but no (date,value) pairs found; head={json.dumps(doc)[:300]}", file=sys.stderr)
            if pts: break
        if not pts:
            print(f"  [ocpi] {gpu_name}: no data. tried: {tried[:3]} ... – check data.ornn.com/docs and update price_paths", file=sys.stderr); continue
        out += [(d, "ocpi", gpu_id, v) for d, v in pts.items()]
    return out


def collect_sdh(days):
    user, pw = os.environ.get("SILICONDATA_USERNAME"), os.environ.get("SILICONDATA_PASSWORD")
    if not (user and pw):
        raise RuntimeError("SILICONDATA_USERNAME / SILICONDATA_PASSWORD not set (Plus/Professional plan required)")
    src = SOURCES["sdh"]; ep = src["endpoint"]
    tok = http_json(ep["token_url"], method="POST", form={"username": user, "password": pw, "grant_type": "password"})
    headers = {"Authorization": f"Bearer {tok.get('access_token') or tok.get('token')}"}
    end = dt.date.today(); out = []
    for gpu_id, gpu in src["gpus"].items():
        cursor = end - dt.timedelta(days=days)
        while cursor <= end:  # API caps each request at 7 days
            chunk_end = min(cursor + dt.timedelta(days=6), end)
            doc = http_json(ep["index_url"], method="POST", headers=headers,
                            body={"gpu": gpu, "starting_date": cursor.isoformat(), "ending_date": chunk_end.isoformat()})
            out += [(d, "sdh", gpu_id, v) for d, v in extract_points(doc).items() if v > 0]  # negative = not generated yet
            cursor = chunk_end + dt.timedelta(days=1)
    return out


def collect_manual(days):
    doc = json.loads((DATA / "index_manual.json").read_text())
    return [(e["date"], e["index"], e["gpu"], float(e["value"]), "manual") for e in doc.get("entries", []) if e.get("value")]


ADAPTERS = {"cgi": collect_cgi, "ocpi": collect_ocpi, "sdh": collect_sdh}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default=",".join(ADAPTERS))
    ap.add_argument("--days", type=int, default=90)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    path = DATA / "indices.json"
    doc = json.loads(path.read_text()) if path.exists() else {"meta": {}, "rows": []}
    rows = doc.get("rows", [])
    new = []
    for name in [n.strip() for n in a.only.split(",") if n.strip()]:
        try:
            got = ADAPTERS[name](a.days)
            print(f"[{name}] {len(got)} points")
            new += [[d, idx, g, v, name] for d, idx, g, v in got if g in GPUS]
        except Exception as e:  # noqa: BLE001
            print(f"[{name}] FAILED: {e}", file=sys.stderr)
    manual = [[d, idx, g, v, s] for d, idx, g, v, s in collect_manual(a.days) if g in GPUS and idx in SOURCES]
    print(f"[manual] {len(manual)} points")
    new += manual

    live = [r for r in new]
    if doc.get("meta", {}).get("demo") and any(r[4] != "manual" for r in live):
        print("indices.json holds DEMO data; dropping synthetic rows now that live data arrived.")
        rows = [r for r in rows if r[4] != "demo"]
    keyed = {tuple(r[:3]): r for r in rows}
    for r in new: keyed[tuple(r[:3])] = r
    rows = sorted(keyed.values())
    doc["rows"] = rows
    doc["meta"] = {**doc.get("meta", {}), "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                   "demo": bool(rows) and all(r[4] == "demo" for r in rows), "unit": "USD per GPU-hour",
                   "columns": ["date", "index", "gpu", "value", "source"]}
    doc["meta"].pop("note", None)
    if a.dry_run:
        print(json.dumps(new[:20], indent=1)); return
    path.write_text(json.dumps(doc, separators=(",", ":")))
    print(f"wrote {len(rows)} rows ({len(new)} new/updated) -> {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
