#!/usr/bin/env python3
"""Collect today's accelerator rental prices and append them to data/prices.json.

Sources (each adapter fails independently and is skipped with a warning):
  * Vast.ai   – public marketplace search API, no key required
  * RunPod    – public GraphQL gpuTypes query (RUNPOD_API_KEY optional)
  * Lambda    – instance-types API (LAMBDA_API_KEY required)
  * list      – hand-maintained data/list_prices.json (hyperscalers etc.)

Only the Python standard library is used. Run:  python3 scripts/collect.py
Options: --date YYYY-MM-DD  --dry-run  --only vast,runpod,lambda,list
"""
from __future__ import annotations
import argparse, base64, datetime as dt, json, os, pathlib, statistics, sys, urllib.request, urllib.parse, urllib.error

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
CATALOG = json.loads((DATA / "catalog.json").read_text())
GPUS = {g["id"]: g for g in CATALOG["gpus"]}
UA = "ai-compute-price-tracker/1.0 (+https://github.com)"


def http_json(url: str, *, method="GET", body=None, headers=None, timeout=30):
    req = urllib.request.Request(url, method=method, headers={"User-Agent": UA, "Accept": "application/json", **(headers or {})})
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, data=data, timeout=timeout) as r:
        return json.loads(r.read().decode())


def alias_index(source: str) -> dict[str, str]:
    """Map provider-specific GPU names -> catalog gpu id."""
    idx = {}
    for g in CATALOG["gpus"]:
        for name in g.get("aliases", {}).get(source, []):
            idx[name.lower()] = g["id"]
    return idx


def robust_price(values: list[float]) -> float | None:
    """Representative 'what you can actually rent now' price: median of the cheapest quintile
    (at least 3 offers). This shrugs off a single mispriced listing at either end."""
    vals = sorted(v for v in values if v and v > 0)
    if not vals:
        return None
    k = max(3, len(vals) // 5)
    return round(statistics.median(vals[:k]), 3)


# --------------------------------------------------------------------------- adapters
def collect_vast() -> list[tuple[str, str, str, float]]:
    out = []
    idx = alias_index("vast")
    for vast_name in sorted(set(n for g in CATALOG["gpus"] for n in g.get("aliases", {}).get("vast", []))):
        gpu_id = idx[vast_name.lower()]
        for vtype, ptype in (("on-demand", "on-demand"), ("bid", "spot")):
            q = {"verified": {"eq": True}, "rentable": {"eq": True}, "num_gpus": {"eq": 1},
                 "gpu_name": {"eq": vast_name}, "type": vtype, "order": [["dph_total", "asc"]], "limit": 64}
            url = "https://console.vast.ai/api/v0/bundles/?q=" + urllib.parse.quote(json.dumps(q))
            try:
                res = http_json(url)
            except Exception as e:  # noqa: BLE001
                print(f"  [vast] {vast_name}/{vtype}: {e}", file=sys.stderr)
                continue
            key = "min_bid" if vtype == "bid" else "dph_total"
            price = robust_price([o.get(key) or o.get("dph_total") for o in res.get("offers", [])])
            if price:
                out.append((gpu_id, ptype, "vast", price))
    return out


def collect_runpod():
    out = []
    idx = alias_index("runpod")
    key = os.environ.get("RUNPOD_API_KEY")
    url = "https://api.runpod.io/graphql" + (f"?api_key={key}" if key else "")
    query = """{ gpuTypes { id displayName memoryInGb securePrice communityPrice
                 lowestPrice(input:{gpuCount:1}) { minimumBidPrice uninterruptablePrice } } }"""
    res = http_json(url, method="POST", body={"query": query})
    for gt in res.get("data", {}).get("gpuTypes", []):
        gpu_id = idx.get((gt.get("id") or "").lower()) or idx.get((gt.get("displayName") or "").lower())
        if not gpu_id:
            continue
        lp = gt.get("lowestPrice") or {}
        od = lp.get("uninterruptablePrice") or gt.get("securePrice") or gt.get("communityPrice")
        spot = lp.get("minimumBidPrice")
        if od:
            out.append((gpu_id, "on-demand", "runpod", round(float(od), 3)))
        if spot:
            out.append((gpu_id, "spot", "runpod", round(float(spot), 3)))
    return out


def collect_lambda():
    key = os.environ.get("LAMBDA_API_KEY")
    if not key:
        raise RuntimeError("LAMBDA_API_KEY not set")
    idx = alias_index("lambda")
    auth = base64.b64encode(f"{key}:".encode()).decode()
    res = http_json("https://cloud.lambda.ai/api/v1/instance-types", headers={"Authorization": f"Basic {auth}"})
    best: dict[str, float] = {}
    for name, item in res.get("data", {}).items():
        gpu_id = idx.get(name.lower())
        if not gpu_id:
            continue
        it = item["instance_type"]
        n = max(1, int(it.get("specs", {}).get("gpus", 1)))
        per_gpu = it["price_cents_per_hour"] / 100 / n
        best[gpu_id] = min(best.get(gpu_id, per_gpu), per_gpu)
    return [(g, "on-demand", "lambda", round(p, 3)) for g, p in best.items()]


def collect_list():
    out = []
    doc = json.loads((DATA / "list_prices.json").read_text())
    for e in doc["entries"]:
        if e.get("verified_on") and e.get("usd"):
            out.append((e["gpu"], e.get("type", "on-demand"), e["provider"], float(e["usd"])))
    return out


ADAPTERS = {"vast": collect_vast, "runpod": collect_runpod, "lambda": collect_lambda, "list": collect_list}


# --------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=dt.date.today().isoformat())
    ap.add_argument("--only", default=",".join(ADAPTERS))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    path = DATA / "prices.json"
    doc = json.loads(path.read_text()) if path.exists() else {"meta": {}, "rows": []}
    rows = doc["rows"]
    if doc.get("meta", {}).get("demo"):
        print("prices.json currently holds DEMO data; live rows will be appended and the demo flag cleared.")
        rows = [r for r in rows if r[5] != "demo"]  # drop synthetic history once real data arrives

    new = []
    for name in args.only.split(","):
        fn = ADAPTERS[name.strip()]
        try:
            got = fn()
            print(f"[{name}] {len(got)} prices")
            for gpu_id, ptype, prov, usd in got:
                if gpu_id not in GPUS:
                    continue
                new.append([args.date, prov, gpu_id, ptype, usd, name if name != "list" else "list"])
        except Exception as e:  # noqa: BLE001
            print(f"[{name}] FAILED: {e}", file=sys.stderr)

    # replace any existing row for the same (date, provider, gpu, type)
    keyed = {tuple(r[:4]): r for r in rows}
    for r in new:
        keyed[tuple(r[:4])] = r
    rows = sorted(keyed.values())

    doc["rows"] = rows
    doc["meta"] = {**doc.get("meta", {}),
                   "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                   "demo": False if new else doc.get("meta", {}).get("demo", False),
                   "unit": "USD per accelerator-hour",
                   "columns": ["date", "provider", "gpu", "type", "usd", "source"]}
    doc["meta"].pop("note", None)
    if args.dry_run:
        print(json.dumps(new, indent=1))
        return
    path.write_text(json.dumps(doc, separators=(",", ":")))
    print(f"wrote {len(rows)} rows ({len(new)} new/updated) -> {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
