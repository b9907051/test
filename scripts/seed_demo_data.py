#!/usr/bin/env python3
"""Generate an illustrative demo price history into data/prices.json.

The numbers are *synthetic*: they follow the broad shape of the 2025-2026
rental market (H100 prices sliding, Blackwell arriving expensive, hyperscaler
list prices moving in steps) but are NOT real quotes. The dashboard shows a
"demo data" banner while meta.demo is true; running scripts/collect.py with
real sources replaces it.
"""
import json, random, datetime as dt, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "prices.json"

random.seed(20260916)
END = dt.date(2026, 9, 15)
WEEKS = 78  # ~18 months of weekly snapshots

# base on-demand price at END (USD / GPU-hour) and annualised drift (negative = getting cheaper)
# (provider, gpu): (price_at_end, yearly_drift, spot_discount or None)
BASE = {
    ("aws", "h100-sxm"): (6.88, -0.20, 0.55), ("aws", "a100-80"): (4.10, -0.05, 0.60),
    ("aws", "trainium2"): (1.30, -0.10, None), ("aws", "b200"): (12.40, -0.15, None),
    ("gcp", "h100-sxm"): (11.06, -0.05, 0.40), ("gcp", "a100-80"): (4.50, -0.03, 0.55),
    ("gcp", "tpu-v6e"): (2.70, -0.05, 0.35), ("gcp", "tpu-v5p"): (4.20, -0.05, 0.35),
    ("gcp", "h200"): (10.71, -0.08, 0.45), ("gcp", "b200"): (13.90, -0.10, 0.45),
    ("azure", "h100-sxm"): (12.29, -0.03, 0.45), ("azure", "a100-80"): (3.67, 0.0, 0.55),
    ("azure", "mi300x"): (6.52, -0.10, None), ("azure", "h200"): (11.20, -0.05, None),
    ("oci", "h100-sxm"): (10.00, 0.0, None), ("oci", "a100-80"): (4.00, 0.0, None),
    ("oci", "mi300x"): (6.00, 0.0, None), ("oci", "h200"): (10.00, 0.0, None), ("oci", "b200"): (12.00, 0.0, None),
    ("coreweave", "h100-sxm"): (6.16, -0.15, None), ("coreweave", "h200"): (6.31, -0.10, None),
    ("coreweave", "a100-80"): (2.21, -0.10, None), ("coreweave", "l40s"): (2.25, -0.05, None),
    ("coreweave", "b200"): (8.60, -0.20, None), ("coreweave", "rtx4090"): (0.90, -0.05, None),
    ("lambda", "h100-sxm"): (2.99, -0.22, None), ("lambda", "h200"): (3.79, -0.20, None),
    ("lambda", "a100-80"): (1.79, -0.10, None), ("lambda", "b200"): (4.99, -0.25, None),
    ("nebius", "h100-sxm"): (2.95, -0.25, None), ("nebius", "h200"): (3.50, -0.25, None),
    ("nebius", "b200"): (5.50, -0.30, None), ("nebius", "l40s"): (1.55, -0.10, None),
    ("crusoe", "h100-sxm"): (3.90, -0.15, 1.00), ("crusoe", "h200"): (4.29, -0.15, None),
    ("crusoe", "a100-80"): (2.30, -0.10, None), ("crusoe", "l40s"): (1.45, -0.05, None),
    ("crusoe", "mi300x"): (3.30, -0.20, None), ("crusoe", "b200"): (6.40, -0.25, None),
    ("together", "h100-sxm"): (2.99, -0.30, None), ("together", "h200"): (3.79, -0.30, None),
    ("together", "b200"): (5.50, -0.35, None), ("together", "a100-80"): (1.75, -0.10, None),
    ("runpod", "h100-sxm"): (2.69, -0.25, 0.60), ("runpod", "h200"): (3.59, -0.25, 0.60),
    ("runpod", "a100-80"): (1.64, -0.15, 0.55), ("runpod", "l40s"): (0.86, -0.15, 0.55),
    ("runpod", "rtx4090"): (0.44, -0.20, 0.55), ("runpod", "rtx5090"): (0.89, -0.20, 0.60),
    ("runpod", "b200"): (5.98, -0.30, 0.65), ("runpod", "mi300x"): (2.49, -0.30, 0.60),
    ("vast", "h100-sxm"): (1.87, -0.30, 0.50), ("vast", "h200"): (2.40, -0.30, 0.55),
    ("vast", "a100-80"): (0.98, -0.20, 0.50), ("vast", "l40s"): (0.62, -0.20, 0.50),
    ("vast", "rtx4090"): (0.31, -0.25, 0.45), ("vast", "rtx5090"): (0.62, -0.25, 0.50),
    ("vast", "b200"): (4.10, -0.35, 0.55), ("vast", "mi300x"): (1.90, -0.30, None),
    ("hyperbolic", "h100-sxm"): (1.49, -0.30, None), ("hyperbolic", "a100-80"): (1.10, -0.15, None),
    ("hyperbolic", "rtx4090"): (0.35, -0.20, None), ("hyperbolic", "h200"): (2.20, -0.30, None),
    # newer AMD / Intel parts appear part-way through the window (see START_WEEK)
    ("azure", "mi325x"): (7.50, -0.10, None), ("crusoe", "mi325x"): (3.95, -0.20, None),
    ("vast", "mi325x"): (2.30, -0.30, None), ("crusoe", "mi355x"): (5.90, -0.25, None),
    ("oci", "mi355x"): (8.60, 0.0, None), ("vast", "mi355x"): (3.80, -0.35, None),
    ("gaudi3-ibm", "gaudi3"): (3.15, -0.10, None),
}
# some SKUs only start being offered N weeks before END
START_WEEK = {"b200": 60, "mi325x": 55, "mi355x": 22, "rtx5090": 60, "tpu-v6e": 78}

# Gaudi 3 is offered by IBM Cloud; map it onto a provider that exists in the catalog.
# (For the demo we attribute it to "oci" so we don't need an extra provider row.)
BASE[("oci", "gaudi3")] = BASE.pop(("gaudi3-ibm", "gaudi3"))

rows = []
for (prov, gpu), (p_end, drift, spot_disc) in BASE.items():
    is_market = prov in ("vast", "runpod", "hyperbolic")
    is_hyper = prov in ("aws", "gcp", "azure", "oci")
    noise_sd = 0.06 if is_market else (0.0 if is_hyper else 0.015)
    # hyperscalers move in steps: pick 0-2 step dates
    steps = sorted(random.sample(range(5, WEEKS - 5), random.choice([0, 1, 1, 2]))) if is_hyper else []
    first = WEEKS - START_WEEK.get(gpu, WEEKS)
    level = 1.0
    for w in range(first, WEEKS):
        date = END - dt.timedelta(weeks=WEEKS - 1 - w)
        years_before_end = (WEEKS - 1 - w) / 52.0
        if is_hyper:
            # price at END is p_end; before each step the price was higher by the drift share
            n_steps_after = sum(1 for s in steps if s > w)
            mult = (1 - drift) ** 0 * (1 + (-drift) * 0.5) ** n_steps_after if steps else 1.0
            price = p_end * mult
        else:
            # geometric drift: price(t) = p_end * (1+drift)^(-years_before_end), i.e. higher in the past
            level = (1 + drift) ** (-years_before_end)
            price = p_end * level * (1 + random.gauss(0, noise_sd))
            # marketplace demand spikes (launch weeks, end-of-quarter crunch)
            if is_market and random.random() < 0.06:
                price *= 1 + random.uniform(0.08, 0.25)
        price = round(max(price, 0.05), 2)
        rows.append([date.isoformat(), prov, gpu, "on-demand", price, "demo"])
        if spot_disc:
            spot = round(price * spot_disc * (1 + random.gauss(0, 0.08 if is_market else 0.03)), 2)
            rows.append([date.isoformat(), prov, gpu, "spot", max(spot, 0.03), "demo"])

rows.sort()
OUT.write_text(json.dumps({
    "meta": {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "demo": True,
        "unit": "USD per accelerator-hour",
        "columns": ["date", "provider", "gpu", "type", "usd", "source"],
        "note": "Synthetic illustrative data. Run scripts/collect.py to replace with live quotes.",
    },
    "rows": rows,
}, separators=(",", ":")))
print(f"wrote {len(rows)} rows -> {OUT.relative_to(ROOT)}")
