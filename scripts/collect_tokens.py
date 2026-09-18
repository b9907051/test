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
    doc = http_json("https://openrouter.ai/api/v1/models")
    out = []
    for m in doc.get("data", []):
        mid = BY_OR.get(base_slug(m.get("id", "")))
        if not mid:
            continue
        p = m.get("pricing") or {}
        i, o = per_million(p.get("prompt")), per_million(p.get("completion"))
        if i is None or o is None:
            continue
        out.append([TODAY, mid, i, o, per_million(p.get("input_cache_read")), "openrouter"])
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


def openrouter_usage(days):
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
    rows = doc.get("data", doc) if isinstance(doc, dict) else doc
    out, totals = [], {}
    for r in rows:
        date = str(r.get("date") or r.get("day") or "")[:10]
        slug = r.get("model_permaslug") or r.get("model") or r.get("permaslug")
        toks = (r.get("total_tokens") or 0) or (float(r.get("prompt_tokens") or 0) + float(r.get("completion_tokens") or 0))
        if not date or not slug or not toks:
            continue
        totals[date] = totals.get(date, 0) + toks
        if slug != "other":
            out.append([date, "openrouter_model", base_slug(slug), float(toks), "openrouter"])
    out += [[d, "openrouter_total", "all", float(t), "openrouter"] for d, t in totals.items()]
    return {"usage": out}


def ornn_otpi(days):
    base = "https://api.ornnai.com"
    key = os.environ.get("ORNN_API_KEY")
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    end = dt.date.today(); start = end - dt.timedelta(days=days)
    out = []
    for lab in LABS:
        q = urllib.parse.urlencode({"lab": lab, "startDate": start.isoformat(), "endDate": end.isoformat()})
        for path in ("/api/otpi", "/api/tokens", "/api/token-index"):
            try:
                doc = http_json(f"{base}{path}?{q}", headers=headers)
            except urllib.error.HTTPError as e:
                if e.code in (404, 405):
                    continue
                raise
            pts = {}
            for d in _walk(doc):
                v = next((d[k] for k in ("value", "price", "settlement", "usd_per_million") if isinstance(d.get(k), (int, float))), None)
                t = next((d[k] for k in ("date", "day", "ts", "timestamp") if isinstance(d.get(k), str)), None)
                if v and t:
                    pts[t[:10]] = round(float(v), 4)
            if pts:
                out += [[d, lab, v, "ornn"] for d, v in pts.items()]
                print(f"  [ornn_otpi] {lab}: {len(pts)} days via {path}")
                break
    return {"otpi": out}


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
    if pdoc["meta"].get("demo") and got["prices"] and any(r[5] != "manual" for r in got["prices"]):
        pdoc["rows"] = [r for r in pdoc["rows"] if r[5] != "demo"]
    if pdoc["meta"].get("demo") and got["otpi"]:
        pdoc["otpi"] = [r for r in pdoc["otpi"] if r[3] != "demo"]
    pdoc["rows"] = merge(pdoc["rows"], got["prices"], 2)
    pdoc["otpi"] = merge(pdoc.get("otpi", []), got["otpi"], 2)
    pdoc["meta"] = {**pdoc["meta"], "generated_at": now, "unit": "USD per 1M tokens",
                    "columns": ["date", "model", "input", "output", "cached_input", "source"],
                    "otpi_columns": ["date", "lab", "usd_per_m", "source"],
                    "demo": any(r[5] == "demo" for r in pdoc["rows"]) or any(r[3] == "demo" for r in pdoc["otpi"])}

    up = DATA / "token_usage.json"
    udoc = load(up, {"meta": {}, "rows": []})
    if udoc["meta"].get("demo") and any(r[4] not in ("manual",) for r in got["usage"] if r[1] != "industry"):
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
