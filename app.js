/* XRP Fundamentals Dashboard
 * Static, dependency-free. All data fetched client-side:
 *  - CoinGecko REST (CORS-open): price, mcap, volume, 365d history, RLUSD supply
 *  - xrplcluster.com JSON-RPC (CORS-open): validated ledgers w/ expanded txs
 *  - wss://s1.ripple.com WebSocket: gateway_balances for RLUSD on-ledger supply
 *  - data/dashboard.json: curated baseline (score, monthly series) + cached snapshot
 */
'use strict';

const RLUSD_ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const RLUSD_HEX = '524C555344000000000000000000000000000000';
const XRPL_RPC = 'https://xrplcluster.com/';
const XRPL_WS = ['wss://s1.ripple.com', 'wss://s2.ripple.com'];
const PULSE_LEDGERS = 10;
// Supabase aggregation cache (xrp-refresh edge function, cron-refreshed every 10 min).
// Used for news, which has no CORS-open upstream; CORS-open and unauthenticated by design.
const CACHE_ENDPOINT = 'https://dzjqmtoexnthdtlhlcxd.supabase.co/functions/v1/xrp-refresh';

const $ = (id) => document.getElementById(id);
const sourceState = { coingecko: null, xrpl: null, ws: null };

/* ---------- formatting ---------- */
function fmtUsd(v, opts = {}) {
  if (v == null || !isFinite(v)) return '—';
  if (opts.compact || Math.abs(v) >= 1e6) {
    const [num, suf] = compactParts(v);
    return '$' + num + suf;
  }
  const digits = Math.abs(v) < 10 ? 3 : 2;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function compactParts(v) {
  const a = Math.abs(v);
  if (a >= 1e12) return [(v / 1e12).toFixed(2), 'T'];
  if (a >= 1e9) return [(v / 1e9).toFixed(1), 'B'];
  if (a >= 1e6) return [(v / 1e6).toFixed(1), 'M'];
  if (a >= 1e3) return [(v / 1e3).toFixed(1), 'K'];
  return [String(Math.round(v * 100) / 100), ''];
}
function fmtNum(v) {
  if (v == null || !isFinite(v)) return '—';
  const [num, suf] = compactParts(v);
  return num + suf;
}
function fmtDate(ms) {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/* ---------- status badge ---------- */
function setSource(name, ok) {
  sourceState[name] = ok;
  const states = Object.values(sourceState);
  const up = states.filter((s) => s === true).length;
  const known = states.filter((s) => s !== null).length;
  const dot = $('live-dot');
  const label = $('live-label');
  if (known < states.length) { label.textContent = 'Connecting…'; return; }
  if (up === states.length) { dot.className = 'dot ok'; label.textContent = 'Live · all sources connected'; }
  else if (up > 0) { dot.className = 'dot ok'; label.textContent = `Live · ${up}/${states.length} sources`; }
  else { dot.className = 'dot err'; label.textContent = 'Offline · showing cached data'; }
}

/* ---------- tooltip ---------- */
const tooltip = {
  el: null,
  show(x, y, title, rows) {
    const t = this.el;
    t.replaceChildren();
    const h = document.createElement('div');
    h.className = 'tt-title';
    h.textContent = title;
    t.appendChild(h);
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'tt-row';
      const key = document.createElement('span');
      key.className = 'tt-key';
      if (r.color) {
        const sw = document.createElement('i');
        sw.style.background = r.color;
        key.appendChild(sw);
      }
      key.appendChild(document.createTextNode(r.label));
      const val = document.createElement('span');
      val.className = 'tt-val';
      val.textContent = r.value;
      row.append(key, val);
      t.appendChild(row);
    }
    t.hidden = false;
    const pad = 14;
    const rect = t.getBoundingClientRect();
    let left = x + pad;
    if (left + rect.width > window.innerWidth - 8) left = x - rect.width - pad;
    let top = y - rect.height / 2;
    top = Math.max(8, Math.min(top, window.innerHeight - rect.height - 8));
    t.style.left = left + 'px';
    t.style.top = top + 'px';
  },
  hide() { this.el.hidden = true; },
};

/* ---------- svg helpers ---------- */
const NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
function niceTicks(max, count = 4) {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const ticks = [];
  for (let v = 0; v <= max + 1e-9; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

/* ---------- table views ---------- */
function buildTable(containerId, headers, rows) {
  const wrap = $(containerId);
  wrap.replaceChildren();
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  for (const h of headers) {
    const th = document.createElement('th');
    th.textContent = h;
    trh.appendChild(th);
  }
  thead.appendChild(trh);
  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    for (const c of r) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  wrap.appendChild(table);
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.table-toggle[data-table]');
  if (!btn) return;
  const view = $('table-' + btn.dataset.table);
  view.hidden = !view.hidden;
  btn.textContent = view.hidden ? 'View data' : 'Hide data';
});

/* ---------- price line chart ---------- */
function renderPriceChart(prices) {
  const wrap = $('chart-price');
  wrap.replaceChildren();
  const W = wrap.clientWidth || 640;
  const H = wrap.clientHeight || 300;
  const m = { top: 14, right: 64, bottom: 26, left: 48 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, tabindex: '0', role: 'img', 'aria-label': 'XRP daily price, last 12 months' });

  const xs = prices.map((p) => p[0]);
  const ys = prices.map((p) => p[1]);
  const xMin = xs[0], xMax = xs[xs.length - 1];
  const yMax = Math.max(...ys) * 1.06;
  const yMin = Math.min(...ys) * 0.94;
  const X = (t) => m.left + ((t - xMin) / (xMax - xMin)) * iw;
  const Y = (v) => m.top + ih - ((v - yMin) / (yMax - yMin)) * ih;

  // gridlines + y ticks (clean numbers)
  const span = yMax - yMin;
  const step = span > 2 ? 0.5 : span > 1 ? 0.25 : 0.1;
  const first = Math.ceil(yMin / step) * step;
  for (let v = first; v <= yMax; v += step) {
    svg.appendChild(svgEl('line', { x1: m.left, x2: m.left + iw, y1: Y(v), y2: Y(v), stroke: 'var(--grid)', 'stroke-width': 1, 'shape-rendering': 'crispEdges' }));
    const t = svgEl('text', { x: m.left - 8, y: Y(v) + 4, 'text-anchor': 'end', class: 'axis-text', style: 'font-variant-numeric: tabular-nums' });
    t.textContent = '$' + v.toFixed(2);
    svg.appendChild(t);
  }
  // x labels: ~ every 2 months
  const seen = new Set();
  for (let i = 0; i < xs.length; i += 1) {
    const d = new Date(xs[i]);
    const key = d.getFullYear() + '-' + d.getMonth();
    if (d.getDate() <= 3 && !seen.has(key) && d.getMonth() % 2 === 0) {
      seen.add(key);
      const t = svgEl('text', { x: X(xs[i]), y: H - 8, 'text-anchor': 'middle', class: 'axis-text' });
      t.textContent = d.toLocaleDateString('en-US', { month: 'short' });
      svg.appendChild(t);
    }
  }

  // area wash + line
  const pts = prices.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`);
  svg.appendChild(svgEl('path', {
    d: `M${m.left},${m.top + ih} L` + pts.join(' L') + ` L${m.left + iw},${m.top + ih} Z`,
    fill: 'var(--series-1)', opacity: '0.1',
  }));
  svg.appendChild(svgEl('path', {
    d: 'M' + pts.join(' L'),
    fill: 'none', stroke: 'var(--series-1)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }));

  // end marker + direct label
  const last = prices[prices.length - 1];
  svg.appendChild(svgEl('circle', { cx: X(last[0]), cy: Y(last[1]), r: 4.5, fill: 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': 2 }));
  const endLabel = svgEl('text', { x: X(last[0]) + 9, y: Y(last[1]) + 4, class: 'dlabel' });
  endLabel.textContent = fmtUsd(last[1]);
  svg.appendChild(endLabel);

  // crosshair + hover
  const cross = svgEl('line', { y1: m.top, y2: m.top + ih, stroke: 'var(--baseline)', 'stroke-width': 1, visibility: 'hidden' });
  const dot = svgEl('circle', { r: 4.5, fill: 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': 2, visibility: 'hidden' });
  svg.append(cross, dot);
  let focusIdx = prices.length - 1;
  const showAt = (i, clientX, clientY) => {
    const p = prices[i];
    cross.setAttribute('x1', X(p[0])); cross.setAttribute('x2', X(p[0]));
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', X(p[0])); dot.setAttribute('cy', Y(p[1]));
    dot.setAttribute('visibility', 'visible');
    tooltip.show(clientX ?? window.innerWidth / 2, clientY ?? window.innerHeight / 2, fmtDate(p[0]), [
      { label: 'XRP', value: fmtUsd(p[1]), color: 'var(--series-1)' },
    ]);
  };
  const hide = () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tooltip.hide(); };
  svg.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const t = xMin + ((px - m.left) / iw) * (xMax - xMin);
    let lo = 0, hi = xs.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; (xs[mid] < t) ? lo = mid : hi = mid; }
    focusIdx = (t - xs[lo] < xs[hi] - t) ? lo : hi;
    showAt(focusIdx, e.clientX, e.clientY);
  });
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { focusIdx = Math.max(0, focusIdx - 1); }
    else if (e.key === 'ArrowRight') { focusIdx = Math.min(prices.length - 1, focusIdx + 1); }
    else if (e.key === 'Escape') { hide(); return; }
    else return;
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    showAt(focusIdx, r.left + (X(prices[focusIdx][0]) / W) * r.width, r.top + r.height / 2);
  });
  svg.addEventListener('blur', hide);

  wrap.appendChild(svg);

  // table view (monthly closes to keep it readable)
  const monthly = [];
  let lastKey = '';
  for (const p of prices) {
    const d = new Date(p[0]);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    if (key !== lastKey) { monthly.push([key, p[1], p[1], p[1]]); lastKey = key; }
    else {
      const row = monthly[monthly.length - 1];
      row[1] = Math.min(row[1], p[1]); row[2] = Math.max(row[2], p[1]); row[3] = p[1];
    }
  }
  buildTable('table-price', ['Month', 'Low', 'High', 'Close'],
    monthly.map((r) => [r[0], fmtUsd(r[1]), fmtUsd(r[2]), fmtUsd(r[3])]));
}

/* ---------- sparkline ---------- */
function renderSpark(prices) {
  const svg = $('spark-price');
  svg.replaceChildren();
  const recent = prices.slice(-30);
  const ys = recent.map((p) => p[1]);
  const min = Math.min(...ys), max = Math.max(...ys);
  const pts = recent.map((p, i) => {
    const x = (i / (recent.length - 1)) * 118 + 1;
    const y = 29 - ((p[1] - min) / (max - min || 1)) * 26 + 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  svg.appendChild(svgEl('path', { d: 'M' + pts.join(' L'), fill: 'none', stroke: 'var(--deemph)', 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke' }));
  const [lx, ly] = pts[pts.length - 1].split(',');
  svg.appendChild(svgEl('circle', { cx: lx, cy: ly, r: 2.5, fill: 'var(--series-1)' }));
}

/* ---------- monthly stacked bars (curated) ---------- */
function renderMonthlyChart(monthly) {
  // legend
  const legend = $('legend-monthly');
  legend.replaceChildren();
  for (const item of [
    { label: 'Adjusted (economic) volume', color: 'var(--series-1)' },
    { label: 'Other gross volume — exchange-internal, treasury, unclassified', color: 'var(--deemph)' },
  ]) {
    const li = document.createElement('span');
    li.className = 'legend-item';
    const sw = document.createElement('span');
    sw.className = 'legend-swatch';
    sw.style.background = item.color;
    li.append(sw, document.createTextNode(item.label));
    legend.appendChild(li);
  }

  const wrap = $('chart-monthly');
  wrap.replaceChildren();
  const W = wrap.clientWidth || 640;
  const H = wrap.clientHeight || 300;
  const m = { top: 18, right: 12, bottom: 26, left: 44 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Monthly XRP payment volume, adjusted vs gross' });

  const maxGross = Math.max(...monthly.map((d) => d.gross));
  const ticks = niceTicks(maxGross, 4);
  const yTop = ticks[ticks.length - 1];
  const Y = (v) => m.top + ih - (v / yTop) * ih;

  for (const v of ticks) {
    svg.appendChild(svgEl('line', { x1: m.left, x2: m.left + iw, y1: Y(v), y2: Y(v), stroke: 'var(--grid)', 'stroke-width': 1, 'shape-rendering': 'crispEdges' }));
    const t = svgEl('text', { x: m.left - 8, y: Y(v) + 4, 'text-anchor': 'end', class: 'axis-text', style: 'font-variant-numeric: tabular-nums' });
    t.textContent = v + 'B';
    svg.appendChild(t);
  }

  const band = iw / monthly.length;
  const barW = Math.min(24, band * 0.55);
  const GAP = 2; // surface gap between stacked segments

  monthly.forEach((d, i) => {
    const cx = m.left + band * i + band / 2;
    const x = cx - barW / 2;
    const adjH = (d.adjusted / yTop) * ih;
    const otherH = ((d.gross - d.adjusted) / yTop) * ih;
    const yAdjTop = m.top + ih - adjH;
    const g = svgEl('g', { class: 'bar-group' });
    // adjusted: square at baseline
    g.appendChild(svgEl('rect', { x, y: yAdjTop, width: barW, height: Math.max(0, adjH), fill: 'var(--series-1)' }));
    // other gross: sits above with 2px surface gap, rounded top (data end)
    if (otherH > GAP + 2) {
      g.appendChild(svgEl('rect', {
        x, y: yAdjTop - GAP - otherH, width: barW, height: otherH,
        rx: 4, ry: 4, fill: 'var(--deemph)',
      }));
      // re-square the bottom corners of the upper segment
      g.appendChild(svgEl('rect', { x, y: yAdjTop - GAP - 5, width: barW, height: 5, fill: 'var(--deemph)' }));
    }
    // hover hit target (full column, >= 24px wide)
    const hit = svgEl('rect', { x: cx - Math.max(barW, 24) / 2, y: m.top, width: Math.max(barW, 24), height: ih, fill: 'transparent' });
    hit.addEventListener('pointermove', (e) => {
      g.setAttribute('opacity', '0.82');
      tooltip.show(e.clientX, e.clientY, d.month, [
        { label: 'Adjusted', value: d.adjusted.toFixed(2) + 'B XRP', color: 'var(--series-1)' },
        { label: 'Other gross', value: (d.gross - d.adjusted).toFixed(2) + 'B XRP', color: 'var(--deemph)' },
        { label: 'Gross total', value: d.gross.toFixed(2) + 'B XRP' },
        { label: 'Payments', value: d.payments.toFixed(1) + 'M' },
      ]);
    });
    hit.addEventListener('pointerleave', () => { g.removeAttribute('opacity'); tooltip.hide(); });
    svg.append(g, hit);

    // x labels: every other month
    if (i % 2 === 0) {
      const t = svgEl('text', { x: cx, y: H - 8, 'text-anchor': 'middle', class: 'axis-text' });
      t.textContent = d.month.split(' ')[0];
      svg.appendChild(t);
    }
    // direct label on the final bar only
    if (i === monthly.length - 1) {
      const t = svgEl('text', { x: cx, y: Y(d.gross) - GAP - 8, 'text-anchor': 'middle', class: 'dlabel' });
      t.textContent = d.gross.toFixed(1) + 'B';
      svg.appendChild(t);
    }
  });

  // baseline
  svg.appendChild(svgEl('line', { x1: m.left, x2: m.left + iw, y1: m.top + ih, y2: m.top + ih, stroke: 'var(--baseline)', 'stroke-width': 1, 'shape-rendering': 'crispEdges' }));
  wrap.appendChild(svg);

  buildTable('table-monthly', ['Month', 'Gross (B XRP)', 'Adjusted (B XRP)', 'Payments (M)', 'Active accts (K)'],
    monthly.map((d) => [d.month, d.gross.toFixed(2), d.adjusted.toFixed(2), d.payments.toFixed(1), String(d.active)]));
}

/* ---------- XRPL connection (one WebSocket, shared by all queries) ---------- */
const xrplWs = {
  ws: null,
  nextId: 1,
  pending: new Map(),
  connecting: null,

  connect(urls = XRPL_WS) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const tryNext = (i) => {
        if (i >= urls.length) { this.connecting = null; reject(new Error('No XRPL WebSocket reachable')); return; }
        let ws;
        try { ws = new WebSocket(urls[i]); } catch { tryNext(i + 1); return; }
        const timer = setTimeout(() => { try { ws.close(); } catch {} tryNext(i + 1); }, 8000);
        ws.onopen = () => {
          clearTimeout(timer);
          this.ws = ws;
          this.connecting = null;
          ws.onmessage = (e) => {
            try {
              const msg = JSON.parse(e.data);
              const waiter = this.pending.get(msg.id);
              if (waiter) { this.pending.delete(msg.id); waiter(msg); }
            } catch { /* ignore malformed frames */ }
          };
          ws.onclose = () => { if (this.ws === ws) this.ws = null; };
          resolve(ws);
        };
        ws.onerror = () => { clearTimeout(timer); if (this.ws !== ws) tryNext(i + 1); };
      };
      tryNext(0);
    });
    return this.connecting;
  },

  async request(payload, timeoutMs = 15000) {
    const ws = await this.connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('XRPL request timeout')); }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.status === 'success' && msg.result) resolve(msg.result);
        else reject(new Error('XRPL ' + (msg.error || 'error')));
      });
      ws.send(JSON.stringify({ id, ...payload }));
    });
  },
};

/* ---------- live ledger pulse ---------- */
// HTTP fallback: sequential (the cluster refuses parallel bursts) and
// tolerant of lgrNotFound (load-balanced nodes lag a few ledgers).
async function rpcHttp(method, params) {
  const res = await fetch(XRPL_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params: [params] }),
  });
  if (!res.ok) throw new Error('XRPL RPC HTTP ' + res.status);
  const json = await res.json();
  if (json.result?.error) throw new Error('XRPL RPC ' + json.result.error);
  return json.result;
}

function summarizeLedger(result) {
  const lg = result.ledger;
  const txs = lg.transactions || [];
  let payments = 0, xrp = 0;
  for (const t of txs) {
    const tx = t.tx_json || t;
    const meta = t.meta || t.metaData;
    if (!meta || tx.TransactionType !== 'Payment') continue;
    if (meta.TransactionResult !== 'tesSUCCESS') continue;
    if (tx.Account === tx.Destination) continue; // self transfers excluded
    const delivered = meta.delivered_amount ?? meta.DeliveredAmount;
    if (typeof delivered !== 'string') continue; // native XRP only (drops)
    payments += 1;
    xrp += Number(delivered) / 1e6;
  }
  return {
    index: Number(result.ledger_index || lg.ledger_index),
    closeIso: lg.close_time_iso,
    txCount: txs.length,
    payments,
    xrp,
  };
}

async function loadPulse() {
  const wrap = $('chart-pulse');
  wrap.classList.add('stale');
  try {
    let ledgers;
    try {
      // preferred: one WebSocket to a full-history server
      const head = await xrplWs.request({ command: 'ledger', ledger_index: 'validated', transactions: true, expand: true });
      const headSummary = summarizeLedger(head);
      ledgers = [headSummary];
      for (let i = 1; i < PULSE_LEDGERS; i += 1) {
        const r = await xrplWs.request({ command: 'ledger', ledger_index: headSummary.index - i, transactions: true, expand: true });
        ledgers.unshift(summarizeLedger(r));
      }
    } catch {
      // fallback: sequential JSON-RPC against the public cluster
      const head = await rpcHttp('ledger', { ledger_index: 'validated', transactions: true, expand: true });
      const headSummary = summarizeLedger(head);
      ledgers = [headSummary];
      for (let i = 1; i < PULSE_LEDGERS && ledgers.length < PULSE_LEDGERS; i += 1) {
        try {
          const r = await rpcHttp('ledger', { ledger_index: headSummary.index - i, transactions: true, expand: true });
          ledgers.unshift(summarizeLedger(r));
        } catch { /* skip ledgers a lagging node doesn't have */ }
      }
      if (ledgers.length < 4) throw new Error('Too few ledgers sampled');
    }
    renderPulse(ledgers);
    return ledgers;
  } finally {
    wrap.classList.remove('stale');
  }
}

function renderPulse(ledgers) {
  const totalPay = ledgers.reduce((s, l) => s + l.payments, 0);
  const totalXrp = ledgers.reduce((s, l) => s + l.xrp, 0);
  const totalTx = ledgers.reduce((s, l) => s + l.txCount, 0);
  const t0 = new Date(ledgers[0].closeIso).getTime();
  const t1 = new Date(ledgers[ledgers.length - 1].closeIso).getTime();
  const spanSec = Math.max(1, (t1 - t0) / 1000 + 4);

  const stats = $('pulse-stats');
  stats.replaceChildren();
  for (const s of [
    { v: fmtNum(totalXrp) + ' XRP', l: `delivered in ${ledgers.length} ledgers (~${Math.round(spanSec)}s)` },
    { v: (totalPay / spanSec).toFixed(1) + '/s', l: 'successful XRP payments' },
    { v: (totalTx / spanSec).toFixed(1) + '/s', l: 'all transactions' },
  ]) {
    const div = document.createElement('div');
    div.className = 'pulse-stat';
    const v = document.createElement('div'); v.className = 'v'; v.textContent = s.v;
    const l = document.createElement('div'); l.className = 'l'; l.textContent = s.l;
    div.append(v, l);
    stats.appendChild(div);
  }

  const wrap = $('chart-pulse');
  wrap.replaceChildren();
  const W = wrap.clientWidth || 640;
  const H = wrap.clientHeight || 220;
  const m = { top: 16, right: 12, bottom: 24, left: 52 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'XRP delivered per validated ledger, live sample' });

  const maxXrp = Math.max(...ledgers.map((l) => l.xrp), 1);
  const ticks = niceTicks(maxXrp, 3);
  const yTop = ticks[ticks.length - 1];
  const Y = (v) => m.top + ih - (v / yTop) * ih;
  for (const v of ticks) {
    svg.appendChild(svgEl('line', { x1: m.left, x2: m.left + iw, y1: Y(v), y2: Y(v), stroke: 'var(--grid)', 'stroke-width': 1, 'shape-rendering': 'crispEdges' }));
    const t = svgEl('text', { x: m.left - 8, y: Y(v) + 4, 'text-anchor': 'end', class: 'axis-text', style: 'font-variant-numeric: tabular-nums' });
    t.textContent = fmtNum(v);
    svg.appendChild(t);
  }

  const band = iw / ledgers.length;
  const barW = Math.min(24, band - 2); // 2px surface gap between adjacent bars
  const maxIdx = ledgers.reduce((best, l, i) => (l.xrp > ledgers[best].xrp ? i : best), 0);

  ledgers.forEach((l, i) => {
    const cx = m.left + band * i + band / 2;
    const h = Math.max(1.5, (l.xrp / yTop) * ih);
    const bar = svgEl('rect', {
      x: cx - barW / 2, y: m.top + ih - h, width: barW, height: h,
      rx: 4, ry: 4, fill: 'var(--series-1)',
    });
    // square the baseline corners
    const foot = svgEl('rect', { x: cx - barW / 2, y: m.top + ih - Math.min(5, h), width: barW, height: Math.min(5, h), fill: 'var(--series-1)' });
    const hit = svgEl('rect', { x: cx - Math.max(barW, 24) / 2, y: m.top, width: Math.max(barW, 24), height: ih, fill: 'transparent' });
    hit.addEventListener('pointermove', (e) => {
      bar.setAttribute('opacity', '0.82'); foot.setAttribute('opacity', '0.82');
      tooltip.show(e.clientX, e.clientY, 'Ledger #' + l.index.toLocaleString('en-US'), [
        { label: 'XRP delivered', value: fmtNum(l.xrp), color: 'var(--series-1)' },
        { label: 'Payments', value: String(l.payments) },
        { label: 'All txs', value: String(l.txCount) },
      ]);
    });
    hit.addEventListener('pointerleave', () => { bar.removeAttribute('opacity'); foot.removeAttribute('opacity'); tooltip.hide(); });
    svg.append(bar, foot, hit);

    if (i === maxIdx) {
      const t = svgEl('text', { x: cx, y: m.top + ih - h - 7, 'text-anchor': 'middle', class: 'dlabel' });
      t.textContent = fmtNum(l.xrp);
      svg.appendChild(t);
    }
    if (i === 0 || i === ledgers.length - 1) {
      const t = svgEl('text', { x: cx, y: H - 6, 'text-anchor': 'middle', class: 'axis-text' });
      t.textContent = '#' + String(l.index).slice(-4);
      svg.appendChild(t);
    }
  });
  svg.appendChild(svgEl('line', { x1: m.left, x2: m.left + iw, y1: m.top + ih, y2: m.top + ih, stroke: 'var(--baseline)', 'stroke-width': 1, 'shape-rendering': 'crispEdges' }));
  wrap.appendChild(svg);

  buildTable('table-pulse', ['Ledger', 'Closed (UTC)', 'XRP delivered', 'Payments', 'All txs'],
    ledgers.map((l) => [
      '#' + l.index.toLocaleString('en-US'),
      (l.closeIso || '').replace('T', ' ').replace('Z', ''),
      Math.round(l.xrp).toLocaleString('en-US'),
      String(l.payments),
      String(l.txCount),
    ]));

  $('kpi-ledger').textContent = '#' + ledgers[ledgers.length - 1].index.toLocaleString('en-US');
  $('kpi-ledger-note').textContent = `${ledgers[ledgers.length - 1].txCount} txs · closes ~4s apart`;
}

/* ---------- RLUSD on-ledger supply (shared WebSocket) ---------- */
async function fetchRlusdOnXrpl() {
  try {
    const result = await xrplWs.request({
      command: 'gateway_balances', account: RLUSD_ISSUER, ledger_index: 'validated',
    });
    const raw = result.obligations?.[RLUSD_HEX];
    return raw != null ? Number(raw) : null;
  } catch {
    return null;
  }
}

/* ---------- CoinGecko ---------- */
async function fetchMarkets() {
  const res = await fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=ripple,ripple-usd&price_change_percentage=24h');
  if (!res.ok) throw new Error('CoinGecko HTTP ' + res.status);
  const rows = await res.json();
  const out = {};
  for (const r of rows) out[r.id] = r;
  return out;
}
async function fetchPriceHistory() {
  const res = await fetch('https://api.coingecko.com/api/v3/coins/ripple/market_chart?vs_currency=usd&days=365&interval=daily');
  if (!res.ok) throw new Error('CoinGecko HTTP ' + res.status);
  const json = await res.json();
  return { prices: json.prices, volumes: json.total_volumes };
}
async function fetchRlusdHistory() {
  // market cap of a $1 stablecoin ≈ circulating supply, so this doubles as supply history
  const res = await fetch('https://api.coingecko.com/api/v3/coins/ripple-usd/market_chart?vs_currency=usd&days=365&interval=daily');
  if (!res.ok) throw new Error('CoinGecko HTTP ' + res.status);
  return (await res.json()).market_caps;
}

/* ---------- fundamentals score (computed live) ---------- */
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function computeScore({ markets, history, rlusdHistory, rlusdOnXrpl, pulse }) {
  const components = [];

  // 1. Price momentum — current vs ~90 days ago; ±50% saturates the band
  const now = history[history.length - 1][1];
  const back = history[Math.max(0, history.length - 91)][1];
  const momentum = now / back - 1;
  components.push({
    name: 'Price momentum, 90d',
    pts: clamp01(0.5 + momentum) * 25,
    max: 25,
    src: (momentum >= 0 ? '+' : '') + (momentum * 100).toFixed(1) + '% · CoinGecko',
  });

  // 2. Market liquidity — 24h volume / market cap turnover; 4% saturates
  const xrp = markets['ripple'];
  const turnover = xrp.total_volume / xrp.market_cap;
  components.push({
    name: 'Market liquidity',
    pts: clamp01(turnover / 0.04) * 25,
    max: 25,
    src: (turnover * 100).toFixed(2) + '% daily turnover · CoinGecko',
  });

  // 3. RLUSD adoption — 90d supply growth (15) + on-ledger scale vs 1B (10)
  const rNow = rlusdHistory[rlusdHistory.length - 1][1];
  const rBack = rlusdHistory[Math.max(0, rlusdHistory.length - 91)][1];
  const rGrowth = rNow / rBack - 1;
  const growthPts = clamp01((rGrowth + 0.25) / 1.25) * 15; // -25% → 0, +100% → full
  const scalePts = clamp01((rlusdOnXrpl || 0) / 1e9) * 10; // 1B on-ledger → full
  components.push({
    name: 'RLUSD adoption',
    pts: growthPts + scalePts,
    max: 25,
    src: (rGrowth >= 0 ? '+' : '') + (rGrowth * 100).toFixed(0) + '% supply 90d · ' + fmtNum(rlusdOnXrpl || 0) + ' on-ledger',
  });

  // 4. Ledger activity — sampled payments/sec (8/s saturates) + tx/sec (40/s)
  const t0 = new Date(pulse[0].closeIso).getTime();
  const t1 = new Date(pulse[pulse.length - 1].closeIso).getTime();
  const spanSec = Math.max(1, (t1 - t0) / 1000 + 4);
  const pps = pulse.reduce((s, l) => s + l.payments, 0) / spanSec;
  const tps = pulse.reduce((s, l) => s + l.txCount, 0) / spanSec;
  components.push({
    name: 'Ledger activity',
    pts: clamp01(pps / 8) * 15 + clamp01(tps / 40) * 10,
    max: 25,
    src: pps.toFixed(1) + ' pay/s · ' + tps.toFixed(1) + ' tx/s sampled',
  });

  return { total: Math.round(components.reduce((s, c) => s + c.pts, 0)), components };
}

function renderScore(score) {
  $('score-value').textContent = score.total;
  $('score-fill').style.width = score.total + '%';
  const chip = $('score-quality');
  chip.textContent = 'Live';
  chip.className = 'q q-live';
  const box = $('score-breakdown');
  box.replaceChildren();
  for (const c of score.components) {
    const row = document.createElement('div');
    row.className = 'sb-row';
    const name = document.createElement('span');
    name.className = 'sb-name';
    name.textContent = c.name + ' ';
    const src = document.createElement('span');
    src.className = 'sb-src';
    src.textContent = c.src;
    name.appendChild(src);
    const pts = document.createElement('span');
    pts.className = 'sb-pts';
    pts.textContent = Math.round(c.pts);
    const denom = document.createElement('span');
    denom.textContent = ' / ' + c.max;
    pts.appendChild(denom);
    const bar = document.createElement('div');
    bar.className = 'sb-bar';
    const fill = document.createElement('i');
    fill.style.width = Math.round((c.pts / c.max) * 100) + '%';
    bar.appendChild(fill);
    row.append(name, pts, bar);
    box.appendChild(row);
  }
  $('score-note').textContent =
    'Computed just now from live data: 90-day price momentum (±50% band), 24h volume/market-cap turnover (4% = full marks), ' +
    'RLUSD 90-day supply growth plus on-ledger scale (1B = full), and payment/transaction rates sampled from the last ~10 validated ledgers. ' +
    'On-ledger components upgrade to full-month adjusted metrics once the XRPL pipeline (QuickNode → Supabase) is running.';
}

/* ---------- volume history (weekly bars) ---------- */
function renderVolumeChart(volumes) {
  const weekly = [];
  for (let i = 0; i < volumes.length; i += 1) {
    if (i % 7 === 0) weekly.push({ t: volumes[i][0], v: 0 });
    weekly[weekly.length - 1].v += volumes[i][1];
  }
  if (weekly.length > 1 && volumes.length % 7 !== 0) weekly.pop(); // drop partial week

  const wrap = $('chart-volume');
  wrap.replaceChildren();
  const W = wrap.clientWidth || 640;
  const H = wrap.clientHeight || 300;
  const m = { top: 18, right: 12, bottom: 26, left: 52 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'XRP weekly exchange trading volume, last 12 months' });

  const maxV = Math.max(...weekly.map((d) => d.v));
  const ticks = niceTicks(maxV, 4);
  const yTop = ticks[ticks.length - 1];
  const Y = (v) => m.top + ih - (v / yTop) * ih;
  for (const v of ticks) {
    svg.appendChild(svgEl('line', { x1: m.left, x2: m.left + iw, y1: Y(v), y2: Y(v), stroke: 'var(--grid)', 'stroke-width': 1, 'shape-rendering': 'crispEdges' }));
    const t = svgEl('text', { x: m.left - 8, y: Y(v) + 4, 'text-anchor': 'end', class: 'axis-text', style: 'font-variant-numeric: tabular-nums' });
    t.textContent = '$' + fmtNum(v);
    svg.appendChild(t);
  }
  const band = iw / weekly.length;
  const barW = Math.min(24, Math.max(3, band - 2));
  const maxIdx = weekly.reduce((best, d, i) => (d.v > weekly[best].v ? i : best), 0);
  const seen = new Set();
  weekly.forEach((d, i) => {
    const cx = m.left + band * i + band / 2;
    const h = Math.max(1.5, (d.v / yTop) * ih);
    const bar = svgEl('rect', { x: cx - barW / 2, y: m.top + ih - h, width: barW, height: h, rx: 2, ry: 2, fill: 'var(--series-1)' });
    const foot = svgEl('rect', { x: cx - barW / 2, y: m.top + ih - Math.min(3, h), width: barW, height: Math.min(3, h), fill: 'var(--series-1)' });
    const hit = svgEl('rect', { x: m.left + band * i, y: m.top, width: band, height: ih, fill: 'transparent' });
    hit.addEventListener('pointermove', (e) => {
      bar.setAttribute('opacity', '0.82'); foot.setAttribute('opacity', '0.82');
      tooltip.show(e.clientX, e.clientY, 'Week of ' + fmtDate(d.t), [
        { label: 'Volume', value: fmtUsd(d.v, { compact: true }), color: 'var(--series-1)' },
      ]);
    });
    hit.addEventListener('pointerleave', () => { bar.removeAttribute('opacity'); foot.removeAttribute('opacity'); tooltip.hide(); });
    svg.append(bar, foot, hit);
    const dt = new Date(d.t);
    const key = dt.getFullYear() + '-' + dt.getMonth();
    if (!seen.has(key) && dt.getMonth() % 2 === 0) {
      seen.add(key);
      const t = svgEl('text', { x: cx, y: H - 8, 'text-anchor': 'middle', class: 'axis-text' });
      t.textContent = dt.toLocaleDateString('en-US', { month: 'short' });
      svg.appendChild(t);
    }
    if (i === maxIdx) {
      const t = svgEl('text', { x: cx, y: m.top + ih - h - 7, 'text-anchor': 'middle', class: 'dlabel' });
      t.textContent = '$' + fmtNum(d.v);
      svg.appendChild(t);
    }
  });
  svg.appendChild(svgEl('line', { x1: m.left, x2: m.left + iw, y1: m.top + ih, y2: m.top + ih, stroke: 'var(--baseline)', 'stroke-width': 1, 'shape-rendering': 'crispEdges' }));
  wrap.appendChild(svg);

  buildTable('table-volume', ['Week of', 'Volume (USD)'],
    weekly.map((d) => [fmtDate(d.t), '$' + Math.round(d.v).toLocaleString('en-US')]));
}

/* ---------- RLUSD supply history (mini line) ---------- */
function renderRlusdChart(history) {
  const wrap = $('chart-rlusd');
  wrap.replaceChildren();
  const W = wrap.clientWidth || 420;
  const H = wrap.clientHeight || 150;
  const m = { top: 10, right: 56, bottom: 20, left: 44 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'RLUSD total supply, last 12 months' });

  const xs = history.map((p) => p[0]);
  const ys = history.map((p) => p[1]);
  const xMin = xs[0], xMax = xs[xs.length - 1];
  const yMax = Math.max(...ys) * 1.08;
  const X = (t) => m.left + ((t - xMin) / (xMax - xMin)) * iw;
  const Y = (v) => m.top + ih - (v / yMax) * ih;

  for (const v of niceTicks(yMax, 2)) {
    if (v > yMax) continue;
    svg.appendChild(svgEl('line', { x1: m.left, x2: m.left + iw, y1: Y(v), y2: Y(v), stroke: 'var(--grid)', 'stroke-width': 1, 'shape-rendering': 'crispEdges' }));
    const t = svgEl('text', { x: m.left - 6, y: Y(v) + 4, 'text-anchor': 'end', class: 'axis-text', style: 'font-variant-numeric: tabular-nums' });
    t.textContent = fmtNum(v);
    svg.appendChild(t);
  }
  const seen = new Set();
  for (let i = 0; i < xs.length; i += 1) {
    const d = new Date(xs[i]);
    const key = d.getFullYear() + '-' + d.getMonth();
    if (d.getDate() <= 3 && !seen.has(key) && d.getMonth() % 3 === 0) {
      seen.add(key);
      const t = svgEl('text', { x: X(xs[i]), y: H - 5, 'text-anchor': 'middle', class: 'axis-text' });
      t.textContent = d.toLocaleDateString('en-US', { month: 'short' });
      svg.appendChild(t);
    }
  }
  const pts = history.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`);
  svg.appendChild(svgEl('path', {
    d: `M${m.left},${m.top + ih} L` + pts.join(' L') + ` L${m.left + iw},${m.top + ih} Z`,
    fill: 'var(--series-2)', opacity: '0.1',
  }));
  svg.appendChild(svgEl('path', { d: 'M' + pts.join(' L'), fill: 'none', stroke: 'var(--series-2)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  const last = history[history.length - 1];
  svg.appendChild(svgEl('circle', { cx: X(last[0]), cy: Y(last[1]), r: 4, fill: 'var(--series-2)', stroke: 'var(--surface-1)', 'stroke-width': 2 }));
  const endLabel = svgEl('text', { x: X(last[0]) + 8, y: Y(last[1]) + 4, class: 'dlabel' });
  endLabel.textContent = fmtNum(last[1]);
  svg.appendChild(endLabel);

  const cross = svgEl('line', { y1: m.top, y2: m.top + ih, stroke: 'var(--baseline)', 'stroke-width': 1, visibility: 'hidden' });
  const dot = svgEl('circle', { r: 4, fill: 'var(--series-2)', stroke: 'var(--surface-1)', 'stroke-width': 2, visibility: 'hidden' });
  svg.append(cross, dot);
  svg.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const t = xMin + ((px - m.left) / iw) * (xMax - xMin);
    let lo = 0, hi = xs.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; (xs[mid] < t) ? lo = mid : hi = mid; }
    const i = (t - xs[lo] < xs[hi] - t) ? lo : hi;
    const p = history[i];
    cross.setAttribute('x1', X(p[0])); cross.setAttribute('x2', X(p[0])); cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', X(p[0])); dot.setAttribute('cy', Y(p[1])); dot.setAttribute('visibility', 'visible');
    tooltip.show(e.clientX, e.clientY, fmtDate(p[0]), [
      { label: 'RLUSD supply', value: fmtNum(p[1]), color: 'var(--series-2)' },
    ]);
  });
  svg.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tooltip.hide();
  });
  wrap.appendChild(svg);

  const monthly = [];
  let lastKey = '';
  for (const p of history) {
    const d = new Date(p[0]);
    const key = d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    if (key !== lastKey) { monthly.push([key, p[1]]); lastKey = key; }
    else monthly[monthly.length - 1][1] = p[1];
  }
  buildTable('table-rlusd', ['Month', 'Supply (RLUSD, month end)'],
    monthly.map((r) => [r[0], Math.round(r[1]).toLocaleString('en-US')]));
}

/* ---------- ingestion pipeline (measured daily volume) ---------- */
function renderPipeline(days) {
  const latest = days[days.length - 1];

  const stats = $('pipeline-stats');
  stats.replaceChildren();
  const rows = [
    { v: fmtNum(Number(latest.est_daily_gross)) + ' XRP', l: 'est. gross today' },
    { v: ((Number(latest.xrp_adjusted) / Number(latest.xrp_gross)) * 100).toFixed(1) + '%', l: 'adjusted (economic) share' },
    { v: (Number(latest.coverage) * 100).toFixed(1) + '%', l: 'of ledgers sampled today' },
    { v: fmtNum(Number(latest.rlusd_volume)) + ' RLUSD', l: 'sampled RLUSD payments' },
  ];
  if (latest.est_daily_fee_burn != null) {
    rows.push({ v: fmtNum(Number(latest.est_daily_fee_burn)) + ' XRP', l: 'est. fees burned/day' });
  }
  if (latest.est_daily_accounts != null) {
    rows.push({ v: fmtNum(Number(latest.est_daily_accounts)), l: 'est. new accounts/day' });
  }
  for (const s of rows) {
    const div = document.createElement('div');
    div.className = 'pulse-stat';
    const v = document.createElement('div'); v.className = 'v'; v.textContent = s.v;
    const l = document.createElement('div'); l.className = 'l'; l.textContent = s.l;
    div.append(v, l);
    stats.appendChild(div);
  }

  const legend = $('legend-pipeline');
  legend.replaceChildren();
  for (const item of [
    { label: 'Adjusted (economic), est. daily', color: 'var(--series-1)' },
    { label: 'Excluded — same-entity + Ripple treasury', color: 'var(--deemph)' },
  ]) {
    const li = document.createElement('span');
    li.className = 'legend-item';
    const sw = document.createElement('span');
    sw.className = 'legend-swatch';
    sw.style.background = item.color;
    li.append(sw, document.createTextNode(item.label));
    legend.appendChild(li);
  }

  const wrap = $('chart-pipeline');
  wrap.replaceChildren();
  const W = wrap.clientWidth || 640;
  const H = wrap.clientHeight || 220;
  const m = { top: 18, right: 12, bottom: 26, left: 52 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Estimated daily on-ledger XRP payment volume, adjusted vs excluded' });

  const view = days.slice(-30);
  const maxV = Math.max(...view.map((d) => Number(d.est_daily_gross) || 0), 1);
  const ticks = niceTicks(maxV, 3);
  const yTop = ticks[ticks.length - 1];
  const Y = (v) => m.top + ih - (v / yTop) * ih;
  for (const v of ticks) {
    svg.appendChild(svgEl('line', { x1: m.left, x2: m.left + iw, y1: Y(v), y2: Y(v), stroke: 'var(--grid)', 'stroke-width': 1, 'shape-rendering': 'crispEdges' }));
    const t = svgEl('text', { x: m.left - 8, y: Y(v) + 4, 'text-anchor': 'end', class: 'axis-text', style: 'font-variant-numeric: tabular-nums' });
    t.textContent = fmtNum(v);
    svg.appendChild(t);
  }
  const slots = Math.max(view.length, 10); // keep early sparse days readable
  const band = iw / slots;
  const barW = Math.min(24, Math.max(6, band * 0.6));
  const GAP = 2;
  view.forEach((d, i) => {
    const cx = m.left + band * i + band / 2;
    const adj = Number(d.est_daily_adjusted) || 0;
    const gross = Number(d.est_daily_gross) || 0;
    const adjH = (adj / yTop) * ih;
    const otherH = ((gross - adj) / yTop) * ih;
    const yAdjTop = m.top + ih - adjH;
    const g = svgEl('g', {});
    g.appendChild(svgEl('rect', { x: cx - barW / 2, y: yAdjTop, width: barW, height: Math.max(1.5, adjH), fill: 'var(--series-1)' }));
    if (otherH > GAP + 2) {
      g.appendChild(svgEl('rect', { x: cx - barW / 2, y: yAdjTop - GAP - otherH, width: barW, height: otherH, rx: 4, ry: 4, fill: 'var(--deemph)' }));
      g.appendChild(svgEl('rect', { x: cx - barW / 2, y: yAdjTop - GAP - 5, width: barW, height: 5, fill: 'var(--deemph)' }));
    }
    const hit = svgEl('rect', { x: cx - Math.max(barW, 24) / 2, y: m.top, width: Math.max(barW, 24), height: ih, fill: 'transparent' });
    hit.addEventListener('pointermove', (e) => {
      g.setAttribute('opacity', '0.82');
      tooltip.show(e.clientX, e.clientY, d.metric_date, [
        { label: 'Adjusted est.', value: fmtNum(adj) + ' XRP', color: 'var(--series-1)' },
        { label: 'Excluded est.', value: fmtNum(gross - adj) + ' XRP', color: 'var(--deemph)' },
        { label: 'Gross est.', value: fmtNum(gross) + ' XRP' },
        { label: 'Coverage', value: (Number(d.coverage) * 100).toFixed(1) + '% (' + d.ledgers_sampled + ' ledgers)' },
      ]);
    });
    hit.addEventListener('pointerleave', () => { g.removeAttribute('opacity'); tooltip.hide(); });
    svg.append(g, hit);
    const t = svgEl('text', { x: cx, y: H - 8, 'text-anchor': 'middle', class: 'axis-text' });
    t.textContent = d.metric_date.slice(5);
    if (view.length <= 10 || i % Math.ceil(view.length / 8) === 0) svg.appendChild(t);
  });
  svg.appendChild(svgEl('line', { x1: m.left, x2: m.left + iw, y1: m.top + ih, y2: m.top + ih, stroke: 'var(--baseline)', 'stroke-width': 1, 'shape-rendering': 'crispEdges' }));
  wrap.appendChild(svg);

  buildTable('table-pipeline',
    ['Date', 'Ledgers', 'Coverage', 'Payments', 'Gross (sampled)', 'Adjusted (sampled)', 'Est. daily gross', 'Est. daily adjusted', 'RLUSD vol'],
    days.map((d) => [
      d.metric_date,
      String(d.ledgers_sampled),
      (Number(d.coverage) * 100).toFixed(2) + '%',
      Number(d.payment_count).toLocaleString('en-US'),
      fmtNum(Number(d.xrp_gross)),
      fmtNum(Number(d.xrp_adjusted)),
      fmtNum(Number(d.est_daily_gross)),
      fmtNum(Number(d.est_daily_adjusted)),
      fmtNum(Number(d.rlusd_volume)),
    ]));
}

/* ---------- alerts, whales, supply & DeFi ---------- */
function shortAddr(a) { return a ? a.slice(0, 6) + '…' + a.slice(-4) : '?'; }
function agoLabel(iso) {
  const h = (Date.now() - new Date(iso).getTime()) / 3600000;
  return h < 1 ? Math.max(1, Math.round(h * 60)) + ' min ago' : h < 24 ? Math.round(h) + 'h ago' : Math.round(h / 24) + 'd ago';
}

function renderAlerts(alerts) {
  const banner = $('alerts-banner');
  const active = alerts?.active || [];
  if (!active.length) { banner.hidden = true; return; }
  banner.replaceChildren();
  for (const a of active) {
    const item = document.createElement('div');
    item.className = 'alert-item' + (a.severity === 'notable' ? ' notable' : '');
    const t = document.createElement('span'); t.className = 'al-title'; t.textContent = a.title;
    const d = document.createElement('span'); d.className = 'al-detail'; d.textContent = a.detail;
    item.append(t, d);
    banner.appendChild(item);
  }
  banner.hidden = false;
}

function renderWhales(whales) {
  const list = $('whale-list');
  list.replaceChildren();
  if (!Array.isArray(whales) || !whales.length) {
    const div = document.createElement('div');
    div.className = 'whale-empty';
    div.textContent = 'No payments ≥500K XRP in the sampled ledgers over the last 24 hours.';
    list.appendChild(div);
    return;
  }
  for (const w of whales) {
    const row = document.createElement('div');
    row.className = 'whale-row';
    const amt = document.createElement('span');
    amt.className = 'whale-amt';
    amt.textContent = fmtNum(Number(w.amount_xrp)) + ' XRP';
    const route = document.createElement('span');
    route.className = 'whale-route';
    const from = document.createElement('strong');
    from.textContent = w.source_entity || shortAddr(w.source);
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '→';
    const to = document.createElement('strong');
    to.textContent = w.dest_entity || shortAddr(w.destination);
    route.append(from, arrow, to);
    const when = document.createElement('span');
    when.className = 'whale-when';
    when.textContent = agoLabel(w.close_time) + ' · #' + Number(w.ledger_index).toLocaleString('en-US');
    row.append(amt, route, when);
    list.appendChild(row);
  }
}

function renderSupplyDefi(escrow, amm) {
  if (escrow) {
    const stats = $('escrow-stats');
    stats.replaceChildren();
    for (const s of [
      { v: fmtNum(escrow.totalXrp) + ' XRP', l: 'locked in Ripple escrow' },
      { v: escrow.nextUnlock ? fmtNum(escrow.nextUnlock.amount) : '—', l: escrow.nextUnlock ? 'unlocks ' + escrow.nextUnlock.date : 'no scheduled unlock' },
    ]) {
      const div = document.createElement('div');
      div.className = 'pulse-stat';
      const v = document.createElement('div'); v.className = 'v'; v.textContent = s.v;
      const l = document.createElement('div'); l.className = 'l'; l.textContent = s.l;
      div.append(v, l);
      stats.appendChild(div);
    }
    const list = $('unlock-list');
    list.replaceChildren();
    const upcoming = (escrow.upcoming || []).slice(0, 5);
    const maxAmt = Math.max(...upcoming.map((u) => u.amount), 1);
    for (const u of upcoming) {
      const row = document.createElement('div');
      row.className = 'unlock-row';
      const d = document.createElement('span'); d.className = 'u-date'; d.textContent = u.date;
      const track = document.createElement('div'); track.className = 'u-track';
      const fill = document.createElement('i');
      fill.style.width = Math.max(4, (u.amount / maxAmt) * 100).toFixed(0) + '%';
      track.appendChild(fill);
      const amt = document.createElement('span'); amt.className = 'u-amt'; amt.textContent = fmtNum(u.amount);
      row.append(d, track, amt);
      list.appendChild(row);
    }
  }
  if (amm) {
    const stats = $('amm-stats');
    stats.replaceChildren();
    for (const s of [
      { v: String(amm.poolCount), l: 'AMM pools' },
      { v: fmtNum(amm.xrpTvl) + ' XRP', l: 'XRP-side liquidity' },
      { v: amm.rlusdPool ? fmtNum(amm.rlusdPool.xrp) + ' XRP' : '—', l: amm.rlusdPool ? 'RLUSD/XRP pool · ' + amm.rlusdPool.feePct.toFixed(2) + '% fee' : 'RLUSD pool not found' },
    ]) {
      const div = document.createElement('div');
      div.className = 'pulse-stat';
      const v = document.createElement('div'); v.className = 'v'; v.textContent = s.v;
      const l = document.createElement('div'); l.className = 'l'; l.textContent = s.l;
      div.append(v, l);
      stats.appendChild(div);
    }
    $('defi-note').textContent = 'Escrow scanned from Ripple-registry accounts every 6h; AMM pools from XRPSCAN. Unlocked escrow is releasable, not necessarily sold.';
  }
}

/* ---------- governance: amendments + validators ---------- */
function renderGovernance(validators, amendments) {
  if (amendments) {
    const list = $('amendment-list');
    list.replaceChildren();
    for (const a of amendments.voting || []) {
      const row = document.createElement('div');
      row.className = 'amendment';
      const name = document.createElement('span');
      name.className = 'a-name';
      name.textContent = a.name;
      if (a.majority) {
        const chip = document.createElement('span');
        chip.className = 'q q-live';
        chip.textContent = 'Majority';
        name.appendChild(chip);
      }
      const votes = document.createElement('span');
      votes.className = 'a-votes';
      votes.textContent = a.count + ' / ' + a.threshold + ' validators';
      const bar = document.createElement('div');
      bar.className = 'a-bar';
      const fill = document.createElement('i');
      fill.style.width = Math.min(100, (a.count / a.threshold) * 100).toFixed(0) + '%';
      if (a.majority) fill.className = 'majority';
      bar.appendChild(fill);
      row.append(name, votes, bar);
      if (a.majority) {
        const eta = new Date(new Date(a.majority).getTime() + 14 * 86400_000);
        const meta = document.createElement('span');
        meta.className = 'a-meta';
        meta.textContent = 'Majority held since ' + fmtDate(new Date(a.majority).getTime()) + ' — activates ~' + fmtDate(eta.getTime()) + ' if support holds';
        row.appendChild(meta);
      }
      list.appendChild(row);
    }
    const recent = $('recently-enabled');
    recent.replaceChildren();
    if (amendments.recentlyEnabled?.length) {
      const strong = document.createElement('strong');
      strong.textContent = 'Recently enabled: ';
      recent.appendChild(strong);
      recent.appendChild(document.createTextNode(
        amendments.recentlyEnabled.map((r) => r.name + ' (' + String(r.enabledOn).slice(0, 10) + ')').join(' · ')
      ));
    }
  }

  if (validators) {
    const stats = $('validator-stats');
    stats.replaceChildren();
    const topVer = validators.versions?.[0];
    for (const s of [
      { v: String(validators.unlCount), l: 'UNL validators' },
      { v: String(validators.total), l: 'total on mainnet' },
      { v: topVer ? ((topVer[1] / validators.total) * 100).toFixed(0) + '%' : '—', l: topVer ? 'on rippled ' + topVer[0] : '' },
    ]) {
      const div = document.createElement('div');
      div.className = 'pulse-stat';
      const v = document.createElement('div'); v.className = 'v'; v.textContent = s.v;
      const l = document.createElement('div'); l.className = 'l'; l.textContent = s.l;
      div.append(v, l);
      stats.appendChild(div);
    }
    const bars = $('version-bars');
    bars.replaceChildren();
    const maxN = validators.versions?.[0]?.[1] || 1;
    for (const [ver, n] of validators.versions || []) {
      const row = document.createElement('div');
      row.className = 'vbar';
      const name = document.createElement('span'); name.className = 'v-name'; name.textContent = ver;
      const track = document.createElement('div'); track.className = 'v-track';
      const fill = document.createElement('i');
      fill.style.width = ((n / maxN) * 100).toFixed(0) + '%';
      track.appendChild(fill);
      const count = document.createElement('span'); count.className = 'v-count'; count.textContent = String(n);
      row.append(name, track, count);
      bars.appendChild(row);
    }
    buildTable('table-unl', ['Domain', 'Version', 'Last seen (UTC)'],
      (validators.unl || []).map((u) => [
        u.domain || '(no domain)',
        u.version || '—',
        String(u.lastSeen || '').replace('T', ' ').slice(0, 16),
      ]));
  }
}

/* ---------- news (72-hour window enforced at view time) ---------- */
function renderNews(news) {
  const list = $('news-list');
  const note = $('news-note');
  list.replaceChildren();
  const now = Date.now();
  const fresh = (news || []).filter((s) => {
    const age = now - new Date(s.publishedAt).getTime();
    return age >= 0 && age <= 72 * 3600 * 1000;
  });
  if (!fresh.length) {
    note.textContent = 'No stories within the last 72 hours in the current feed. Run scripts/refresh_data.py (or wait for the daily GitHub Action) to refresh.';
    return;
  }
  for (const s of fresh) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = /^https?:\/\//i.test(s.url || '') ? s.url : '#';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = s.title;
    const meta = document.createElement('div');
    meta.className = 'news-meta';
    const src = document.createElement('span');
    src.className = 'news-src';
    src.textContent = s.source || 'Unknown source';
    const ageH = (now - new Date(s.publishedAt).getTime()) / 3600000;
    const age = document.createElement('span');
    age.textContent = ageH < 1 ? Math.max(1, Math.round(ageH * 60)) + ' min ago'
      : ageH < 24 ? Math.round(ageH) + 'h ago'
      : Math.round(ageH / 24) + 'd ago';
    if (ageH <= 6) age.className = 'news-fresh';
    meta.append(src, age);
    li.append(a, meta);
    list.appendChild(li);
  }
  note.textContent = 'Headlines are relevance-filtered from Google News and re-checked against the 72-hour window every time the page loads. Links open the source article.';
}

/* ---------- render market + RLUSD panels ---------- */
function renderMarket(markets, rlusdOnXrpl) {
  const xrp = markets['ripple'];
  const rlusd = markets['ripple-usd'];
  if (xrp) {
    $('kpi-price').textContent = fmtUsd(xrp.current_price);
    const chg = xrp.price_change_percentage_24h;
    const deltaEl = $('kpi-price-delta');
    deltaEl.textContent = (chg >= 0 ? '▲ +' : '▼ ') + chg.toFixed(2) + '% · 24h';
    deltaEl.className = 'tile-delta ' + (chg >= 0 ? 'up' : 'down');
    $('kpi-mcap').textContent = fmtUsd(xrp.market_cap, { compact: true });
    $('kpi-mcap-note').textContent = 'Rank #' + xrp.market_cap_rank;
    $('kpi-vol').textContent = fmtUsd(xrp.total_volume, { compact: true });
  }
  const total = rlusd?.circulating_supply ?? null;
  $('rlusd-total').textContent = total ? fmtNum(total) + ' RLUSD' : '—';
  $('rlusd-price').textContent = rlusd ? fmtUsd(rlusd.current_price) : '—';
  if (rlusdOnXrpl != null) {
    $('kpi-rlusd').textContent = fmtNum(rlusdOnXrpl);
    $('kpi-rlusd-note').textContent = 'Issuer obligations, validated ledger';
    $('rlusd-xrpl').textContent = fmtNum(rlusdOnXrpl) + ' RLUSD';
    if (total) {
      const share = (rlusdOnXrpl / total) * 100;
      $('rlusd-share').textContent = share.toFixed(1) + '% of total supply';
      $('rlusd-fill').style.width = Math.min(100, share).toFixed(1) + '%';
    }
  }
}

/* ---------- curated baseline ---------- */
function renderCurated(data) {
  $('score-value').textContent = data.score;
  $('score-fill').style.width = data.score + '%';
  $('score-note').textContent = data.scoreNote || '';
  renderMonthlyChart(data.monthly);
  renderNews(data.news);
  $('asof').textContent = 'Baseline as of ' + data.asOf;
}

/* ---------- boot ---------- */
let cachedHistory = null;
let cachedRlusdHistory = null;
let curatedData = null;

async function boot() {
  $('foot-updated').textContent = 'Loaded ' + new Date().toLocaleString('en-US');

  // curated JSON (local, also the offline fallback)
  const curatedP = fetch('data/dashboard.json')
    .then((r) => r.json())
    .then((data) => { curatedData = data; renderCurated(data); })
    .catch(() => { $('asof').textContent = 'Baseline unavailable'; });

  // Supabase cache (10-min cron): fresher news + measured pipeline metrics
  fetch(CACHE_ENDPOINT)
    .then((r) => r.json())
    .then((d) => {
      const items = d.cache?.news?.payload;
      if (Array.isArray(items) && items.length) renderNews(items);
      const daily = d.cache?.pipeline_daily?.payload;
      if (Array.isArray(daily) && daily.length) renderPipeline(daily);
      renderGovernance(d.cache?.validators?.payload, d.cache?.amendments?.payload);
      renderAlerts(d.cache?.alerts?.payload);
      renderWhales(d.cache?.whales?.payload);
      renderSupplyDefi(d.cache?.escrow?.payload, d.cache?.amm?.payload);
    })
    .catch(() => { /* dashboard.json news already rendered */ });

  // CoinGecko
  const marketsP = fetchMarkets().catch(() => null);
  const historyP = fetchPriceHistory().catch(() => null);
  const rlusdHistoryP = fetchRlusdHistory().catch(() => null);

  // XRPL websocket (RLUSD) + ledger pulse in parallel
  const rlusdP = fetchRlusdOnXrpl();
  const pulseP = loadPulse().then(
    (ledgers) => { setSource('xrpl', true); return ledgers; },
    () => {
      setSource('xrpl', false);
      $('chart-pulse').replaceChildren(Object.assign(document.createElement('div'), {
        className: 'chart-empty', textContent: 'XRPL cluster unreachable — try Resample',
      }));
      return null;
    }
  );

  const [markets, history, rlusdOnXrpl] = await Promise.all([marketsP, historyP, rlusdP]);
  setSource('coingecko', !!(markets && history));
  setSource('ws', rlusdOnXrpl != null);

  if (markets) renderMarket(markets, rlusdOnXrpl);
  else if (curatedData?.cached) {
    // offline fallback from last refresh snapshot
    const c = curatedData.cached;
    $('kpi-price').textContent = fmtUsd(c.xrpPrice);
    $('kpi-mcap').textContent = fmtUsd(c.xrpMarketCap, { compact: true });
    $('kpi-vol').textContent = fmtUsd(c.xrpVolume24h, { compact: true });
    $('kpi-rlusd').textContent = fmtNum(c.rlusdOnXrpl);
    document.querySelectorAll('.q-live').forEach((q) => { q.textContent = 'Cached'; q.className = 'q q-cache'; });
  }
  if (history) {
    cachedHistory = history;
    renderPriceChart(history.prices);
    renderSpark(history.prices);
    renderVolumeChart(history.volumes);
  } else {
    for (const id of ['chart-price', 'chart-volume']) {
      $(id).replaceChildren(Object.assign(document.createElement('div'), {
        className: 'chart-empty', textContent: 'Market data unreachable',
      }));
    }
  }

  // live fundamentals score — needs price history, RLUSD history and the ledger sample
  const [rlusdHistory, pulseLedgers] = await Promise.all([rlusdHistoryP, pulseP]);
  if (rlusdHistory) { cachedRlusdHistory = rlusdHistory; renderRlusdChart(rlusdHistory); }
  if (markets && history && rlusdHistory && pulseLedgers) {
    try {
      renderScore(computeScore({ markets, history: history.prices, rlusdHistory, rlusdOnXrpl, pulse: pulseLedgers }));
    } catch { /* keep curated fallback */ }
  }

  await Promise.allSettled([curatedP]);
}

$('pulse-refresh').addEventListener('click', () => {
  loadPulse().catch(() => {});
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (cachedHistory) {
      renderPriceChart(cachedHistory.prices);
      renderVolumeChart(cachedHistory.volumes);
    }
    if (cachedRlusdHistory) renderRlusdChart(cachedRlusdHistory);
    if (curatedData) renderMonthlyChart(curatedData.monthly);
  }, 200);
});

tooltip.el = $('tooltip');
boot();
