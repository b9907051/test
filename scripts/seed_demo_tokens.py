#!/usr/bin/env python3
"""Demo history for the token-economics section.

Prices: list prices are step functions. Current levels come from the vendors' public price pages as
collected in Sept 2026 (see data/token_manual.json); the *timing* of earlier steps is illustrative.
Usage: weekly OpenRouter totals and per-model shares are invented to show the shape; the industry
figures come from data/token_manual.json and are NOT synthetic.
meta.demo is true until scripts/collect_tokens.py writes live rows.
"""
import json, random, datetime as dt, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
random.seed(11)
END = dt.date(2026, 9, 15); START = dt.date(2026, 3, 25)

# model -> list of (effective_date, input, output, cached) steps; last one = today's list price
STEPS = {
    "claude-fable-5-1":  [("2026-06-15", 10.0, 50.0, 1.0), ("2026-08-31", 10.0, 50.0, 0.25)],
    "claude-opus-5":     [("2026-03-25", 5.0, 25.0, 0.50)],
    "claude-sonnet-5":   [("2026-03-25", 3.0, 15.0, 0.30), ("2026-05-20", 2.0, 10.0, 0.20)],
    "claude-haiku-4-5":  [("2026-03-25", 1.0, 5.0, 0.10)],
    "gpt-6-astra":       [("2026-09-03", 10.0, 50.0, 1.0)],
    "gpt-5-6-sol":       [("2026-03-25", 5.0, 30.0, 0.50), ("2026-07-10", 4.0, 20.0, 0.40)],
    "gpt-5-6-terra":     [("2026-03-25", 2.5, 15.0, 0.25), ("2026-07-10", 2.0, 12.0, 0.20)],
    "gpt-5-6-luna":      [("2026-03-25", 0.25, 1.50, 0.025), ("2026-07-10", 0.20, 1.20, 0.02)],
    "gemini-3-1-pro":    [("2026-03-25", 2.0, 12.0, None)],
    "gemini-3-8-flash":  [("2026-03-25", 1.5, 9.0, None), ("2026-06-01", 1.5, 7.5, None), ("2026-08-20", 0.75, 3.75, None)],
    "gemini-3-5-flash-lite": [("2026-03-25", 0.30, 2.50, None)],
    "deepseek-v4-pro":   [("2026-03-25", 0.435, 0.87, 0.02), ("2026-08-15", 0.66, 1.98, 0.022)],
    "deepseek-v4-1-flash": [("2026-03-25", 0.14, 0.28, 0.003), ("2026-08-15", 0.15, 0.60, 0.003)],
    "grok-4-6":          [("2026-03-25", 3.0, 15.0, 0.75), ("2026-08-12", 2.0, 6.0, 0.50)],
}
rows = []
for model, steps in STEPS.items():
    for (d, i, o, c) in steps:
        if dt.date.fromisoformat(d) <= END:
            rows.append([d, model, i, o, c, "demo"])
    # weekly confirmation rows so the series reads as "still in force"
    day = START
    while day <= END:
        cur = [s for s in steps if dt.date.fromisoformat(s[0]) <= day]
        if cur:
            _, i, o, c = cur[-1]
            rows.append([day.isoformat(), model, i, o, c, "demo"])
        day += dt.timedelta(days=7)
rows = sorted({tuple(r[:2]): r for r in rows}.values())

# Ornn OTPI realized $/M (volume-weighted, all tokens) — invented daily paths ending at plausible levels
otpi = []
levels = {"anthropic": 6.8, "openai": 4.9, "google": 1.9, "xai": 2.4}
for lab, lvl in levels.items():
    for k in range(31):
        day = END - dt.timedelta(days=30 - k)
        v = lvl * (1 + 0.10 * (30 - k) / 365) * (1 + random.gauss(0, 0.02))
        otpi.append([day.isoformat(), lab, round(v, 3), "demo"])

# OpenRouter weekly usage: totals rising 12T -> 25T; per-model shares
share = {
    "anthropic/claude-sonnet-5": 0.17, "google/gemini-3.8-flash": 0.13, "deepseek/deepseek-v4.1-flash": 0.10,
    "openai/gpt-5.6-terra": 0.09, "anthropic/claude-opus-5": 0.07, "x-ai/grok-4.3": 0.06,
    "qwen/qwen3.8-max": 0.05, "openai/gpt-5.6-luna": 0.05, "google/gemini-3.1-pro": 0.04,
    "moonshotai/kimi-k3": 0.035, "deepseek/deepseek-v4-pro": 0.03, "openai/gpt-6-astra": 0.02,
    "meta-llama/llama-5-70b": 0.02, "anthropic/claude-fable-5.1": 0.015, "mistralai/mistral-large-3": 0.01,
}
usage = []
weeks = 26
for w in range(weeks):
    day = END - dt.timedelta(weeks=weeks - 1 - w)
    total = 12e12 * (25 / 12) ** (w / (weeks - 1)) * (1 + random.gauss(0, 0.04))
    usage.append([day.isoformat(), "openrouter_total", "all", round(total), "demo"])
    for m, s in share.items():
        drift = 1 + (w - weeks / 2) / weeks * (0.6 if "gemini-3.8" in m or "gpt-6" in m else -0.15 if "grok" in m else 0)
        if m == "openai/gpt-6-astra" and day < dt.date(2026, 9, 3): continue
        usage.append([day.isoformat(), "openrouter_model", m, round(total * s * drift * (1 + random.gauss(0, 0.08))), "demo"])

meta = {"generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "demo": True}
(ROOT / "data" / "token_prices.json").write_text(json.dumps({"meta": {**meta, "unit": "USD per 1M tokens",
    "columns": ["date", "model", "input", "output", "cached_input", "source"], "otpi_columns": ["date", "lab", "usd_per_m", "source"]},
    "rows": rows, "otpi": otpi}, separators=(",", ":")))
(ROOT / "data" / "token_usage.json").write_text(json.dumps({"meta": {**meta, "unit": "tokens",
    "columns": ["date", "scope", "key", "tokens", "source"]}, "rows": usage}, separators=(",", ":")))
print(f"prices {len(rows)} rows, otpi {len(otpi)}, usage {len(usage)}")
