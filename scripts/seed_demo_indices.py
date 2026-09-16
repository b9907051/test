#!/usr/bin/env python3
"""Synthetic demo series for the third-party indices so the dashboard section renders before
collect_indices.py has run. Levels end near publicly reported Sept-2026 values (OCPI H100 ≈ $2.53)
but the paths are invented. meta.demo = true until live rows arrive."""
import json, random, datetime as dt, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
random.seed(7)
END = dt.date(2026, 9, 15); DAYS = 120
# (index, gpu): end level, daily noise sd, yearly drift
LEVELS = {
    ("ocpi", "h100-sxm"): (2.53, 0.010, -0.22), ("ocpi", "h200"): (3.20, 0.012, -0.25), ("ocpi", "b200"): (4.60, 0.015, -0.35),
    ("ocpi", "a100-80"): (1.28, 0.010, -0.15), ("ocpi", "rtx5090"): (0.71, 0.015, -0.20),
    ("cgi", "h100-sxm"): (2.95, 0.012, -0.24), ("cgi", "h200"): (3.55, 0.014, -0.26), ("cgi", "b200"): (5.10, 0.018, -0.33), ("cgi", "b300"): (6.40, 0.020, -0.30),
    ("sdh", "h100-sxm"): (2.61, 0.008, -0.23), ("sdh", "a100-80"): (1.35, 0.008, -0.14), ("sdh", "b200"): (4.85, 0.012, -0.34),
    ("gci", "h100-sxm"): (2.72, 0.009, -0.22), ("gci", "h200"): (3.35, 0.010, -0.24), ("gci", "b200"): (4.75, 0.014, -0.33),
}
rows = []
for (idx, gpu), (lvl, sd, drift) in LEVELS.items():
    for i in range(DAYS):
        day = END - dt.timedelta(days=DAYS - 1 - i)
        if idx == "gci" and day.weekday() >= 5:  # fixes only on US trading days
            continue
        years_back = (DAYS - 1 - i) / 365
        v = lvl * (1 + drift) ** (-years_back) * (1 + random.gauss(0, sd))
        rows.append([day.isoformat(), idx, gpu, round(v, 3), "demo"])
rows.sort()
out = ROOT / "data" / "indices.json"
out.write_text(json.dumps({"meta": {"generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "demo": True,
                                     "unit": "USD per GPU-hour", "columns": ["date", "index", "gpu", "value", "source"],
                                     "note": "Synthetic. Run scripts/collect_indices.py to replace."}, "rows": rows}, separators=(",", ":")))
print(f"wrote {len(rows)} rows -> {out.relative_to(ROOT)}")
