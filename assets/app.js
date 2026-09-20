/* AI 算力租賃價格追蹤 — dashboard logic (no dependencies) */
(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const DAY = 86400000;
  const SLOT_VAR = (slot) => `var(--s${slot})`;
  const SEQ_STEPS = [100, 150, 200, 250, 300, 350, 400, 450, 500, 550, 600, 650, 700];
  const CARRY_DAYS = 14; // a quote stays "current" for this many days if a provider skipped a snapshot

  const state = {
    type: "on-demand",
    rangeDays: 180,
    gpus: new Set(["h100-sxm", "h200", "b200", "a100-80", "mi300x"]),
    hidden: new Set(),
    currency: "USD",
    twdRate: 32,
    providerGpu: "h100-sxm",
    valueMetric: "pflop",
    sort: { key: "usd", dir: 1 },
    tokenModels: new Set(["claude-sonnet-5", "gpt-5-6-terra", "gemini-3-8-flash", "deepseek-v4-pro", "claude-opus-5", "grok-4-6"]),
    tokenMetric: "blend",
  };
  try {
    const saved = JSON.parse(localStorage.getItem("aipt-state") || "{}");
    if (saved.type) state.type = saved.type;
    if (saved.rangeDays !== undefined) state.rangeDays = saved.rangeDays;
    if (saved.gpus) state.gpus = new Set(saved.gpus);
    if (saved.currency) state.currency = saved.currency;
    if (saved.twdRate) state.twdRate = saved.twdRate;
    if (saved.providerGpu) state.providerGpu = saved.providerGpu;
    if (saved.indexGpu) state.indexGpu = saved.indexGpu;
    if (saved.tokenModels) state.tokenModels = new Set(saved.tokenModels);
    if (saved.tokenMetric) state.tokenMetric = saved.tokenMetric;
  } catch (_) { /* storage unavailable: defaults are fine */ }
  const persist = () => {
    try {
      localStorage.setItem("aipt-state", JSON.stringify({
        type: state.type, rangeDays: state.rangeDays, gpus: [...state.gpus],
        currency: state.currency, twdRate: state.twdRate, providerGpu: state.providerGpu, indexGpu: state.indexGpu,
        tokenModels: [...state.tokenModels], tokenMetric: state.tokenMetric,
      }));
    } catch (_) { /* ignore */ }
  };

  let CAT, GPU, PROV, ROWS, DATES, LATEST;
  let IXSRC = {}, IXROWS = [], IXMETA = {};            // third-party indices
  const IXIDX = new Map();                             // `${index}|${gpu}` -> [{t,d,v,src}] sorted
  let TK = null, TKPRICE = new Map(), TKOTPI = new Map(), TKUSE = [], TKMETA = {};   // token economics
  // index: `${gpu}|${type}` -> Map(provider -> [{t, d, usd, src}] sorted by t)
  const IDX = new Map();

  // ------------------------------------------------------------ formatting
  const fmtMoney = (usd, digits) => {
    if (usd == null || isNaN(usd)) return "–";
    const v = state.currency === "TWD" ? usd * state.twdRate : usd;
    const d = digits ?? (v >= 100 ? 0 : v >= 10 ? 1 : 2);
    return (state.currency === "TWD" ? "NT$" : "$") + v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  };
  const fmtPct = (p) => (p == null || !isFinite(p)) ? "–" : (p > 0 ? "+" : "") + (p * 100).toFixed(1) + "%";
  const fmtDate = (d) => d; // ISO already
  const fmtShortDate = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
  const toT = (iso) => Date.parse(iso + "T00:00:00Z");
  const median = (arr) => { const a = arr.filter((x) => x != null).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  const geomean = (arr) => arr.length ? Math.exp(arr.reduce((s, x) => s + Math.log(x), 0) / arr.length) : null;

  // ------------------------------------------------------------ data access
  function seriesFor(gpu, type) { return IDX.get(`${gpu}|${type}`) || new Map(); }
  /** price of one provider at time t (carry-forward up to CARRY_DAYS) */
  function priceAt(list, t) {
    let lo = 0, hi = list.length - 1, best = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (list[m].t <= t) { best = m; lo = m + 1; } else hi = m - 1; }
    if (best < 0) return null;
    const p = list[best];
    return t - p.t <= CARRY_DAYS * DAY ? p : null;
  }
  /** median across providers for a gpu/type at time t */
  function medianAt(gpu, type, t) {
    const vals = [];
    for (const list of seriesFor(gpu, type).values()) { const p = priceAt(list, t); if (p) vals.push(p.usd); }
    return median(vals);
  }
  function minAt(gpu, type, t) {
    let best = null;
    for (const [prov, list] of seriesFor(gpu, type)) { const p = priceAt(list, t); if (p && (!best || p.usd < best.usd)) best = { prov, ...p }; }
    return best;
  }
  function providerCount(gpu, type, t) {
    let n = 0; for (const list of seriesFor(gpu, type).values()) if (priceAt(list, t)) n++; return n;
  }
  const latestT = () => toT(LATEST);
  const changeOver = (fn, days) => { const now = fn(latestT()), then = fn(latestT() - days * DAY); return now != null && then ? now / then - 1 : null; };

  function datesInRange() {
    if (!state.rangeDays) return DATES;
    const from = latestT() - state.rangeDays * DAY;
    return DATES.filter((d) => toT(d) >= from);
  }

  // ------------------------------------------------------------ SVG helpers
  const svgEl = (tag, attrs = {}, parent) => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
    if (parent) parent.appendChild(el);
    return el;
  };
  function niceTicks(max, n = 5) {
    if (!(max > 0)) return [0, 1];
    const raw = max / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
    const ticks = []; for (let v = 0; v <= max + 1e-9; v += step) ticks.push(+v.toFixed(6));
    if (ticks[ticks.length - 1] < max) ticks.push(+(ticks[ticks.length - 1] + step).toFixed(6));
    return ticks;
  }
  function tooltipEl(container) {
    let tip = $(".tooltip", container);
    if (!tip) { tip = document.createElement("div"); tip.className = "tooltip"; container.appendChild(tip); }
    return tip;
  }
  function placeTip(tip, container, x, y) {
    const cw = container.clientWidth, tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = x + 14; if (left + tw > cw) left = x - tw - 14; if (left < 0) left = 4;
    let top = y - th / 2; if (top < 0) top = 0; if (top + th > container.clientHeight) top = container.clientHeight - th;
    tip.style.left = left + "px"; tip.style.top = top + "px";
  }

  // ------------------------------------------------------------ line chart
  /** series: [{id, name, color(css), dashed, values:[number|null] aligned to dates}] */
  function lineChart(container, dates, series, opts = {}) {
    container.innerHTML = "";
    const W = Math.max(320, container.clientWidth), H = opts.height || 320;
    const narrow = W < 560;
    const m = { top: 14, right: narrow ? 16 : (opts.rightPad ?? 96), bottom: 28, left: 52 };
    const pw = W - m.left - m.right, ph = H - m.top - m.bottom;
    const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": opts.aria || "" }, container);
    const visible = series.filter((s) => !s.hidden);
    if (!dates.length || !visible.some((s) => s.values.some((v) => v != null))) {
      svgEl("text", { x: W / 2, y: H / 2, "text-anchor": "middle", class: "empty" }, svg).textContent = "此區間沒有資料";
      return;
    }
    const t0 = toT(dates[0]), t1 = toT(dates[dates.length - 1]) || t0 + 1;
    const x = (t) => m.left + (t1 === t0 ? pw / 2 : ((t - t0) / (t1 - t0)) * pw);
    const maxV = Math.max(...visible.flatMap((s) => s.values.filter((v) => v != null))) * (opts.headroom ?? 1.08);
    const ticks = niceTicks(maxV, 5), yMax = ticks[ticks.length - 1];
    const y = (v) => m.top + ph - (v / yMax) * ph;

    const grid = svgEl("g", { class: "grid" }, svg), tk = svgEl("g", { class: "ticks" }, svg);
    for (const v of ticks) {
      svgEl("line", { x1: m.left, x2: W - m.right, y1: y(v), y2: y(v) }, grid);
      svgEl("text", { x: m.left - 8, y: y(v) + 4, "text-anchor": "end" }, tk).textContent = opts.fmtY ? opts.fmtY(v) : v;
    }
    svgEl("line", { x1: m.left, x2: W - m.right, y1: y(0), y2: y(0), class: "axis" }, svgEl("g", { class: "axis" }, svg));
    // x ticks: month starts, thinned to fit
    const months = []; let lastKey = "";
    for (const d of dates) { const k = d.slice(0, 7); if (k !== lastKey) { months.push(d); lastKey = k; } }
    const every = Math.max(1, Math.ceil(months.length / Math.max(2, Math.floor(pw / 70))));
    let lastTickX = -Infinity;
    months.forEach((d, i) => { const px = x(toT(d)); if (i % every === 0 && px - lastTickX >= 60) { svgEl("text", { x: px, y: H - 8, "text-anchor": "middle" }, tk).textContent = fmtShortDate(toT(d)); lastTickX = px; } });

    const gs = svgEl("g", { class: "series" }, svg);
    const labels = [];
    for (const s of visible) {
      let d = "", pen = false, lastPt = null;
      s.values.forEach((v, i) => {
        if (v == null) { pen = false; return; }
        const px = x(toT(dates[i])), py = y(v);
        if (pen && opts.step && lastPt) d += "H" + px.toFixed(1) + "V" + py.toFixed(1);
        else d += (pen ? "L" : "M") + px.toFixed(1) + " " + py.toFixed(1);
        pen = true; lastPt = { px, py, v };
      });
      const p = svgEl("path", { d, style: `stroke:${s.color}` }, gs);
      if (s.dashed) p.setAttribute("stroke-dasharray", "6 4");
      const nPts = s.values.filter((v) => v != null).length;
      if (nPts === 1 && lastPt) svgEl("circle", { cx: lastPt.px, cy: lastPt.py, r: 4, style: `fill:${s.color}` }, gs);
      if (lastPt) labels.push({ s, ...lastPt });
    }
    // end labels with simple collision avoidance
    if (opts.endLabels !== false && !narrow) {
      labels.sort((a, b) => a.py - b.py);
      for (let i = 1; i < labels.length; i++) if (labels[i].py - labels[i - 1].py < 13) labels[i].py = labels[i - 1].py + 13;
      const lg = svgEl("g", {}, svg);
      for (const l of labels) svgEl("text", { x: W - m.right + 8, y: l.py + 4, class: "endlabel" }, lg).textContent = `${l.s.name} ${opts.fmtY ? opts.fmtY(l.v, true) : l.v}`;
    }

    // hover layer
    const ch = svgEl("g", { class: "crosshair", style: "display:none" }, svg);
    const vline = svgEl("line", { y1: m.top, y2: m.top + ph }, ch);
    const dots = visible.map((s) => svgEl("circle", { r: 4, style: `fill:${s.color}` }, ch));
    const hit = svgEl("rect", { x: m.left, y: m.top, width: pw, height: ph, class: "hit" }, svg);
    const tip = tooltipEl(container);
    const ts = dates.map(toT);
    const onMove = (ev) => {
      const r = svg.getBoundingClientRect();
      const mx = ev.clientX - r.left;
      const t = t0 + ((mx - m.left) / pw) * (t1 - t0);
      let i = 0, best = Infinity;
      ts.forEach((tt, k) => { const dd = Math.abs(tt - t); if (dd < best) { best = dd; i = k; } });
      const px = x(ts[i]);
      ch.style.display = ""; vline.setAttribute("x1", px); vline.setAttribute("x2", px);
      let html = `<div class="t">${dates[i]}</div>`;
      visible.forEach((s, k) => {
        const v = s.values[i];
        if (v == null) { dots[k].style.display = "none"; return; }
        dots[k].style.display = ""; dots[k].setAttribute("cx", px); dots[k].setAttribute("cy", y(v));
        html += `<div class="row${s.dashed ? " dashed" : ""}"><span class="sw" style="background:${s.color}"></span>${s.name}<span class="v">${opts.fmtY ? opts.fmtY(v, true) : v}</span></div>`;
      });
      tip.innerHTML = html; tip.style.display = "block";
      placeTip(tip, container, px, ev.clientY - r.top);
    };
    hit.addEventListener("mousemove", onMove);
    hit.addEventListener("touchmove", (e) => { onMove(e.touches[0]); e.preventDefault(); }, { passive: false });
    hit.addEventListener("mouseleave", () => { ch.style.display = "none"; tip.style.display = "none"; });
  }

  // ------------------------------------------------------------ horizontal bars
  /** items: [{label, value, emphasis, sub, tip(html)}] */
  function hbarChart(container, items, opts = {}) {
    container.innerHTML = "";
    const W = Math.max(320, container.clientWidth), rowH = 28, labelW = opts.labelW ?? 118;
    const m = { top: 6, right: 70, bottom: 4, left: labelW };
    const H = m.top + m.bottom + rowH * items.length;
    const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img" }, container);
    if (!items.length) { svgEl("text", { x: W / 2, y: 30, "text-anchor": "middle", class: "empty" }, svg).textContent = "沒有資料"; svg.setAttribute("height", 60); return; }
    const pw = W - m.left - m.right, max = Math.max(...items.map((i) => i.value));
    const x = (v) => (v / max) * pw;
    const tip = tooltipEl(container);
    items.forEach((it, i) => {
      const y = m.top + i * rowH, h = rowH - 8, w = Math.max(2, x(it.value));
      const g = svgEl("g", {}, svg);
      svgEl("text", { x: m.left - 10, y: y + h / 2 + 4, "text-anchor": "end", class: "catlabel" + (it.emphasis ? " strong" : "") }, g).textContent = it.label;
      // bar: flat at the baseline, 4px radius on the data end (clip trick)
      const path = `M${m.left} ${y}h${Math.max(0, w - 4)}a4 4 0 0 1 4 4v${h - 8}a4 4 0 0 1 -4 4h-${Math.max(0, w - 4)}z`;
      svgEl("path", { d: path, class: "bar", style: `fill:${it.emphasis ? "var(--accent)" : (it.color || "var(--de-emph)")}` }, g);
      svgEl("text", { x: m.left + w + 8, y: y + h / 2 + 4, class: "barlabel" }, g).textContent = it.valueLabel ?? it.value;
      if (it.tip) {
        g.addEventListener("mousemove", (ev) => { const r = svg.getBoundingClientRect(); tip.innerHTML = it.tip; tip.style.display = "block"; placeTip(tip, container, ev.clientX - r.left, ev.clientY - r.top); });
        g.addEventListener("mouseleave", () => { tip.style.display = "none"; });
      }
    });
    svgEl("line", { x1: m.left, x2: m.left, y1: m.top, y2: H - m.bottom, class: "axis", style: "stroke:var(--axis)" }, svg);
  }

  function sparkline(el, values, color = "var(--s1)") {
    el.innerHTML = "";
    const vals = values.filter((v) => v != null);
    if (vals.length < 2) return;
    const W = 200, H = 34, min = Math.min(...vals), max = Math.max(...vals);
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none" }, el);
    const pts = values.map((v, i) => v == null ? null : [(i / (values.length - 1)) * W, H - 3 - ((v - min) / ((max - min) || 1)) * (H - 6)]);
    let d = "", pen = false;
    for (const p of pts) { if (!p) { pen = false; continue; } d += (pen ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1); pen = true; }
    svgEl("path", { d, style: `fill:none;stroke:${color};stroke-width:2;vector-effect:non-scaling-stroke`, "stroke-linejoin": "round" }, svg);
    const last = [...pts].reverse().find(Boolean);
    if (last) svgEl("circle", { cx: last[0], cy: last[1], r: 3, style: `fill:${color}` }, svg);
  }

  // ------------------------------------------------------------ renderers
  const gpuColor = (id) => SLOT_VAR(GPU[id].slot);
  /** GPUs that share a palette slot with an earlier selected GPU are drawn dashed */
  function selectedSeriesStyle() {
    const used = new Map(), out = new Map();
    for (const g of CAT.gpus) {
      if (!state.gpus.has(g.id)) continue;
      const dashed = used.has(g.slot); used.set(g.slot, true);
      out.set(g.id, { color: gpuColor(g.id), dashed });
    }
    return out;
  }

  function renderHeader() {
    $("#last-updated").textContent = `資料截至 ${LATEST} · ${ROWS.length.toLocaleString()} 筆報價 · ${DATES.length} 個快照`;
    $("#demo-banner").classList.toggle("show", !!ROWS.meta.demo);
  }

  function renderControls() {
    $$("#type-seg button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.v === state.type));
    $$("#range-seg button").forEach((b) => b.setAttribute("aria-pressed", +b.dataset.v === state.rangeDays));
    $$("#cur-seg button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.v === state.currency));
    $("#twd-rate").value = state.twdRate; $("#twd-rate").style.display = state.currency === "TWD" ? "" : "none";
    const chips = $("#gpu-chips"); chips.innerHTML = "";
    for (const g of CAT.gpus) {
      const n = providerCount(g.id, state.type, latestT());
      const b = document.createElement("button");
      b.className = "chip"; b.type = "button"; b.style.setProperty("--c", gpuColor(g.id));
      b.setAttribute("aria-pressed", state.gpus.has(g.id));
      b.title = `${g.name} · ${g.memory_gb} GB · ${n} 家供應商`;
      b.innerHTML = `<span class="sw"></span>${g.short}<span class="kind">${g.kind === "XPU" ? "XPU" : g.vendor}</span>`;
      b.addEventListener("click", () => {
        if (state.gpus.has(g.id)) state.gpus.delete(g.id);
        else if (state.gpus.size >= 6) { flash("最多同時比較 6 款加速器"); return; }
        else state.gpus.add(g.id);
        persist(); renderAll();
      });
      chips.appendChild(b);
    }
    const sel = $("#provider-gpu"); sel.innerHTML = "";
    for (const g of CAT.gpus) { const o = document.createElement("option"); o.value = g.id; o.textContent = g.name; sel.appendChild(o); }
    sel.value = state.providerGpu;
    $$("#value-seg button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.v === state.valueMetric));
  }
  let flashTimer;
  function flash(msg) { const el = $("#flash"); el.textContent = msg; el.style.opacity = 1; clearTimeout(flashTimer); flashTimer = setTimeout(() => (el.style.opacity = 0), 1800); }

  // price index: geometric mean of each basket GPU's median price relative to the first snapshot
  function indexSeries(dates) {
    const basket = CAT.gpus.filter((g) => medianAt(g.id, "on-demand", toT(DATES[0])) != null).map((g) => g.id);
    const base = Object.fromEntries(basket.map((id) => [id, medianAt(id, "on-demand", toT(DATES[0]))]));
    return { basket, values: dates.map((d) => { const t = toT(d); const r = basket.map((id) => medianAt(id, "on-demand", t)).map((v, i) => v == null ? null : v / base[basket[i]]).filter((v) => v != null); return r.length ? geomean(r) * 100 : null; }) };
  }

  function renderKpis() {
    const dates = datesInRange(), t = latestT();
    // 1) index
    const ix = indexSeries(dates);
    const ixAll = indexSeries(DATES).values;
    const thenIdx = Math.max(0, DATES.findIndex((d) => toT(d) >= t - 30 * DAY));
    const ixNow = ixAll[ixAll.length - 1], ixThen = ixAll[thenIdx];
    const spanDays = Math.round((t - toT(DATES[thenIdx])) / DAY);
    $("#kpi-index .value").innerHTML = ixNow != null ? ixNow.toFixed(1) : "–";
    setDelta($("#kpi-index .delta"), ixNow && ixThen && spanDays > 0 ? ixNow / ixThen - 1 : null, spanDays >= 25 ? "30日" : `${spanDays} 日`);
    sparkline($("#kpi-index .spark"), ix.values);
    $("#kpi-index .foot").textContent = `基準 ${DATES[0]} = 100 · 籃子：${ix.basket.map((id) => GPU[id].short).join("、")}（隨需價中位數）`;
    // 2) H100 median
    const h = "h100-sxm", hm = medianAt(h, state.type, t);
    $("#kpi-h100 .value").innerHTML = fmtMoney(hm) + `<span class="unit">/hr</span>`;
    setDelta($("#kpi-h100 .delta"), changeOver((tt) => medianAt(h, state.type, tt), 30), "30日");
    sparkline($("#kpi-h100 .spark"), dates.map((d) => medianAt(h, state.type, toT(d))), gpuColor(h));
    $("#kpi-h100 .foot").textContent = `${providerCount(h, state.type, t)} 家供應商中位數 · ${typeName()}`;
    // 3) cheapest H100
    const mn = minAt(h, state.type, t);
    $("#kpi-h100-min .value").innerHTML = mn ? fmtMoney(mn.usd) + `<span class="unit">/hr</span>` : "–";
    $("#kpi-h100-min .delta").textContent = mn ? PROV[mn.prov].name : "";
    $("#kpi-h100-min .delta").className = "delta";
    sparkline($("#kpi-h100-min .spark"), dates.map((d) => { const m = minAt(h, state.type, toT(d)); return m ? m.usd : null; }), gpuColor(h));
    $("#kpi-h100-min .foot").textContent = mn ? `來源：${mn.src} · 快照 ${mn.d}` : "此類型沒有 H100 報價";
    // 4) biggest 30-day mover among GPUs with >=2 providers
    let mover = null;
    for (const g of CAT.gpus) {
      if (providerCount(g.id, state.type, t) < 2) continue;
      const c = changeOver((tt) => medianAt(g.id, state.type, tt), 30);
      if (c != null && (!mover || Math.abs(c) > Math.abs(mover.c))) mover = { g, c };
    }
    $("#kpi-mover .value").innerHTML = mover ? mover.g.short : "–";
    setDelta($("#kpi-mover .delta"), mover ? mover.c : null, "30日");
    sparkline($("#kpi-mover .spark"), mover ? dates.map((d) => medianAt(mover.g.id, state.type, toT(d))) : [], mover ? gpuColor(mover.g.id) : undefined);
    $("#kpi-mover .foot").textContent = mover ? `中位數 ${fmtMoney(medianAt(mover.g.id, state.type, t))}/hr · ${typeName()}` : "";
  }
  function setDelta(el, pct, label) {
    el.textContent = pct == null ? "–" : `${pct <= 0 ? "▼" : "▲"} ${(Math.abs(pct) * 100).toFixed(1)}% ${label}`;
    el.className = "delta " + (pct == null ? "" : pct < -0.001 ? "good" : pct > 0.001 ? "bad" : "");
  }
  const typeName = () => CAT.price_types.find((p) => p.id === state.type)?.name || state.type;

  function renderTrend() {
    const dates = datesInRange(), styles = selectedSeriesStyle();
    const series = CAT.gpus.filter((g) => state.gpus.has(g.id)).map((g) => ({
      id: g.id, name: g.short, ...styles.get(g.id), hidden: state.hidden.has(g.id),
      values: dates.map((d) => medianAt(g.id, state.type, toT(d))),
    }));
    lineChart($("#trend-chart"), dates, series, { fmtY: (v, exact) => fmtMoney(v, exact ? undefined : v >= 10 ? 0 : 1), aria: "各加速器每小時租賃價中位數走勢" });
    const lg = $("#trend-legend"); lg.innerHTML = "";
    for (const s of series) {
      const li = document.createElement("li"); li.style.setProperty("--c", s.color);
      li.className = (s.dashed ? "dashed " : "") + (s.hidden ? "off" : "");
      li.innerHTML = `<span class="sw"></span>${GPU[s.id].name}`;
      li.title = "點擊顯示／隱藏";
      li.addEventListener("click", () => { state.hidden.has(s.id) ? state.hidden.delete(s.id) : state.hidden.add(s.id); renderTrend(); });
      lg.appendChild(li);
    }
    $("#trend-hint").textContent = `每點為當日所有供應商的${typeName()}中位數；${series.length > 1 ? "虛線 = 與另一系列共用色相。" : ""}`;
  }

  function renderProviders() {
    const t = latestT(), gpu = state.providerGpu;
    const items = [];
    for (const [prov, list] of seriesFor(gpu, state.type)) {
      const p = priceAt(list, t); if (!p) continue;
      const then = priceAt(list, t - 30 * DAY);
      const d30 = then ? p.usd / then.usd - 1 : null;
      items.push({ label: PROV[prov].name, value: p.usd, valueLabel: fmtMoney(p.usd), prov,
        tip: `<div class="t">${PROV[prov].name} · ${GPU[gpu].short}</div><div class="row">價格<span class="v">${fmtMoney(p.usd)}/hr</span></div><div class="row">30 日變動<span class="v">${fmtPct(d30)}</span></div><div class="row">層級<span class="v">${tierName(PROV[prov].tier)}</span></div><div class="row">來源 / 快照<span class="v">${p.src} · ${p.d}</span></div>` });
    }
    items.sort((a, b) => a.value - b.value);
    items.forEach((it, i) => (it.emphasis = i === 0));
    hbarChart($("#provider-chart"), items);
    const med = medianAt(gpu, state.type, t);
    $("#provider-hint").textContent = items.length ? `${items.length} 家 · 中位數 ${fmtMoney(med)}/hr · 最便宜與最貴相差 ${(items[items.length - 1].value / items[0].value).toFixed(1)}×` : "此類型沒有報價";
  }
  const tierName = (t) => ({ hyperscaler: "公有雲巨頭", neocloud: "AI 專用雲", marketplace: "GPU 市集" })[t] || t;

  function renderHeatmap() {
    const t = latestT(), wrap = $("#heatmap");
    const dark = getComputedStyle(document.documentElement).colorScheme.includes("dark");
    const provs = CAT.providers.filter((p) => CAT.gpus.some((g) => { const l = seriesFor(g.id, state.type).get(p.id); return l && priceAt(l, t); }));
    const gpus = CAT.gpus.filter((g) => providerCount(g.id, state.type, t) > 0);
    let html = `<table><thead><tr><th>加速器</th>${provs.map((p) => `<th class="tier-${p.tier[0]}">${p.name}</th>`).join("")}</tr></thead><tbody>`;
    for (const g of gpus) {
      const cells = provs.map((p) => { const l = seriesFor(g.id, state.type).get(p.id); const q = l && priceAt(l, t); return q ? { p, q, then: priceAt(l, t - 30 * DAY) } : null; });
      const vals = cells.filter(Boolean).map((c) => c.q.usd), lo = Math.min(...vals), hi = Math.max(...vals);
      html += `<tr><th>${g.name}<br><span style="font-weight:400;color:var(--muted)">${g.memory_gb} GB</span></th>`;
      for (const c of cells) {
        if (!c) { html += `<td class="na"></td>`; continue; }
        const tnorm = hi > lo ? (c.q.usd - lo) / (hi - lo) : 0;
        // light mode: pricier = darker. dark mode: cheaper recedes toward the dark surface, pricier is lighter.
        const step = SEQ_STEPS[Math.round((dark ? 1 - tnorm : tnorm) * (SEQ_STEPS.length - 1))];
        const d30 = c.then ? c.q.usd / c.then.usd - 1 : null;
        html += `<td class="cell${step >= 400 ? " dark" : ""}${c.q.usd === lo ? " best" : ""}" style="background:var(--seq-${step})" title="${g.name} @ ${c.p.name}\n${fmtMoney(c.q.usd)}/hr（${c.q.src}，${c.q.d}）\n30 日變動 ${fmtPct(d30)}">${fmtMoney(c.q.usd)}<span class="d">${d30 == null ? "" : fmtPct(d30)}</span></td>`;
      }
      html += "</tr>";
    }
    html += `</tbody></table><div class="tiers"><span class="h">公有雲巨頭</span><span class="n">AI 專用雲</span><span class="m">GPU 市集</span><span>每列顏色深淺 = 該款加速器內的相對價格；粗框 = 最低價；小字 = 30 日變動</span></div>`;
    wrap.innerHTML = html;
  }

  function renderValue() {
    const t = latestT();
    const items = [];
    for (const g of CAT.gpus) {
      const med = medianAt(g.id, state.type, t); if (med == null) continue;
      const v = state.valueMetric === "pflop" ? med / (g.fp16_tflops / 1000) : med / g.memory_gb;
      items.push({ label: g.short, value: v, valueLabel: fmtMoney(v, 2), color: "var(--accent)", g, med,
        tip: `<div class="t">${g.name}</div><div class="row">中位數<span class="v">${fmtMoney(med)}/hr</span></div><div class="row">FP16 密集算力<span class="v">${g.fp16_tflops} TFLOPS</span></div><div class="row">記憶體<span class="v">${g.memory_gb} GB</span></div>` });
    }
    items.sort((a, b) => a.value - b.value);
    hbarChart($("#value-chart"), items.map((it) => ({ ...it, emphasis: false, color: "var(--accent)" })), { labelW: 90 });
    $("#value-hint").textContent = state.valueMetric === "pflop"
      ? "每 PFLOP·小時成本（以廠商標稱 FP16/BF16 密集算力換算，未含稀疏加速）— 越低越划算"
      : "每 GB 記憶體·小時成本 — 適合以記憶體為瓶頸的推論工作負載";
  }

  function latestRows() {
    const t = latestT(), out = [];
    for (const g of CAT.gpus) for (const [prov, list] of seriesFor(g.id, state.type)) {
      const p = priceAt(list, t); if (!p) continue;
      const d7 = priceAt(list, t - 7 * DAY), d30 = priceAt(list, t - 30 * DAY);
      out.push({ gpu: g.name, gpuId: g.id, provider: PROV[prov].name, tier: tierName(PROV[prov].tier), usd: p.usd, d7: d7 ? p.usd / d7.usd - 1 : null, d30: d30 ? p.usd / d30.usd - 1 : null, src: p.src, date: p.d });
    }
    return out;
  }
  function renderTable() {
    const rows = latestRows();
    const { key, dir } = state.sort;
    rows.sort((a, b) => { const x = a[key], y = b[key]; if (x == null) return 1; if (y == null) return -1; return (typeof x === "number" ? x - y : String(x).localeCompare(String(y))) * dir; });
    const cols = [["gpu", "加速器"], ["provider", "供應商"], ["tier", "層級"], ["usd", "價格/hr", "num"], ["d7", "7 日", "num"], ["d30", "30 日", "num"], ["src", "來源"], ["date", "快照日"]];
    let html = `<table class="data"><thead><tr>${cols.map(([k, n, c]) => `<th class="${c || ""} ${key === k ? "sorted" : ""}" data-k="${k}">${n}${key === k ? (dir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead><tbody>`;
    for (const r of rows) html += `<tr><td>${r.gpu}</td><td>${r.provider}</td><td>${r.tier}</td><td class="num">${fmtMoney(r.usd)}</td><td class="num ${cls(r.d7)}">${fmtPct(r.d7)}</td><td class="num ${cls(r.d30)}">${fmtPct(r.d30)}</td><td class="src">${r.src}</td><td class="src">${r.date}</td></tr>`;
    html += "</tbody></table>";
    $("#table").innerHTML = html;
    $$("#table th").forEach((th) => th.addEventListener("click", () => { const k = th.dataset.k; state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : 1 }; renderTable(); }));
    $("#table-count").textContent = `${rows.length} 筆最新報價 · ${typeName()}`;
  }
  const cls = (p) => p == null ? "" : p < -0.001 ? "good" : p > 0.001 ? "bad" : "";

  function exportCsv(all) {
    let csv;
    if (all) csv = "date,provider,gpu,type,usd,source\n" + ROWS.map((r) => [r.d, r.provider, r.gpu, r.type, r.usd, r.src].join(",")).join("\n");
    else csv = "gpu,provider,tier,usd_per_hour,change_7d,change_30d,source,snapshot\n" + latestRows().map((r) => [r.gpu, r.provider, r.tier, r.usd, r.d7 ?? "", r.d30 ?? "", r.src, r.date].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = all ? `gpu-rental-prices-history.csv` : `gpu-rental-prices-${LATEST}-${state.type}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
  }

  // ------------------------------------------------------------ market indices
  const ixSeries = (ix, gpu) => IXIDX.get(`${ix}|${gpu}`) || [];
  function ixAt(list, t, carry = 7) { const p = priceAt(list, t); return p && t - p.t <= carry * DAY ? p : null; }
  const accessName = (a) => ({ free: "免費開放", "free-tier": "免費層", paid: "付費訂閱", manual: "人工登錄" })[a] || a;
  function renderIndices() {
    const sel = $("#index-gpu");
    if (!sel.options.length) {
      const covered = CAT.gpus.filter((g) => Object.values(IXSRC).some((s) => s.gpus[g.id]));
      for (const g of covered) { const o = document.createElement("option"); o.value = g.id; o.textContent = g.name; sel.appendChild(o); }
      sel.value = state.indexGpu && covered.some((g) => g.id === state.indexGpu) ? state.indexGpu : (covered[0]?.id || "");
      state.indexGpu = sel.value;
    }
    const gpu = state.indexGpu, dates = datesInRange(), t = latestT();
    // daily axis for indices (they settle daily; our snapshots may be sparser)
    const ixDates = [...new Set(IXROWS.filter((r) => r.gpu === gpu).map((r) => r.d))].sort();
    const from = state.rangeDays ? t - state.rangeDays * DAY : -Infinity;
    const axis = [...new Set([...ixDates, ...dates])].filter((d) => toT(d) >= from).sort();
    const series = [{ id: "tracker", name: "本站中位數", color: "var(--s1)", values: axis.map((d) => medianAt(gpu, "on-demand", toT(d))), hidden: state.hidden.has("ix:tracker") }];
    for (const src of Object.values(IXSRC)) {
      const list = ixSeries(src.id, gpu); if (!list.length) continue;
      series.push({ id: src.id, name: src.short, color: SLOT_VAR(src.slot), hidden: state.hidden.has("ix:" + src.id), values: axis.map((d) => { const p = ixAt(list, toT(d)); return p ? p.v : null; }) });
    }
    lineChart($("#index-chart"), axis, series, { fmtY: (v, exact) => fmtMoney(v, exact ? undefined : v >= 10 ? 0 : 1), aria: "第三方指數與本站中位數比較", height: 300, rightPad: 150 });
    const lg = $("#index-legend"); lg.innerHTML = "";
    for (const sr of series) {
      const li = document.createElement("li"); li.style.setProperty("--c", sr.color); li.className = sr.hidden ? "off" : "";
      li.innerHTML = `<span class="sw"></span>${sr.id === "tracker" ? "本站隨需中位數" : IXSRC[sr.id].name}`;
      li.addEventListener("click", () => { const k = "ix:" + sr.id; state.hidden.has(k) ? state.hidden.delete(k) : state.hidden.add(k); renderIndices(); });
      lg.appendChild(li);
    }
    // comparison table
    const ours = medianAt(gpu, "on-demand", t);
    let html = `<table class="data"><thead><tr><th>指數</th><th class="num">最新值</th><th>日期</th><th class="num">7 日</th><th class="num">30 日</th><th class="num">本站 vs 指數</th><th>取得方式</th></tr></thead><tbody>`;
    html += `<tr><td><b>本站隨需中位數</b></td><td class="num">${fmtMoney(ours)}</td><td class="src">${LATEST}</td><td class="num ${cls(changeOver((tt) => medianAt(gpu, "on-demand", tt), 7))}">${fmtPct(changeOver((tt) => medianAt(gpu, "on-demand", tt), 7))}</td><td class="num ${cls(changeOver((tt) => medianAt(gpu, "on-demand", tt), 30))}">${fmtPct(changeOver((tt) => medianAt(gpu, "on-demand", tt), 30))}</td><td class="num">–</td><td class="src">${providerCount(gpu, "on-demand", t)} 家供應商牌價</td></tr>`;
    let n = 0;
    for (const src of Object.values(IXSRC)) {
      const list = ixSeries(src.id, gpu);
      const last = list.length ? list[list.length - 1] : null;
      if (!last) {
        if (src.gpus[gpu]) html += `<tr><td>${src.name}</td><td class="num">–</td><td class="src">尚無資料</td><td class="num">–</td><td class="num">–</td><td class="num">–</td><td class="src">${accessName(src.access)}</td></tr>`;
        continue;
      }
      n++;
      const at = (days) => { const p = priceAt(list, last.t - days * DAY); return p ? last.v / p.v - 1 : null; };
      const prem = ours != null ? ours / last.v - 1 : null;
      html += `<tr><td>${src.name}</td><td class="num"><b>${fmtMoney(last.v)}</b></td><td class="src">${last.d}${last.src === "demo" ? " (示範)" : ""}</td><td class="num ${cls(at(7))}">${fmtPct(at(7))}</td><td class="num ${cls(at(30))}">${fmtPct(at(30))}</td><td class="num">${prem == null ? "–" : (prem > 0 ? "+" : "") + (prem * 100).toFixed(1) + "%"}</td><td class="src">${accessName(src.access)}</td></tr>`;
    }
    html += "</tbody></table>";
    $("#index-table").innerHTML = html;
    $("#index-hint").textContent = n ? `${n} 個指數 · 「本站 vs 指數」= 本站牌價中位數相對指數的溢價（正值代表牌價高於成交／指數水準）` : "此機型尚無指數資料";
    // source cards
    const cards = $("#index-sources"); cards.innerHTML = "";
    for (const src of Object.values(IXSRC)) {
      const cov = Object.keys(src.gpus).filter((id) => GPU[id]).map((id) => GPU[id].short).join("、");
      const el = document.createElement("div"); el.className = "ixcard"; el.style.setProperty("--c", SLOT_VAR(src.slot));
      el.innerHTML = `<div class="ixh"><span class="sw"></span><a href="${src.url}" target="_blank" rel="noopener">${src.name}</a><span class="tag ${src.access}">${accessName(src.access)}</span></div>
        <div class="ixm">${src.method}</div>
        <div class="ixf"><span>更新：${src.cadence}</span><span>涵蓋：${cov}</span><span>授權：${src.license}</span></div>`;
      cards.appendChild(el);
    }
    $("#index-demo").style.display = IXMETA.demo ? "" : "none";
  }

  // ------------------------------------------------------------ token economics
  const fmtTok = (n) => n == null ? "–" : n >= 1e15 ? (n / 1e15).toFixed(2) + " Q" : n >= 1e12 ? (n / 1e12).toFixed(1) + " T" : n >= 1e9 ? (n / 1e9).toFixed(1) + " B" : n.toLocaleString();
  const fmtPerM = (v) => v == null ? "–" : fmtMoney(v, v >= 10 ? 2 : v >= 1 ? 2 : 3);
  const vendorOf = (id) => TK.vendors.find((v) => v.id === (TK.models.find((m) => m.id === id) || {}).vendor) || TK.vendors[TK.vendors.length - 1];
  const blendOf = (r) => (TK.blend.input * r.i + TK.blend.output * r.o) / (TK.blend.input + TK.blend.output);
  const metricOf = (r) => state.tokenMetric === "in" ? r.i : state.tokenMetric === "out" ? r.o : blendOf(r);
  function tkAt(model, t) { const list = TKPRICE.get(model); if (!list) return null; const p = priceAt(list, t); return p && t - p.t <= 400 * DAY ? p : null; }
  function tokenSeriesStyle() {
    const used = new Map(), out = new Map();
    for (const m of TK.models) {
      if (!state.tokenModels.has(m.id)) continue;
      const v = vendorOf(m.id), dashed = used.has(v.slot); used.set(v.slot, true);
      out.set(m.id, { color: SLOT_VAR(v.slot), dashed });
    }
    return out;
  }
  function renderTokens() {
    if (!TK) return;
    const t = Math.max(latestT(), ...[...TKPRICE.values()].flat().map((r) => r.t));
    // ---- chips
    const chips = $("#token-chips"); chips.innerHTML = "";
    for (const m of TK.models) {
      const v = vendorOf(m.id), b = document.createElement("button");
      b.className = "chip"; b.type = "button"; b.style.setProperty("--c", SLOT_VAR(v.slot)); b.setAttribute("aria-pressed", state.tokenModels.has(m.id));
      const last = tkAt(m.id, t); b.title = last ? `${m.name} · 輸入 ${fmtPerM(last.i)} / 輸出 ${fmtPerM(last.o)} 每百萬 token` : m.name;
      b.innerHTML = `<span class="sw"></span>${m.name}<span class="kind">${TK.tiers[m.tier] || m.tier}</span>`;
      b.addEventListener("click", () => { if (state.tokenModels.has(m.id)) state.tokenModels.delete(m.id); else if (state.tokenModels.size >= 6) { flash("最多同時比較 6 個模型"); return; } else state.tokenModels.add(m.id); persist(); renderTokens(); });
      chips.appendChild(b);
    }
    $$("#token-metric button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.v === state.tokenMetric));
    // ---- price chart (step lines: list prices change in jumps)
    const tkDates = [...new Set([...TKPRICE.values()].flat().map((r) => r.d))].sort();
    const from = state.rangeDays ? t - state.rangeDays * DAY : -Infinity;
    const axis = [...new Set([...tkDates, ...DATES])].filter((d) => toT(d) >= from && toT(d) <= t).sort();
    const styles = tokenSeriesStyle();
    const series = TK.models.filter((m) => state.tokenModels.has(m.id)).map((m) => ({ id: m.id, name: m.name, ...styles.get(m.id), hidden: state.hidden.has("tk:" + m.id),
      values: axis.map((d) => { const p = tkAt(m.id, toT(d)); return p ? metricOf(p) : null; }) }));
    const mName = { in: "輸入", out: "輸出", blend: `混合（${TK.blend.input}:${TK.blend.output}）` }[state.tokenMetric];
    lineChart($("#token-chart"), axis, series, { step: true, height: 300, rightPad: 150, fmtY: (v, exact) => exact ? fmtPerM(v) : fmtMoney(v, v >= 10 ? 0 : 1), aria: "各模型每百萬 token 牌價走勢" });
    const lg = $("#token-legend"); lg.innerHTML = "";
    for (const sr of series) { const li = document.createElement("li"); li.style.setProperty("--c", sr.color); li.className = (sr.dashed ? "dashed " : "") + (sr.hidden ? "off" : ""); li.innerHTML = `<span class="sw"></span>${sr.name}`; li.addEventListener("click", () => { const k = "tk:" + sr.id; state.hidden.has(k) ? state.hidden.delete(k) : state.hidden.add(k); renderTokens(); }); lg.appendChild(li); }
    $("#token-hint").textContent = `每百萬 token 的${mName}牌價（USD）。牌價是階梯狀變動，圖上每一階代表一次調價；同廠商第二個模型以虛線表示。`;
    // ---- KPIs
    const frontier = TK.models.filter((m) => m.tier === "frontier").map((m) => tkAt(m.id, t)).filter(Boolean).map((p) => p.o);
    const frontierThen = TK.models.filter((m) => m.tier === "frontier").map((m) => tkAt(m.id, t - 30 * DAY)).filter(Boolean).map((p) => p.o);
    const fm = median(frontier), fmThen = median(frontierThen);
    $("#tk-frontier .value").innerHTML = fm != null ? fmtPerM(fm) + `<span class="unit">/M 輸出</span>` : "–";
    setDelta($("#tk-frontier .delta"), fm && fmThen ? fm / fmThen - 1 : null, "30日");
    $("#tk-frontier .foot").textContent = `旗艦級模型（${TK.models.filter((m) => m.tier === "frontier").map((m) => m.name).join("、")}）輸出價中位數`;
    const totals = TKUSE.filter((r) => r.scope === "openrouter_total").sort((a, b) => a.t - b.t);
    const lastTot = totals[totals.length - 1], prevTot = totals.length > 1 ? totals[totals.length - 2] : null;
    $("#tk-usage .value").innerHTML = lastTot ? fmtTok(lastTot.n) + `<span class="unit">/週</span>` : "–";
    setDeltaUp($("#tk-usage .delta"), lastTot && prevTot ? lastTot.n / prevTot.n - 1 : null, "週增");
    sparkline($("#tk-usage .spark"), totals.slice(-26).map((r) => r.n), "var(--s3)");
    $("#tk-usage .foot").textContent = lastTot ? `OpenRouter 平台全部模型 · 截至 ${lastTot.d}${lastTot.src === "demo" ? "（示範）" : ""}` : "尚無 OpenRouter 用量資料";
    const ref = tkAt("claude-sonnet-5", t), h100 = medianAt("h100-sxm", "on-demand", t);
    $("#tk-bridge .value").innerHTML = ref && h100 ? (h100 / blendOf(ref)).toFixed(2) + `<span class="unit">百萬 token</span>` : "–";
    $("#tk-bridge .delta").textContent = ref && h100 ? `H100 ${fmtMoney(h100)}/hr ÷ Sonnet 5 混合價 ${fmtPerM(blendOf(ref))}/M` : ""; $("#tk-bridge .delta").className = "delta";
    $("#tk-bridge .foot").textContent = "把租一顆 H100 一小時的錢，拿去買 Claude Sonnet 5 的 token 可以買多少。這是算力側與 token 側價格的橋接指標，不代表 H100 實際能產出的 token 數。";
    // ---- price table
    const rowsT = TK.models.map((m) => { const p = tkAt(m.id, t); if (!p) return null; const then = tkAt(m.id, t - 30 * DAY); return { m, p, then, v: vendorOf(m.id) }; }).filter(Boolean).sort((a, b) => blendOf(a.p) - blendOf(b.p));
    let html = `<table class="data"><thead><tr><th>模型</th><th>廠商</th><th>等級</th><th class="num">輸入 $/M</th><th class="num">輸出 $/M</th><th class="num">快取輸入</th><th class="num">混合價</th><th class="num">30 日</th><th>來源 / 日期</th></tr></thead><tbody>`;
    for (const r of rowsT) { const ch = r.then ? blendOf(r.p) / blendOf(r.then) - 1 : null; html += `<tr><td><span class="sw" style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${SLOT_VAR(r.v.slot)};margin-right:6px;vertical-align:middle"></span>${r.m.name}</td><td>${r.v.name}</td><td>${TK.tiers[r.m.tier] || r.m.tier}</td><td class="num">${fmtPerM(r.p.i)}</td><td class="num">${fmtPerM(r.p.o)}</td><td class="num">${r.p.c == null ? "–" : fmtPerM(r.p.c)}</td><td class="num"><b>${fmtPerM(blendOf(r.p))}</b></td><td class="num ${cls(ch)}">${fmtPct(ch)}</td><td class="src">${r.p.src} · ${r.p.d}</td></tr>`; }
    $("#token-table").innerHTML = html + "</tbody></table>";
    // ---- usage: top models (latest week) + weekly total
    const weeks = [...new Set(TKUSE.filter((r) => r.scope === "openrouter_model").map((r) => r.d))].sort();
    const lastWeek = weeks[weeks.length - 1], prevWeek = weeks[weeks.length - 2];
    const top = TKUSE.filter((r) => r.scope === "openrouter_model" && r.d === lastWeek).sort((a, b) => b.n - a.n).slice(0, 15);
    hbarChart($("#usage-chart"), top.map((r) => { const prev = TKUSE.find((q) => q.scope === "openrouter_model" && q.d === prevWeek && q.key === r.key); const ch = prev ? r.n / prev.n - 1 : null;
      return { label: r.key.split("/").pop(), value: r.n, valueLabel: fmtTok(r.n), color: "var(--accent)", tip: `<div class="t">${r.key}</div><div class="row">本週 token<span class="v">${fmtTok(r.n)}</span></div><div class="row">週增<span class="v">${fmtPct(ch)}</span></div><div class="row">佔平台<span class="v">${lastTot ? (r.n / lastTot.n * 100).toFixed(1) + "%" : "–"}</span></div>` }; }).map((it) => ({ ...it, emphasis: false })), { labelW: 150 });
    $("#usage-hint").textContent = lastWeek ? `OpenRouter 上一週用量最高的 15 個模型（截至 ${lastWeek}），輸入＋輸出 token 合計。T = 兆（10¹²）。` : "尚無資料";
    const tAxis = totals.map((r) => r.d).filter((d) => toT(d) >= from);
    lineChart($("#usage-total-chart"), tAxis, [{ id: "tot", name: "週 token 量", color: "var(--s3)", values: tAxis.map((d) => (totals.find((r) => r.d === d) || {}).n ?? null) }], { height: 220, rightPad: 90, fmtY: (v) => fmtTok(v), aria: "OpenRouter 每週 token 總量" });
    // ---- industry totals table
    const ind = TKUSE.filter((r) => r.scope === "industry").sort((a, b) => a.t - b.t);
    const byOrg = new Map(); for (const r of ind) { if (!byOrg.has(r.key)) byOrg.set(r.key, []); byOrg.get(r.key).push(r); }
    let ih = `<table class="data"><thead><tr><th>組織</th><th class="num">每月 token</th><th>揭露日期</th><th class="num">較上次揭露</th><th class="num">年化成長</th><th>來源</th></tr></thead><tbody>`;
    for (const [org, list] of [...byOrg.entries()].sort((a, b) => b[1][b[1].length - 1].n - a[1][a[1].length - 1].n)) {
      const last = list[list.length - 1], prev = list.length > 1 ? list[list.length - 2] : null;
      const yrs = prev ? (last.t - prev.t) / (365 * DAY) : null, cagr = prev && yrs > 0 ? Math.pow(last.n / prev.n, 1 / yrs) - 1 : null;
      ih += `<tr><td>${last.name || org}</td><td class="num"><b>${fmtTok(last.n)}</b></td><td class="src">${last.d}${last.note ? " · " + last.note : ""}</td><td class="num">${prev ? (last.n / prev.n).toFixed(1) + "×" : "–"}</td><td class="num">${cagr == null ? "–" : (cagr * 100).toFixed(0) + "%"}</td><td class="src">${last.url ? `<a href="${last.url}" target="_blank" rel="noopener">連結</a>` : "–"}</td></tr>`;
    }
    $("#industry-table").innerHTML = ih + "</tbody></table>";
    // ---- OTPI realized cost per lab
    let oh = "";
    const labs = TK.labs.filter((l) => TKOTPI.has(l.id));
    if (labs.length) {
      oh = `<table class="data"><thead><tr><th>實驗室</th><th class="num">實際成交價 $/M</th><th>日期</th><th class="num">7 日</th><th class="num">30 日</th></tr></thead><tbody>`;
      for (const l of labs) { const list = TKOTPI.get(l.id), last = list[list.length - 1]; const at = (days) => { const p = priceAt(list, last.t - days * DAY); return p ? last.v / p.v - 1 : null; };
        oh += `<tr><td>${l.name}</td><td class="num"><b>${fmtPerM(last.v)}</b></td><td class="src">${last.d}${last.src === "demo" ? "（示範）" : ""}</td><td class="num ${cls(at(7))}">${fmtPct(at(7))}</td><td class="num ${cls(at(30))}">${fmtPct(at(30))}</td></tr>`; }
      oh += "</tbody></table>";
    } else oh = `<div class="hint">尚無 Ornn OTPI 資料。執行 <code>scripts/collect_tokens.py</code> 後會出現。</div>`;
    $("#otpi-table").innerHTML = oh;
    $("#token-demo").style.display = (TKMETA.pricesDemo || TKMETA.usageDemo) ? "" : "none";
  }
  function setDeltaUp(el, pct, label) {   // for volumes: up is neutral-good, shown in ink
    el.textContent = pct == null ? "–" : `${pct >= 0 ? "▲" : "▼"} ${(Math.abs(pct) * 100).toFixed(1)}% ${label}`; el.className = "delta";
  }

  // ------------------------------------------------------------ investor summary
  /** generic ascending-by-time series -> {first,last,pct,days,fromDate,toDate} or null if too short */
  function seriesTrend(list) {
    if (!list || list.length < 2) return null;
    const first = list[0], last = list[list.length - 1];
    const days = Math.round((last.t - first.t) / DAY);
    if (days < 1 || !first.v || !last.v) return null;
    return { first: first.v, last: last.v, pct: last.v / first.v - 1, days, fromDate: first.d, toDate: last.d };
  }
  const trendWord = (pct, up = "漲", down = "跌", flat = "持平") => Math.abs(pct) < 0.005 ? flat : (pct > 0 ? up : down);
  const pctAbs = (pct) => (Math.abs(pct) * 100).toFixed(1);

  function renderInvestorSummary() {
    const box = $("#investor-summary"); if (!box) return;
    const t = latestT();
    const cards = [];

    // ---- 1) supply/demand: CGI institutional index trend per GPU + spot/on-demand tightness
    let cgiRows = [];
    if (IXSRC.cgi) {
      for (const gpuId of Object.keys(IXSRC.cgi.gpus)) {
        if (!GPU[gpuId]) continue;
        const tr = seriesTrend(ixSeries("cgi", gpuId));
        if (tr) cgiRows.push({ gpu: GPU[gpuId], ...tr });
      }
    }
    let tightRows = [];
    for (const g of CAT.gpus) {
      const od = medianAt(g.id, "on-demand", t), sp = medianAt(g.id, "spot", t);
      if (od && sp && providerCount(g.id, "on-demand", t) >= 1 && providerCount(g.id, "spot", t) >= 1) {
        tightRows.push({ gpu: g, ratio: sp / od });
      }
    }
    if (cgiRows.length || tightRows.length) {
      cgiRows.sort((a, b) => b.pct - a.pct);
      tightRows.sort((a, b) => b.ratio - a.ratio);
      const riser = cgiRows[0], faller = cgiRows[cgiRows.length - 1];
      const tight = tightRows[0], loose = tightRows[tightRows.length - 1];
      let body = "";
      if (tight) body += `市場上「${tight.gpu.short}」幾乎一位難求——即使是可能被中斷的競價時段，價格也只比隨需價低 ${(100 - tight.ratio * 100).toFixed(0)}%，顯示留給撿便宜的閒置產能很少。`;
      if (loose && loose !== tight) body += `相對地，「${loose.gpu.short}」的競價價只要隨需價的 ${(loose.ratio * 100).toFixed(0)}%，代表市場上還有不少人願意折價出租閒置產能。`;
      if (riser && faller && riser !== faller) body += `獨立機構指數也呼應這個分歧：過去 ${riser.days} 天「${riser.gpu.short}」累計${trendWord(riser.pct)} ${pctAbs(riser.pct)}%，「${faller.gpu.short}」則幾乎${trendWord(faller.pct, "上漲", "下跌")} ${pctAbs(faller.pct)}%。`;
      if (body) cards.push({
        badge: "供需信號", title: "領先晶片仍缺貨，成熟晶片轉入競爭", body,
        note: "資料脈絡：NVIDIA（GPU 供應商）、CoreWeave／Nebius／Lambda 等 AI 專用雲（產能出租方）",
      });
    }

    // ---- 2) pricing strategy: OTPI realized token cost trend per lab
    let otpiRows = [];
    for (const l of TK.labs) {
      const tr = seriesTrend(TKOTPI.get(l.id));
      if (tr) otpiRows.push({ lab: l, ...tr });
    }
    if (otpiRows.length) {
      otpiRows.sort((a, b) => a.pct - b.pct);
      const cutter = otpiRows[0], holder = otpiRows[otpiRows.length - 1];
      let body = `以實際成交量加權的 Token 成本指數來看，過去約 ${cutter.days} 天「${cutter.lab.name}」的每百萬 token 實際成本${trendWord(cutter.pct)}了 ${pctAbs(cutter.pct)}%`;
      body += cutter.pct < 0 ? "，降幅最深；" : "；";
      if (holder && holder !== cutter) body += `「${holder.lab.name}」則${trendWord(holder.pct, "小漲", "小跌", "幾乎持平")} ${pctAbs(holder.pct)}%。`;
      body += "降價可能反映推理效率提升，也可能是搶市占的策略；若持續下去，可能壓縮相關服務的單位營收，除非用量成長能蓋過降價幅度。";
      cards.push({
        badge: "定價策略", title: "AI 推理成本各家步調不一", body,
        note: "資料脈絡：Anthropic、OpenAI、Google（母公司 Alphabet）、DeepSeek 等模型供應商，多數為私人公司或母公司子業務，非直接可投資標的",
      });
    }

    // ---- 3) list price vs realized settlement gap
    let gapRows = [];
    for (const l of TK.labs) {
      const otpiList = TKOTPI.get(l.id); if (!otpiList || !otpiList.length) continue;
      const realized = otpiList[otpiList.length - 1].v;
      const blends = TK.models.filter((m) => m.vendor === l.id).map((m) => { const p = tkAt(m.id, t); return p ? blendOf(p) : null; }).filter((v) => v != null);
      if (!blends.length || !realized) continue;
      const listMed = median(blends);
      gapRows.push({ lab: l, listMed, realized, ratio: listMed / realized });
    }
    if (gapRows.length) {
      gapRows.sort((a, b) => b.ratio - a.ratio);
      const widest = gapRows[0];
      let body = `把各家官網公告的每百萬 token 牌價（依 3:1 輸入輸出比換算）拿來跟 Ornn 揭露的實際結算價比較，「${widest.lab.name}」的落差最大：牌價中位數是實際結算價的 ${widest.ratio.toFixed(1)} 倍（${fmtPerM(widest.listMed)} vs ${fmtPerM(widest.realized)}）。`;
      body += "這通常是因為大量用量集中在較便宜的輕量模型，加上提示詞快取折扣——提醒我們不能只用「牌價 × 預估用量」去推算一家公司的 token 營收。";
      const tableRows = gapRows.map((r) => `<tr><td>${r.lab.name}</td><td class="num">${fmtPerM(r.listMed)}</td><td class="num">${fmtPerM(r.realized)}</td><td class="num"><b>${r.ratio.toFixed(1)}×</b></td></tr>`).join("");
      cards.push({
        badge: "計價陷阱", title: "牌價只是參考價，真正成本差很大", body,
        table: `<table class="data" style="margin-top:8px"><thead><tr><th>模型供應商</th><th class="num">牌價中位數 $/M</th><th class="num">實際結算 $/M</th><th class="num">倍數</th></tr></thead><tbody>${tableRows}</tbody></table>`,
        note: "適用於：任何用「牌價 × 預期用量」估算 AI 服務營收的估值模型",
      });
    }

    // ---- 4) overall rental market index
    const ix = indexSeries(DATES);
    if (ix.values.some((v) => v != null)) {
      const vals = ix.values.filter((v) => v != null);
      const first = vals[0], last = vals[vals.length - 1];
      const days = Math.round((toT(DATES[DATES.length - 1]) - toT(DATES[ix.values.findIndex((v) => v != null)])) / DAY);
      if (days >= 1 && first) {
        const pct = last / first - 1;
        cards.push({
          badge: "整體行情", title: "算力租金大盤：漲跌互見還是全面降價？",
          body: `本站追蹤的 GPU 隨需租金組成的價格指數，自開始追蹤的 ${days} 天以來累計${trendWord(pct)} ${pctAbs(pct)}%。這個指數把多款晶片放在一起看，比單一晶片的價格更能代表「整體算力有沒有變便宜」。`,
          note: `涵蓋：${ix.basket.map((id) => GPU[id].short).join("、")}`,
        });
      }
    }

    // ---- headline synthesis (2x2 on GPU-tightness sign x token-cost sign)
    const gpuUp = cgiRows.length ? cgiRows[0].pct > 0 : null;
    const tokenDown = otpiRows.length ? otpiRows[0].pct < 0 : null;
    let headline;
    if (gpuUp != null && tokenDown != null) {
      if (gpuUp && tokenDown) headline = "這裡的重點：算力市場正呈現「兩頭不同調」——最新晶片仍供不應求、租金持續上升，但 AI 推理的實際成本卻在快速下降。對投資人來說，這代表基礎建設（晶片、機房）端可能還有漲價空間，但應用層的毛利率壓力可能會持續，除非用量成長速度能蓋過降價幅度。";
      else if (gpuUp && !tokenDown) headline = "這裡的重點：晶片端與應用端的價格目前是同向走升——租金和推理成本都在上漲，比較像是需求全面吃緊，而非單純的價格戰。";
      else if (!gpuUp && tokenDown) headline = "這裡的重點：晶片租金與推理成本雙雙下滑，比較像是供給追上了需求，整條 AI 算力供應鏈的價格都在正常化。";
      else headline = "這裡的重點：晶片租金回落、但推理成本沒有明顯下降，可能代表降價的壓力還沒完全傳導到終端服務價格。";
    } else {
      headline = "這裡的重點：以下每張卡片都是從本站當天追蹤到的即時數據自動生成，資料還在累積中，觀察窗越長，結論會越可靠。";
    }
    $("#investor-headline").textContent = headline;

    box.innerHTML = cards.map((c) => `
      <div class="insight-card">
        <span class="insight-badge">${c.badge}</span>
        <h3>${c.title}</h3>
        <p>${c.body}</p>
        ${c.table || ""}
        <div class="insight-note">${c.note}</div>
      </div>`).join("") || `<div class="hint">資料還不夠多，晚一點再回來看看。</div>`;
  }

  function renderAll() {
    renderHeader(); renderControls(); renderKpis(); renderTrend(); renderProviders(); renderHeatmap(); renderValue(); renderTable(); renderIndices(); renderTokens(); renderInvestorSummary();
  }

  // ------------------------------------------------------------ wiring
  function wire() {
    $("#type-seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; state.type = b.dataset.v; persist(); renderAll(); });
    $("#range-seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; state.rangeDays = +b.dataset.v; persist(); renderAll(); });
    $("#cur-seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; state.currency = b.dataset.v; persist(); renderAll(); });
    $("#twd-rate").addEventListener("change", (e) => { const v = parseFloat(e.target.value); if (v > 0) { state.twdRate = v; persist(); renderAll(); } });
    $("#provider-gpu").addEventListener("change", (e) => { state.providerGpu = e.target.value; persist(); renderProviders(); });
    $("#value-seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; state.valueMetric = b.dataset.v; renderControls(); renderValue(); });
    $("#index-gpu").addEventListener("change", (e) => { state.indexGpu = e.target.value; persist(); renderIndices(); });
    $("#token-metric").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; state.tokenMetric = b.dataset.v; persist(); renderTokens(); });
    $("#export-latest").addEventListener("click", () => exportCsv(false));
    $("#export-all").addEventListener("click", () => exportCsv(true));
    $("#theme-toggle").addEventListener("click", () => {
      const root = document.documentElement;
      const dark = root.dataset.theme === "dark" || (!root.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
      root.dataset.theme = dark ? "light" : "dark";
      try { localStorage.setItem("aipt-theme", root.dataset.theme); } catch (_) { /* ignore */ }
      renderHeatmap();
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => renderHeatmap());
    let rt; new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => { renderTrend(); renderProviders(); renderValue(); renderIndices(); renderTokens(); }, 120); }).observe($("#trend-chart"));
  }

  async function load() {
    try {
      const [cat, prices, ixsrc, ix] = await Promise.all([
        fetch("data/catalog.json").then((r) => r.json()), fetch("data/prices.json").then((r) => r.json()),
        fetch("data/index_sources.json").then((r) => r.json()).catch(() => ({ indices: [] })),
        fetch("data/indices.json").then((r) => r.json()).catch(() => ({ meta: {}, rows: [] })),
      ]);
      const [tkcat, tkp, tku] = await Promise.all([
        fetch("data/token_catalog.json").then((r) => r.json()).catch(() => null),
        fetch("data/token_prices.json").then((r) => r.json()).catch(() => ({ meta: {}, rows: [], otpi: [] })),
        fetch("data/token_usage.json").then((r) => r.json()).catch(() => ({ meta: {}, rows: [] })),
      ]);
      if (tkcat) {
        TK = tkcat;
        for (const r of tkp.rows || []) { if (!TK.models.some((m) => m.id === r[1])) continue; if (!TKPRICE.has(r[1])) TKPRICE.set(r[1], []); TKPRICE.get(r[1]).push({ d: r[0], t: toT(r[0]), i: +r[2], o: +r[3], c: r[4] == null ? null : +r[4], src: r[5], usd: +r[3] }); }
        for (const l of TKPRICE.values()) l.sort((a, b) => a.t - b.t);
        for (const r of tkp.otpi || []) { if (!TKOTPI.has(r[1])) TKOTPI.set(r[1], []); TKOTPI.get(r[1]).push({ d: r[0], t: toT(r[0]), v: +r[2], usd: +r[2], src: r[3] }); }
        for (const l of TKOTPI.values()) l.sort((a, b) => a.t - b.t);
        TKUSE = (tku.rows || []).map((r) => ({ d: r[0], t: toT(r[0]), scope: r[1], key: r[2], n: +r[3], src: r[4], name: r[5], url: r[6], note: r[7] }));
        TKMETA = { pricesDemo: !!(tkp.meta || {}).demo, usageDemo: !!(tku.meta || {}).demo };
        for (const id of [...state.tokenModels]) if (!TK.models.some((m) => m.id === id)) state.tokenModels.delete(id);
      } else { $("#tokens").style.display = "none"; }
      CAT = cat; GPU = Object.fromEntries(cat.gpus.map((g) => [g.id, g])); PROV = Object.fromEntries(cat.providers.map((p) => [p.id, p]));
      ROWS = prices.rows.filter((r) => GPU[r[2]] && PROV[r[1]]).map((r) => ({ d: r[0], t: toT(r[0]), provider: r[1], gpu: r[2], type: r[3], usd: +r[4], src: r[5] }));
      ROWS.meta = prices.meta || {};
      for (const r of ROWS) {
        const k = `${r.gpu}|${r.type}`; if (!IDX.has(k)) IDX.set(k, new Map());
        const m = IDX.get(k); if (!m.has(r.provider)) m.set(r.provider, []); m.get(r.provider).push(r);
      }
      for (const m of IDX.values()) for (const l of m.values()) l.sort((a, b) => a.t - b.t);
      DATES = [...new Set(ROWS.map((r) => r.d))].sort(); LATEST = DATES[DATES.length - 1];
      const SHORT = { cgi: "CGI", ocpi: "OCPI", sdh: "Silicon Data", gci: "AxonIndex GCI" };
      IXSRC = Object.fromEntries((ixsrc.indices || []).map((sx) => [sx.id, { ...sx, short: SHORT[sx.id] || sx.publisher }]));
      IXMETA = ix.meta || {};
      IXROWS = (ix.rows || []).filter((r) => IXSRC[r[1]] && GPU[r[2]]).map((r) => ({ d: r[0], t: toT(r[0]), ix: r[1], gpu: r[2], v: +r[3], src: r[4] }));
      for (const r of IXROWS) { const k = `${r.ix}|${r.gpu}`; if (!IXIDX.has(k)) IXIDX.set(k, []); IXIDX.get(k).push(r); }
      for (const l of IXIDX.values()) l.sort((a, b) => a.t - b.t);
      for (const id of [...state.gpus]) if (!GPU[id]) state.gpus.delete(id);
      if (!GPU[state.providerGpu]) state.providerGpu = cat.gpus[0].id;
      wire(); renderAll();
    } catch (err) {
      $("#load-error").style.display = "block";
      $("#load-error code").textContent = String(err);
      console.error(err);
    }
  }
  try { const th = localStorage.getItem("aipt-theme"); if (th) document.documentElement.dataset.theme = th; } catch (_) { /* ignore */ }
  load();
})();
