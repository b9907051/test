#!/usr/bin/env python3
"""Collect LLM token prices and usage into data/token_prices.json and data/token_usage.json.

Adapters (each fails independently):
  openrouter_prices  GET https://openrouter.ai/api/v1/models  (public, no key) -> list prices per model
  openrouter_usage   OpenRouter Data API (OPENROUTER_API_KEY required, free account)
                     -> daily/weekly token totals for top-50 models + "other"
  ornn_otpi          Ornn Token Price Index, free tier (trailing month, 4 labs); ORNN_API_KEY optional
  manual             data/token_manual.json: prices with verified_on, industry totals, usage

Run: python3 scripts/collect_tokens.py [--only openrouter_prices,manual] [--days 30] [--dry-run]
"""
from __future__ import annotations
import argparse, datetime as dt, json, os, pathlib, re, sys, urllib.error, urllib.parse, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
CAT = json.loads((DATA / "token_catalog.json").read_text())
MODELS = {m["id"]: m for m in CAT["models"]}
BY_OR = {m["openrouter"]: m["id"] for m in CAT["models"] if m.get("openrouter")}
LABS = {l["id"] for l in CAT["labs"]}
UA = "ai-compute-price-tracker/1.0 (+https://github.com)"
TODAY = dt.date.today().isoformat()


def http_json(url, headers=None, timeout=40):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def per_million(x):
    """OpenRouter prices are USD per single token as strings; -1 means 'variable'."""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return round(v * 1_000_000, 4) if v >= 0 else None


def base_slug(s: str) -> str:
    """'anthropic/claude-opus-5-20260723' -> 'anthropic/claude-opus-5' (strip date / variant suffixes)."""
    s = s.split(":")[0]
    return re.sub(r"-\d{8}$", "", s)


# ----------------------------------------------------------------- prices
def openrouter_prices(days):
    """Standard list prices only: ':batch', ':free', ':thinking' etc. are separate listings at different
    rates (batch = 50% off) and must not be folded into the base model. When several plain ids map to
    one catalog model (e.g. a dated snapshot and an alias) the exact catalog id wins, else the newest."""
    doc = http_json("https://openrouter.ai/api/v1/models")
    best = {}   # catalog model id -> (rank, or_id, i, o, c)
    for m in doc.get("data", []):
        oid = m.get("id", "")
        if ":" in oid:
            continue
        mid = BY_OR.get(base_slug(oid))
        if not mid:
            continue
        p = m.get("pricing") or {}
        i, o = per_million(p.get("prompt")), per_million(p.get("completion"))
        if i is None or o is None or (i == 0 and o == 0):
            continue
        rank = (0 if oid == MODELS[mid]["openrouter"] else 1, -(m.get("created") or 0))
        if mid not in best or rank < best[mid][0]:
            best[mid] = (rank, oid, i, o, per_million(p.get("input_cache_read")))
    out = []
    for mid, (_, oid, i, o, c) in sorted(best.items()):
        print(f"  [openrouter_prices] {mid} <- {oid}: in={i} out={o} cached={c}")
        out.append([TODAY, mid, i, o, c, "openrouter"])
    return {"prices": out}


def manual(days):
    doc = json.loads((DATA / "token_manual.json").read_text())
    prices = [[e["date"], e["model"], float(e["input"]), float(e["output"]),
               (float(e["cached_input"]) if e.get("cached_input") is not None else None), "manual"]
              for e in doc.get("prices", []) if e.get("verified_on") and e.get("model") in MODELS]
    industry = [[e["date"], "industry", e["org"], float(e["tokens_per_month"]), "manual", e.get("name", e["org"]), e.get("source_url", ""), e.get("note", "")]
                for e in doc.get("industry", []) if e.get("tokens_per_month")]
    usage = [[e["date"], e.get("scope", "openrouter_model"), e["key"], float(e["tokens"]), "manual"] for e in doc.get("usage", [])]
    return {"prices": prices, "usage": usage + industry}


# ----------------------------------------------------------------- usage
OR_USAGE_PATHS = ["/api/v1/datasets/model-rankings", "/api/v1/datasets/rankings-daily",
                  "/api/v1/datasets/daily-token-totals", "/api/v1/datasets/rankings/daily"]


def _num(x):
    """OpenRouter returns large token counts as strings ("123456789"); accept int/float/str, else 0."""
    if isinstance(x, bool) or x is None:
        return 0.0
    if isinstance(x, (int, float)):
        return float(x)
    try:
        return float(str(x).replace(",", "").strip())
    except ValueError:
        return 0.0


def openrouter_usage(days):
    """OpenRouter Data API: top-50 models per period by total tokens, plus one aggregated "other" row.
    The platform total for a period = sum of all rows (top 50 + other). Rows are bucketed into
    7-day windows ending on the latest date whenever the API returns daily rows, so the dashboard's
    "weekly" figures stay weekly regardless of the granularity the endpoint serves."""
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        raise RuntimeError("OPENROUTER_API_KEY not set (free key from openrouter.ai/settings/keys)")
    headers = {"Authorization": f"Bearer {key}"}
    q = urllib.parse.urlencode({"period": "week"})
    doc = None
    for path in OR_USAGE_PATHS:
        try:
            doc = http_json(f"https://openrouter.ai{path}?{q}", headers=headers)
            print(f"  [openrouter_usage] using {path}")
            break
        except urllib.error.HTTPError as e:
            if e.code in (404, 405):
                continue
            raise
    if doc is None:
        raise RuntimeError("no configured Data API path answered; check openrouter.ai/docs/api/api-reference/datasets and edit OR_USAGE_PATHS")

    rows = doc
    if isinstance(doc, dict):
        rows = doc.get("data", doc.get("rows", doc.get("results", [])))
        if isinstance(rows, dict):   # e.g. {"data": {"rows": [...]}}
            rows = next((v for v in rows.values() if isinstance(v, list)), [])
    if not isinstance(rows, list):
        raise RuntimeError(f"unexpected response shape: {json.dumps(doc)[:300]}")
    print(f"  [openrouter_usage] {len(rows)} rows; first row: {json.dumps(rows[0])[:300] if rows else '-'}")

    per = {}      # (date, slug) -> tokens
    for r in rows:
        if not isinstance(r, dict):
            continue
        date = str(r.get("date") or r.get("day") or r.get("period_start") or r.get("week") or "")[:10]
        slug = r.get("model_permaslug") or r.get("permaslug") or r.get("model") or r.get("slug")
        toks = _num(r.get("total_tokens")) or (_num(r.get("prompt_tokens")) + _num(r.get("completion_tokens"))) or _num(r.get("tokens"))
        if not date or not slug or toks <= 0:
            continue
        k = (date, slug)
        per[k] = per.get(k, 0.0) + toks

    dates = sorted({d for d, _ in per})
    if not dates:
        raise RuntimeError("response had no usable (date, model, tokens) rows")
    gaps = [(dt.date.fromisoformat(b) - dt.date.fromisoformat(a)).days for a, b in zip(dates, dates[1:])]
    daily = bool(gaps) and statistics_median(gaps) <= 1.5
    print(f"  [openrouter_usage] {len(dates)} periods {dates[0]}..{dates[-1]} ({'daily -> 7-day buckets' if daily else 'weekly'})")

    if daily:
        last = dt.date.fromisoformat(dates[-1])
        def bucket(d):
            back = (last - dt.date.fromisoformat(d)).days
            return (last - dt.timedelta(days=(back // 7) * 7)).isoformat()   # label = last day of the 7-day window
        counts = {}
        for d in dates:
            counts[bucket(d)] = counts.get(bucket(d), 0) + 1
        complete = {bk for bk, n in counts.items() if n >= 7}
        agg = {}
        for (d, slug), v in per.items():
            bk = bucket(d)
            if bk in complete:
                agg[(bk, slug)] = agg.get((bk, slug), 0.0) + v
        per = agg

    out, totals = [], {}
    for (d, slug), v in per.items():
        totals[d] = totals.get(d, 0.0) + v
        if slug != "other":
            out.append([d, "openrouter_model", base_slug(slug), round(v), "openrouter"])
    out += [[d, "openrouter_total", "all", round(t), "openrouter"] for d, t in totals.items()]
    if totals:
        lastd = max(totals)
        print(f"  [openrouter_usage] latest window {lastd}: {totals[lastd] / 1e12:.2f} T tokens across {sum(1 for r in out if r[0] == lastd and r[1] == 'openrouter_model')} models")
    return {"usage": out}


def statistics_median(xs):
    xs = sorted(xs); m = len(xs) // 2
    return xs[m] if len(xs) % 2 else (xs[m - 1] + xs[m]) / 2


def ornn_otpi(days):
    """Ornn Token Price Index. Free tier: GET /api/otpi?lab=<lab>[&startDate&endDate] -> trailing month.
    Without a lab the endpoint returns every free lab at once; rows look like
    {"date": "2026-08-19", "lab": "anthropic", "indexPerMtok": 2.19, "computedAt": ...}."""
    base = "https://api.ornnai.com"
    key = os.environ.get("ORNN_API_KEY")
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    end = dt.date.today(); start = end - dt.timedelta(days=min(days, 30 if not key else days))
    def rows_of(doc):
        out = []
        for d in _walk(doc):
            lab = d.get("lab"); v = d.get("indexPerMtok", d.get("index_per_mtok", d.get("value")))
            t = d.get("date")
            if isinstance(lab, str) and isinstance(v, (int, float)) and isinstance(t, str) and v > 0:
                out.append([t[:10], lab.lower(), round(float(v), 4), "ornn"])
        return out
    attempts = [f"{base}/api/otpi?" + urllib.parse.urlencode({"startDate": start.isoformat(), "endDate": end.isoformat()}), f"{base}/api/otpi"]
    for lab in sorted(LABS):
        attempts.append(f"{base}/api/otpi?" + urllib.parse.urlencode({"lab": lab, "startDate": start.isoformat(), "endDate": end.isoformat()}))
    got = {}
    for url in attempts:
        try:
            rows = rows_of(http_json(url, headers=headers))
        except urllib.error.HTTPError as e:
            try: body = e.read().decode()[:200]
            except Exception: body = ""
            print(f"  [ornn_otpi] {url.split('?')[0]}?{url.split('?')[1][:40] if '?' in url else ''} -> {e.code} {body}", file=sys.stderr)
            continue
        for r in rows:
            got[(r[0], r[1])] = r
        if rows and "lab=" not in url:
            break  # the all-labs call worked; no need for per-lab calls
    labs_seen = sorted({r[1] for r in got.values()})
    print(f"  [ornn_otpi] {len(got)} rows, labs={labs_seen}")
    return {"otpi": [r for r in got.values() if r[1] in LABS]}


def _walk(o):
    if isinstance(o, dict):
        yield o
        for v in o.values(): yield from _walk(v)
    elif isinstance(o, list):
        for v in o: yield from _walk(v)


ADAPTERS = {"openrouter_prices": openrouter_prices, "openrouter_usage": openrouter_usage, "ornn_otpi": ornn_otpi, "manual": manual}


# ----------------------------------------------------------------- main
def load(path, default):
    return json.loads(path.read_text()) if path.exists() else default


def merge(existing, new, keylen):
    keyed = {tuple(r[:keylen]): r for r in existing}
    for r in new:
        keyed[tuple(r[:keylen])] = r
    return sorted(keyed.values(), key=lambda r: [str(x) for x in r[:keylen]])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default=",".join(ADAPTERS))
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    got = {"prices": [], "otpi": [], "usage": []}
    for name in [n.strip() for n in a.only.split(",") if n.strip()]:
        try:
            res = ADAPTERS[name](a.days)
            for k, v in res.items():
                got[k] += v
            print(f"[{name}] " + ", ".join(f"{k}={len(v)}" for k, v in res.items()))
        except Exception as e:  # noqa: BLE001
            print(f"[{name}] FAILED: {e}", file=sys.stderr)

    live = any(r[-1] not in ("demo", "manual") for k in got for r in got[k] if k != "usage") or any(r[4] != "manual" for r in got["usage"])
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")

    pp = DATA / "token_prices.json"
    pdoc = load(pp, {"meta": {}, "rows": [], "otpi": []})
    if any(r[5] not in ("manual", "demo") for r in got["prices"]):
        pdoc["rows"] = [r for r in pdoc["rows"] if r[5] != "demo"]
    if any(r[3] != "demo" for r in got["otpi"]):
        pdoc["otpi"] = [r for r in pdoc.get("otpi", []) if r[3] != "demo"]
    pdoc["rows"] = merge(pdoc["rows"], got["prices"], 2)
    pdoc["otpi"] = merge(pdoc.get("otpi", []), got["otpi"], 2)
    pdoc["meta"] = {**pdoc["meta"], "generated_at": now, "unit": "USD per 1M tokens",
                    "columns": ["date", "model", "input", "output", "cached_input", "source"],
                    "otpi_columns": ["date", "lab", "usd_per_m", "source"],
                    "demo": any(r[5] == "demo" for r in pdoc["rows"]) or any(r[3] == "demo" for r in pdoc["otpi"])}

    up = DATA / "token_usage.json"
    udoc = load(up, {"meta": {}, "rows": []})
    if any(r[4] not in ("manual", "demo") for r in got["usage"] if r[1] != "industry"):
        udoc["rows"] = [r for r in udoc["rows"] if r[4] != "demo"]
    udoc["rows"] = merge(udoc["rows"], got["usage"], 3)
    udoc["meta"] = {**udoc["meta"], "generated_at": now, "unit": "tokens",
                    "columns": ["date", "scope", "key", "tokens", "source", "name?", "source_url?", "note?"],
                    "demo": any(r[4] == "demo" for r in udoc["rows"])}

    if a.dry_run:
        print(json.dumps({k: v[:5] for k, v in got.items()}, indent=1, ensure_ascii=False)); return
    pp.write_text(json.dumps(pdoc, separators=(",", ":"), ensure_ascii=False))
    up.write_text(json.dumps(udoc, separators=(",", ":"), ensure_ascii=False))
    print(f"wrote {len(pdoc['rows'])} price rows, {len(pdoc['otpi'])} otpi rows, {len(udoc['rows'])} usage rows")


if __name__ == "__main__":
    main()
