/* ====================================================
 * 3Tick Scalper – Step Index 100 Assistant
 * Content script for dtrader.deriv.com
 * ==================================================== */
(function () {
  'use strict';

  // ── Constants & Config ────────────────────────────────────────────────────
  const WS_URL          = 'wss://ws.derivws.com/websockets/v3?app_id=1089';
  const WS_URL_FALLBACK = 'wss://ws.deriv.com/websockets/v3?app_id=1089';
  const FALLBACK_AFTER  = 3;
  const TICK_BUF        = 200;
  const SPEED_BUF       = 100;
  const RECONNECT_BASE  = 4000;
  const RECONNECT_MAX   = 64000;
  const SESSION_HISTORY_CAP = 5000;
  const WATCHDOG_INTERVAL   = 5000;
  const WATCHDOG_TICK_TIMEOUT = 25000;

  // ── DOM Selectors ─────────────────────────────────────────────────────────
  const SEL_SIDE_BTNS    = '.trade-params__option > button.item';
  const SEL_PURCHASE_BTN = 'button.purchase-button.purchase-button--single';
  const CLASS_RISE_ACTIVE = 'quill__color--primary-purchase';
  const CLASS_FALL_ACTIVE = 'quill__color--primary-sell';
  const SEL_FLYOUT       = '.dc-flyout';

  let cfg = {
    tickSize: 0.1,
    strategyMode: 'hybrid',
    epsilon: 0.1,
    realTradeEnabled: false,
    realTimeoutMs: 40000,
    realCooldownMs: 5000,
    postTradeCooldownTicks: 5,
    postTradeCooldownMs: 5000,
    debugSignals: true,
    adxMin: 25,
    adxMax: 60,
    adxPeriod: 14,
    rsiPeriod: 14,
    rsiBuyMin: 50,
    rsiBuyMax: 75,
    rsiSellMin: 20,
    rsiSellMax: 40,
    trendEmaPeriod: 10,
    minBBWidth: 0.2,
    minIntensity: 1.2,
  };

  // ── State ─────────────────────────────────────────────────────────────────
  let ticks = [];
  let speedHistory = [];
  let sHigh = 0, sLow = 0, speedMean = 0, speedStd = 0, bbWidth = 0;
  let signals = [], sessionTradesAll = [];
  let tickSeq = 0, lastSignalTickIndex = -999, upStreak = 0, downStreak = 0;
  let lastTickProcessedAt = 0, lastSignalEvalAt = 0, watchdogInterval = null, evalErrorCount = 0;
  let realExecState = 'IDLE', realTrades = [], realOpenCount = 0, realWins = 0, realLosses = 0, realPnl = 0, realLockReason = '', lastRealTradeAt = 0, lastTradeClosedAt = 0, lastTradeClosedTick = -999, realExecTimer = null, lastSeenPnL = 0, lastSeenResult = null;
  let flyoutObserver = null, ws = null, wsState = 'disconnected', reconnectTimer = null, resolvedSymbol = null, manualClose = false, reconnectDelay = RECONNECT_BASE, failCount = 0, usingFallback = false;

  // UI Cache to prevent redundant DOM updates
  let lastUI = { state: '', pnl: null, wins: -1, losses: -1, price: '', stats: '', dist: '', dirStreak: '' };

  // ── Overlay Build ─────────────────────────────────────────────────────────
  function buildOverlay() {
    if (document.getElementById('tt-overlay')) return;
    const el = document.createElement('div');
    el.id = 'tt-overlay';
    el.innerHTML = `
      <div id="tt-header">
        <span class="tt-title">3Tick Timing V2</span>
        <div class="tt-header-btns"><button id="tt-min-btn" title="Minimise">_</button><button id="tt-close-btn" title="Close">X</button></div>
      </div>
      <div id="tt-body">
        <div class="tt-row"><span class="tt-label">Status</span><span class="tt-val" id="tt-status">Disconnected</span></div>
        <div class="tt-row"><span class="tt-label">Last Price</span><span class="tt-val" id="tt-price">-</span></div>
        <div class="tt-row"><span class="tt-label">Dir / Streak</span><span class="tt-val" id="tt-dir-streak">- / 0</span></div>
        <div class="tt-row"><span class="tt-label">S_Low / S_High</span><span class="tt-val" id="tt-speed-stats">0.00 / 0.00</span></div>
        <div class="tt-row"><span class="tt-label">Mean / Std</span><span class="tt-val" id="tt-speed-dist">0.00 / 0.00</span></div>
        <div class="tt-row"><span class="tt-label">ADX / BB_W</span><span class="tt-val" id="tt-adx-stats">0 / 0.00</span></div>
        <div class="tt-row"><span class="tt-label">RSI / Trend</span><span class="tt-val" id="tt-rsi-stats">0 / 0.00</span></div>
        <div class="tt-row"><span class="tt-label">Session W/L</span><span class="tt-val"><span id="tt-wins">0</span> / <span id="tt-losses">0</span></span></div>
        <div id="tt-signals-list"></div>
        <div class="tt-config-section-label">Real Execution</div>
        <div id="tt-real-panel">
          <div class="tt-row"><span class="tt-label">Exec State</span><span class="tt-val" id="tt-real-state">IDLE</span></div>
          <div class="tt-row"><span class="tt-label">Real PnL</span><span class="tt-val" id="tt-real-pnl">0.00</span></div>
          <button id="tt-real-export">Download Real CSV</button>
          <button id="tt-real-reset" style="background:#3d1a1a;color:#e04040;margin-top:2px;">Reset Engine</button>
        </div>
        <button id="tt-config-toggle">Settings</button>
        <div id="tt-config">
          <div class="tt-config-row"><label>Mode</label><select id="tt-cfg-strategy-mode"><option value="unleashed">🔥 Unleashed High-Activity</option><option value="trendIgnition">🚀 Trend Ignition</option><option value="reversalIgnition">🔄 Reversal Ignition</option><option value="ignitionSuite">Full Ignition Suite</option><option value="ignition">Ignition</option><option value="structural3">Structural 3</option><option value="structural2">Structural 2</option><option value="structural">Structural</option><option value="hybrid">Hybrid</option><option value="momentum">Momentum</option><option value="reversal">Reversal</option></select></div>
          <div class="tt-config-row"><label>Trend EMA Period</label><input type="number" id="tt-cfg-trend-ema" min="2" max="100" step="1" value="15"></div>
          <div class="tt-config-row"><label>ADX Period</label><input type="number" id="tt-cfg-adx-period" min="2" max="100" step="1" value="14"></div>
          <div class="tt-config-row"><label>ADX Range</label><div style="display:flex;gap:4px;"><input type="number" id="tt-cfg-adx-min" min="0" max="100" step="1" style="width:50px;" value="25"><input type="number" id="tt-cfg-adx-max" min="0" max="100" step="1" style="width:50px;" value="60"></div></div>
          <div class="tt-config-row"><label>RSI Period</label><input type="number" id="tt-cfg-rsi-period" min="2" max="100" step="1" value="14"></div>
          <div class="tt-config-row"><label>RSI Buy Range</label><div style="display:flex;gap:4px;"><input type="number" id="tt-cfg-rsi-buy-min" min="0" max="100" step="1" style="width:50px;" value="60"><input type="number" id="tt-cfg-rsi-buy-max" min="0" max="100" step="1" style="width:50px;" value="75"></div></div>
          <div class="tt-config-row"><label>RSI Sell Range</label><div style="display:flex;gap:4px;"><input type="number" id="tt-cfg-rsi-sell-min" min="0" max="100" step="1" style="width:50px;" value="30"><input type="number" id="tt-cfg-rsi-sell-max" min="0" max="100" step="1" style="width:50px;" value="40"></div></div>
          <div class="tt-config-row"><label>Min BB Width</label><input type="number" id="tt-cfg-min-bbw" min="0" max="2" step="0.05" value="0.2"></div>
          <div class="tt-config-row"><label>Intensity (Min)</label><input type="number" id="tt-cfg-intensity" min="0.5" max="3" step="0.1" value="1.2"></div>
          <div class="tt-config-row"><label>Epsilon</label><input type="number" id="tt-cfg-epsilon" min="0" max="1" step="0.01" value="0.2"></div>
          <div class="tt-config-row"><label>Debug Signals</label><input type="checkbox" id="tt-cfg-debug"></div>
          <div class="tt-config-section-label">Real Trade Master</div>
          <div class="tt-config-row"><label style="color:#f0a060;font-weight:700;">Enable Real Execution</label><label class="tt-switch"><input type="checkbox" id="tt-cfg-real-enabled"><span class="tt-slider"></span></label></div>
        </div>
        <button id="tt-export">Download Signals CSV</button>
      </div>
      <div id="tt-alert"></div>
    `;
    document.body.appendChild(el);
    const saved = safeStorage('get', 'tt-pos');
    if (saved) { el.style.right = 'auto'; el.style.left = saved.left + 'px'; el.style.top = saved.top + 'px'; }
    makeDraggable(el); bindButtons(el);
  }

  function makeDraggable(el) {
    const header = document.getElementById('tt-header');
    let ox = 0, oy = 0;
    header.addEventListener('mousedown', function (e) {
      if (e.target.tagName === 'BUTTON') return;
      e.preventDefault(); const rect = el.getBoundingClientRect(); ox = e.clientX - rect.left; oy = e.clientY - rect.top;
      document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
    });
    function onMove(e) {
      const left = e.clientX - ox, top = e.clientY - oy;
      el.style.right = 'auto';
      el.style.left = Math.max(0, Math.min(window.innerWidth - el.offsetWidth, left)) + 'px';
      el.style.top = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, top)) + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp);
      safeStorage('set', 'tt-pos', { left: parseInt(el.style.left), top: parseInt(el.style.top) });
    }
  }

  function bindButtons(el) {
    document.getElementById('tt-min-btn').addEventListener('click', () => el.classList.toggle('tt-minimized'));
    document.getElementById('tt-close-btn').addEventListener('click', () => { manualClose = true; if (reconnectTimer) clearTimeout(reconnectTimer); if (ws) ws.close(); el.remove(); });
    document.getElementById('tt-config-toggle').addEventListener('click', () => document.getElementById('tt-config').classList.toggle('tt-open'));
    document.getElementById('tt-cfg-strategy-mode').addEventListener('change', function () { cfg.strategyMode = this.value; saveCfg(); });
    document.getElementById('tt-cfg-trend-ema').addEventListener('change', function () { cfg.trendEmaPeriod = parseInt(this.value) || 15; saveCfg(); });
    document.getElementById('tt-cfg-adx-period').addEventListener('change', function () { cfg.adxPeriod = parseInt(this.value) || 14; saveCfg(); });
    document.getElementById('tt-cfg-adx-min').addEventListener('change', function () { cfg.adxMin = parseFloat(this.value) || 25; saveCfg(); });
    document.getElementById('tt-cfg-adx-max').addEventListener('change', function () { cfg.adxMax = parseFloat(this.value) || 60; saveCfg(); });
    document.getElementById('tt-cfg-rsi-period').addEventListener('change', function () { cfg.rsiPeriod = parseInt(this.value) || 14; saveCfg(); });
    document.getElementById('tt-cfg-rsi-buy-min').addEventListener('change', function () { cfg.rsiBuyMin = parseFloat(this.value) || 60; saveCfg(); });
    document.getElementById('tt-cfg-rsi-buy-max').addEventListener('change', function () { cfg.rsiBuyMax = parseFloat(this.value) || 75; saveCfg(); });
    document.getElementById('tt-cfg-rsi-sell-min').addEventListener('change', function () { cfg.rsiSellMin = parseFloat(this.value) || 30; saveCfg(); });
    document.getElementById('tt-cfg-rsi-sell-max').addEventListener('change', function () { cfg.rsiSellMax = parseFloat(this.value) || 40; saveCfg(); });
    document.getElementById('tt-cfg-min-bbw').addEventListener('change', function () { cfg.minBBWidth = parseFloat(this.value) || 0.2; saveCfg(); });
    document.getElementById('tt-cfg-intensity').addEventListener('change', function () { const val = parseFloat(this.value); cfg.minIntensity = isNaN(val) ? 1.2 : val; saveCfg(); });
    document.getElementById('tt-cfg-epsilon').addEventListener('change', function () { const val = parseFloat(this.value); cfg.epsilon = isNaN(val) ? 0.2 : val; saveCfg(); });
    document.getElementById('tt-cfg-debug').addEventListener('change', function () { cfg.debugSignals = this.checked; saveCfg(); });
    document.getElementById('tt-cfg-real-enabled').addEventListener('change', function () { cfg.realTradeEnabled = this.checked; saveCfg(); });
    document.getElementById('tt-real-export').addEventListener('click', exportRealCSV);
    document.getElementById('tt-real-reset').addEventListener('click', () => { if (confirm('Reset real-trade engine to IDLE and clear lock?')) { realExecState = 'IDLE'; realLockReason = ''; realOpenCount = 0; clearTimeout(realExecTimer); updateRealUI(); } });
    document.getElementById('tt-export').addEventListener('click', exportCSV);
    applyConfigToUI();
  }

  // ── WebSocket & Percentiles ───────────────────────────────────────────────
  function resolveSymbol(symbols) {
    var candidates = ['stpRNG', 'STPRNG'];
    for (var i = 0; i < candidates.length; i++) if (symbols.find(s => s.symbol === candidates[i])) return candidates[i];
    var byName = symbols.find(s => /step\s*index\s*100/i.test(s.display_name));
    return byName ? byName.symbol : (symbols.find(s => /step/i.test(s.display_name))?.symbol || null);
  }

  function connect() {
    if (ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(ws.readyState)) return;
    var url = usingFallback ? WS_URL_FALLBACK : WS_URL; setWsState('connecting');
    ws = new WebSocket(url);
    ws.addEventListener('open', () => {
      setWsState('connected'); reconnectDelay = RECONNECT_BASE; failCount = 0; usingFallback = false;
      lastTickProcessedAt = Date.now(); lastSignalEvalAt = Date.now();
      ws.send(JSON.stringify({ active_symbols: 'brief', product_type: 'basic' }));
    });
    ws.addEventListener('message', (e) => {
      var msg; try { msg = JSON.parse(e.data); } catch (_) { return; }
      if (msg.error) return;
      if (msg.msg_type === 'active_symbols') { var sym = resolveSymbol(msg.active_symbols || []); if (sym) { resolvedSymbol = sym; ws.send(JSON.stringify({ ticks: resolvedSymbol, subscribe: 1 })); } return; }
      if (msg.msg_type === 'tick') handleTick(msg.tick);
    });
    ws.addEventListener('close', () => { setWsState('disconnected'); resolvedSymbol = null; if (!manualClose) scheduleReconnect(); });
    ws.addEventListener('error', () => { setWsState('disconnected'); ws.close(); });
  }

  function scheduleReconnect() {
    if (reconnectTimer) return; failCount++;
    if (failCount >= FALLBACK_AFTER) { usingFallback = !usingFallback; failCount = 0; }
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
  }

  function setWsState(state) {
    wsState = state; const el = document.getElementById('tt-status');
    if (el) el.textContent = state.charAt(0).toUpperCase() + state.slice(1);
  }

  function updateStatsUI() {
    const statsVal = `${sLow.toFixed(4)} / ${sHigh.toFixed(4)}`;
    const distVal = `${speedMean.toFixed(4)} / ${speedStd.toFixed(4)}`;
    const t0 = ticks[ticks.length - 1];
    const currentADX = t0?.adx || 0;
    const adxVal = `${currentADX.toFixed(2)} / ${bbWidth.toFixed(2)}`;

    if (lastUI.stats !== statsVal) {
      const el = document.getElementById('tt-speed-stats');
      if (el) el.textContent = statsVal;
      lastUI.stats = statsVal;
    }
    if (lastUI.dist !== distVal) {
      const el = document.getElementById('tt-speed-dist');
      if (el) el.textContent = distVal;
      lastUI.dist = distVal;
    }
    if (lastUI.adx !== adxVal) {
      const el = document.getElementById('tt-adx-stats');
      if (el) {
        el.textContent = adxVal;
        const amin = cfg.adxMin || 25, amax = cfg.adxMax || 60;
        const minBBW = cfg.minBBWidth || 0.2;
        el.style.color = (currentADX >= amin && currentADX <= amax && bbWidth >= minBBW) ? '#3ecf60' : '#7a8499';
      }
      lastUI.adx = adxVal;
    }

    const currentRSI = t0?.rsi || 50;
    const currentTrend = t0?.trendEma || 0;
    const rsiTrendVal = `${currentRSI.toFixed(1)} / ${currentTrend.toFixed(2)}`;
    if (lastUI.rsiTrend !== rsiTrendVal) {
      const el = document.getElementById('tt-rsi-stats');
      if (el) {
        el.textContent = rsiTrendVal;
        const isUp = t0?.price > currentTrend;
        el.style.color = isUp ? '#3ecf60' : '#e04040';
      }
      lastUI.rsiTrend = rsiTrendVal;
    }
  }

  function calculatePercentiles() {
    if (speedHistory.length >= 10) {
      const sorted = speedHistory.slice().sort((a, b) => a - b);
      const p30 = sorted[Math.floor(sorted.length * 0.3)], p70 = sorted[Math.floor(sorted.length * 0.7)];
      const sum = speedHistory.reduce((a, b) => a + b, 0); speedMean = sum / speedHistory.length;
      const sqDiff = speedHistory.map(v => Math.pow(v - speedMean, 2)); speedStd = Math.sqrt(sqDiff.reduce((a, b) => a + b, 0) / speedHistory.length);
      sHigh = Math.max(p70, speedMean + speedStd); sLow = Math.min(p30, Math.max(0, speedMean - speedStd));
    }

    if (tickSeq % 5 === 0) updateStatsUI();
  }

  function handleTick(tick) {
    if (!tick || tick.symbol !== resolvedSymbol) return;
    const price = parseFloat(tick.quote), epoch = tick.epoch, now = Date.now(); tickSeq++;
    const prevTick = ticks.length ? ticks[ticks.length - 1] : null;
    const delta = prevTick ? price - prevTick.price : 0, deltaSteps = Math.round(delta / 0.1), direction = delta > 0 ? 1 : (delta < 0 ? -1 : 0);
    const deltaTime = prevTick ? (now - prevTick.receivedAt) : 1000;
    const speed = deltaTime > 0 ? deltaSteps / deltaTime : 0, absSpeed = Math.abs(speed);
    const speedTrend = prevTick ? (absSpeed - prevTick.absSpeed) : 0;
    const lastDigit = Math.floor(Math.round(price * 100) / 10) % 10, deltaChange = prevTick ? deltaSteps - prevTick.deltaSteps : 0;
    const preSpeed = prevTick ? prevTick.speed : 0;
    const acceleration = speed - preSpeed;
    const accel = acceleration; // Alias for compatibility with previous updates
    const intensity = Math.abs(speed) / (speedMean || 0.0007);
    const deltaChangeVal = prevTick ? deltaSteps - prevTick.deltaSteps : 0;
    const kTrend = 2 / ((cfg.trendEmaPeriod || 15) + 1);
    const trendEma = prevTick ? (price * kTrend + (prevTick.trendEma || price) * (1 - kTrend)) : price;

    let adx = 0;
    const adxP = cfg.adxPeriod || 14;
    if (ticks.length >= adxP) {
      let trSum = 0, pdmSum = 0, mdmSum = 0;
      for (let i = 0; i < adxP; i++) {
        const curr = i === 0 ? { price } : ticks[ticks.length - i];
        const prev = i === 0 ? ticks[ticks.length - 1] : ticks[ticks.length - i - 1];
        const tr = Math.abs(curr.price - prev.price);
        const pdm = curr.price > prev.price ? curr.price - prev.price : 0;
        const mdm = prev.price > curr.price ? prev.price - curr.price : 0;
        trSum += tr; pdmSum += pdm; mdmSum += mdm;
      }
      const pDI = trSum > 0 ? (pdmSum / trSum) * 100 : 0;
      const mDI = trSum > 0 ? (mdmSum / trSum) * 100 : 0;
      const dx = (pDI + mDI) > 0 ? (Math.abs(pDI - mDI) / (pDI + mDI)) * 100 : 0;
      adx = prevTick && prevTick.adx ? (prevTick.adx * (adxP - 1) + dx) / adxP : dx;
    }

    let rsi = 50;
    const rsiP = cfg.rsiPeriod || 14;
    if (ticks.length >= rsiP) {
      let up = 0, down = 0;
      for (let i = 0; i < rsiP; i++) {
        const curr = i === 0 ? { price } : ticks[ticks.length - i];
        const prev = i === 0 ? ticks[ticks.length - 1] : ticks[ticks.length - i - 1];
        const d = curr.price - prev.price;
        if (d > 0) up += d; else down += Math.abs(d);
      }
      const avgUp = up / rsiP, avgDown = down / rsiP;
      if (avgUp === 0 && avgDown === 0) rsi = 50;
      else rsi = avgDown === 0 ? 100 : 100 - (100 / (1 + avgUp / avgDown));
    }

    if (ticks.length >= 10) {
      const slice = ticks.slice(-10);
      const sqDiffSum = slice.reduce((a, b) => a + Math.pow(b.price - trendEma, 2), 0);
      const stdDev = Math.sqrt(sqDiffSum / 10);
      bbWidth = stdDev * 4; // Upper - Lower = 4 * stdDev
    }

    if (delta > 0) { upStreak++; downStreak = 0; } else if (delta < 0) { downStreak++; upStreak = 0; } else { upStreak = 0; downStreak = 0; }
    const state = { epoch, price, direction, deltaSteps, deltaTime, speed, absSpeed, speedTrend, upStreak, downStreak, lastDigit, deltaChange: deltaChangeVal, receivedAt: now, accel, intensity, preSpeed, acceleration, trendEma, ema10: trendEma, adx, rsi };
    ticks.push(state); if (ticks.length > TICK_BUF) ticks.shift();
    speedHistory.push(absSpeed); if (speedHistory.length > SPEED_BUF) speedHistory.shift();
    calculatePercentiles(); lastTickProcessedAt = Date.now();

    const priceStr = price.toFixed(2);
    if (lastUI.price !== priceStr) {
      const el = document.getElementById('tt-price');
      if (el) el.textContent = priceStr;
      lastUI.price = priceStr;
    }

    const dirStr = direction === 1 ? 'UP' : (direction === -1 ? 'DOWN' : 'FLAT');
    const streakStr = `${dirStr} / ${Math.max(upStreak, downStreak)}`;
    if (lastUI.dirStreak !== streakStr) {
      const el = document.getElementById('tt-dir-streak');
      if (el) {
        el.textContent = streakStr;
        el.style.color = direction === 1 ? '#3ecf60' : (direction === -1 ? '#e04040' : '#fff');
      }
      lastUI.dirStreak = streakStr;
    }

    try { detectSignal(); lastSignalEvalAt = Date.now(); } catch (e) { evalErrorCount++; }

    // Update pending signals for strict Deriv 3-Tick simulation/logging
    signals.forEach(sig => {
      if (sig.result === 'PENDING' && !sig.isReal) { // Only auto-resolve paper trades
        sig.ticksAfter.push(price);

        // Wait for exactly 4 ticks after the signal (T1, T2, T3, T4)
        if (sig.ticksAfter.length === 4) {
          const entryPrice = sig.ticksAfter[0]; // T1: The official start tick
          const exitPrice = sig.ticksAfter[3];  // T4: The official exit tick

          if (sig.type === 'BUY') {
            sig.result = (exitPrice > entryPrice) ? 'WIN' : (exitPrice < entryPrice ? 'LOSS' : 'DRAW');
          } else if (sig.type === 'SELL') {
            sig.result = (exitPrice < entryPrice) ? 'WIN' : (exitPrice > entryPrice ? 'LOSS' : 'DRAW');
          }
          updateSignalsUI();
        }
      } else if (sig.result === 'PENDING' && sig.isReal) {
        sig.ticksAfter.push(price); // Real trades are resolved by the Flyout Observer
      }
    });
  }

  // ── Signal Detection Logic (Master Version) ───────────────────────────────
  function detectSignal() {
    const n = ticks.length; if (n < 2) return null;
    const t0 = ticks[n - 1], tMinus1 = ticks[n - 2], mode = cfg.strategyMode, eps = cfg.epsilon;
    const streak = Math.max(t0.upStreak, t0.downStreak), isEarly = streak <= 2, isLate = streak >= 4;
    const buyDigits = [0, 5, 6, 7], sellDigits = [2, 3, 4, 8];
    const buyDigitBias = buyDigits.includes(t0.lastDigit), sellDigitBias = sellDigits.includes(t0.lastDigit);

    // Filter indicators
    const currentADX = t0.adx || 0;
    const currentRSI = t0.rsi || 50;
    const adxMin = (cfg.adxMin !== undefined) ? cfg.adxMin : 25;
    const adxMax = (cfg.adxMax !== undefined) ? cfg.adxMax : 60;
    const minBBW = (cfg.minBBWidth !== undefined) ? cfg.minBBWidth : 0.2;
    const isTrending = (currentADX >= adxMin && currentADX <= adxMax) && bbWidth >= minBBW;
    const emaSlope = t0.trendEma - tMinus1.trendEma;

    // --- STRATEGY HELPERS ---
    const checkStructural = () => {
      if (buyDigitBias && t0.deltaChange > eps) return { type: 'BUY', conf: 70 };
      if (sellDigitBias && t0.deltaChange < -eps) return { type: 'SELL', conf: 70 };
      return null;
    };
    const checkHybrid = () => {
      if (buyDigitBias && t0.deltaChange > eps && isEarly && t0.speedTrend > 0) return { type: 'BUY', conf: 95 };
      if (sellDigitBias && t0.deltaChange < -eps && isEarly && t0.speedTrend > 0) return { type: 'SELL', conf: 95 };
      return null;
    };
    const checkMomentum = () => {
      if (t0.direction === 1 && isEarly && t0.deltaChange > eps && t0.speedTrend > 0 && t0.absSpeed < sHigh) return { type: 'BUY', conf: 85 };
      if (t0.direction === -1 && isEarly && t0.deltaChange < -eps && t0.speedTrend > 0 && t0.absSpeed < sHigh) return { type: 'SELL', conf: 85 };
      return null;
    };
    const checkReversal = () => {
      if (t0.direction === -1 && isLate && t0.absSpeed <= sLow && t0.deltaChange > -eps && t0.speedTrend < 0) return { type: 'BUY', conf: 75 };
      if (t0.direction === 1 && isLate && t0.absSpeed <= sLow && t0.deltaChange < eps && t0.speedTrend < 0) return { type: 'SELL', conf: 75 };
      return null;
    };
    const checkStructural2 = () => {
      const isCalm = (tMinus1.deltaTime >= 200 && tMinus1.deltaTime <= 2500) && (t0.deltaTime >= 200 && t0.deltaTime <= 2500);
      if (!isCalm) return null;
      if (t0.direction === 1 && tMinus1.direction === -1 && t0.deltaChange === 2) {
        if (tMinus1.lastDigit === 2) return { type: 'BUY', conf: 90, triggerDigit: 2, triggerDesc: 'Struct2: Flip+Accel(2.0)' };
      }
      if (t0.direction === -1 && tMinus1.direction === 1 && t0.deltaChange === -2) {
        if (tMinus1.lastDigit === 2) return { type: 'SELL', conf: 90, triggerDigit: 2, triggerDesc: 'Struct2: Flip+Accel(-2.0)' };
      }
      return null;
    };
    const checkPowerStep = () => {
      const isDigit2Edge = (t0.lastDigit === 2 || tMinus1.lastDigit === 2);
      const isPowerMove = Math.abs(t0.deltaSteps) >= 2;
      if (isDigit2Edge && isPowerMove) return { type: t0.direction === 1 ? 'BUY' : 'SELL', conf: 98, triggerDesc: 'POWER-PIVOT', triggerDigit: t0.lastDigit, startTickIndex: tickSeq + 1 };
      return null;
    };
    const checkMomentumIgnition = () => {
      const isIgnition = Math.abs(t0.acceleration) > 0.0015 && Math.abs(t0.deltaSteps) >= 1;
      if (isIgnition && streak <= 2) return { type: t0.direction === 1 ? 'BUY' : 'SELL', conf: 90, triggerDesc: 'MOMENTUM-IGN', triggerDigit: t0.lastDigit, startTickIndex: tickSeq + 1 };
      return null;
    };
    const checkReversalFlip = () => {
      const isFlip = Math.sign(tMinus1.speed) !== Math.sign(t0.speed);
      if (isFlip && Math.abs(t0.acceleration) > 0.002) return { type: t0.direction === 1 ? 'BUY' : 'SELL', conf: 95, triggerDesc: 'EXPLOSIVE-FLIP', triggerDigit: t0.lastDigit, startTickIndex: tickSeq + 1 };
      return null;
    };
    const checkIgnition = () => {
      const flow = ticks.slice(-3).map(t => t.lastDigit).join('-');
      const minIntensity = cfg.minIntensity || 1.2;
      if (streak >= 3 && t0.intensity > minIntensity && Math.abs(t0.acceleration) > 0.0001) {
        if (t0.direction === 1 && t0.acceleration > 0) return { type: 'BUY', conf: 88, triggerDesc: 'Ignition: Trend Surge' };
        if (t0.direction === -1 && t0.acceleration < 0) return { type: 'SELL', conf: 88, triggerDesc: 'Ignition: Trend Surge' };
      }
      const buyFlows = ['0-6-5', '0-1-2'], sellFlows = ['2-3-4', '8-1-0'];
      if (t0.direction === 1 && tMinus1.direction === -1 && buyFlows.includes(flow)) return { type: 'BUY', conf: 94, triggerDesc: `Ignition: Rev (${flow})` };
      if (t0.direction === -1 && tMinus1.direction === 1 && sellFlows.includes(flow)) return { type: 'SELL', conf: 94, triggerDesc: `Ignition: Rev (${flow})` };
      return null;
    };
    const checkTrendIgnition = () => {
      const isSameDirection = Math.sign(t0.preSpeed) === Math.sign(t0.speed);
      const isCleanMove = Math.abs(t0.deltaSteps) === 1;
      const isStableAccel = t0.acceleration >= -0.0003;
      const isWeakMove = Math.abs(t0.speed) < 0.0007;
      if (streak <= 2 && isSameDirection && isCleanMove && isStableAccel && !isWeakMove) return { type: t0.direction === 1 ? 'BUY' : 'SELL', conf: 85, triggerDesc: `Trend Ignition (S:${streak})` };
      return null;
    };
    const checkReversalIgnition = () => {
      const isFlip = Math.sign(t0.preSpeed) !== Math.sign(t0.speed);
      const isStrongAccel = Math.abs(t0.acceleration) > 0.0007;
      const isCleanMove = Math.abs(t0.deltaSteps) === 1;
      if (streak <= 2 && isFlip && isStrongAccel && isCleanMove) return { type: t0.direction === 1 ? 'BUY' : 'SELL', conf: 90, triggerDesc: `Rev Ignition (Accel:${t0.acceleration.toFixed(4)})` };
      return null;
    };

    let res = null;

    // Evaluation Logic
    if (mode === 'unleashed') {
      const minIntensity = (cfg.minIntensity !== undefined) ? cfg.minIntensity : 0;
      const epsilon = (cfg.epsilon !== undefined) ? cfg.epsilon : 0;

      // BUY Conditions
      const buyOk = (
        t0.direction === 1 &&                               // Price is UP
        t0.price > t0.trendEma &&                           // Price > Trend EMA
        currentADX >= adxMin && currentADX <= adxMax &&     // ADX is 25-60 (using dashboard range)
        currentRSI >= ((cfg.rsiBuyMin !== undefined) ? cfg.rsiBuyMin : 50) && currentRSI <= ((cfg.rsiBuyMax !== undefined) ? cfg.rsiBuyMax : 75) && // RSI Buy Range
        bbWidth > ((cfg.minBBWidth !== undefined) ? cfg.minBBWidth : 0.2) &&                // BB Width > 0.2
        t0.intensity > minIntensity &&                      // Intensity > minIntensity
        t0.deltaChange > epsilon                            // DeltaChange > epsilon
      );

      // SELL Conditions
      const sellOk = (
        t0.direction === -1 &&                              // Price is DOWN
        t0.price < t0.trendEma &&                           // Price < Trend EMA
        currentADX >= adxMin && currentADX <= adxMax &&     // ADX is 25-60
        currentRSI >= ((cfg.rsiSellMin !== undefined) ? cfg.rsiSellMin : 20) && currentRSI <= ((cfg.rsiSellMax !== undefined) ? cfg.rsiSellMax : 40) && // RSI Sell Range
        bbWidth > ((cfg.minBBWidth !== undefined) ? cfg.minBBWidth : 0.2) &&                // BB Width > 0.2
        t0.intensity > minIntensity &&                      // Intensity > minIntensity
        t0.deltaChange < -epsilon                           // DeltaChange < -epsilon
      );

      if (buyOk) res = { type: 'BUY', conf: 100, triggerDesc: 'DASHBOARD-CONFLUENCE' };
      else if (sellOk) res = { type: 'SELL', conf: 100, triggerDesc: 'DASHBOARD-CONFLUENCE' };
    }
    else if (mode === 'ignitionSuite') { if (streak < 4) res = checkReversalFlip() || checkMomentumIgnition(); }
    else if (mode === 'trendIgnition') res = checkTrendIgnition();
    else if (mode === 'reversalIgnition') res = checkReversalIgnition();
    else if (mode === 'ignition') res = checkIgnition() || checkPowerStep();
    else if (mode === 'structural3') res = checkPowerStep() || checkStructural2();
    else if (mode === 'structural2') res = checkStructural2();
    else if (mode === 'structural') res = checkStructural();
    else if (mode === 'hybrid') res = checkIgnition() || checkPowerStep() || checkMomentumIgnition() || checkHybrid() || checkStructural2();
    else if (mode === 'momentum') res = checkMomentum() || checkMomentumIgnition() || checkPowerStep() || checkHybrid() || checkStructural2();
    else if (mode === 'trendIgnition') res = checkTrendIgnition();
    else if (mode === 'reversalIgnition') res = checkReversalIgnition();
    else if (mode === 'ignition') res = checkIgnition() || checkPowerStep();
    else if (mode === 'structural3') res = checkPowerStep() || checkStructural2();
    else if (mode === 'structural2') res = checkStructural2();
    else if (mode === 'structural') res = checkStructural();
    else if (mode === 'hybrid') res = checkIgnition() || checkPowerStep() || checkMomentumIgnition() || checkHybrid() || checkStructural2();
    else if (mode === 'momentum') res = checkMomentum() || checkMomentumIgnition() || checkPowerStep() || checkHybrid() || checkStructural2();
    else if (mode === 'reversal') res = checkReversal() || checkReversalFlip();

    if (res) {
      if (res) {
        const currentTickIndex = tickSeq;
        if (mode !== 'unleashed') {
          if (currentTickIndex - lastSignalTickIndex < cfg.postTradeCooldownTicks || Date.now() - lastTradeClosedAt < cfg.postTradeCooldownMs) return null;
        }
        if (realExecState !== 'IDLE') return null;
        lastSignalTickIndex = currentTickIndex;
        let conf = res.conf;
      if (mode !== 'unleashed' && !res.triggerDesc?.includes('POWER') && ((res.type === 'BUY' && !buyDigitBias) || (res.type === 'SELL' && !sellDigitBias))) conf -= 10;

      const sig = {
        type: res.type,
        price: t0.price,
        time: t0.epoch,
        result: 'PENDING',
        ticksAfter: [],
        confidence: Math.min(100, conf),
        strategy: mode,
        isReal: cfg.realTradeEnabled,
        triggerDigit: res.triggerDigit || t0.lastDigit,
        triggerDesc: res.triggerDesc,
        startTickIndex: res.startTickIndex || tickSeq + 1,
        startTime: Date.now(),
        metrics: {
          rsi: t0.rsi,
          adx: t0.adx,
          bbw: bbWidth,
          intensity: t0.intensity,
          epsilon: t0.deltaChange,
          sLow: sLow,
          sHigh: sHigh
        }
      };
        signals.push(sig); if (signals.length > 50) signals.shift(); recordSessionTrade(sig); updateSignalsUI();
        if (cfg.realTradeEnabled) { realExecState = 'OPEN_PENDING'; realLockReason = 'EXECUTING'; updateRealUI(); executeRealTrade(res.type); }
      }
    }
    return null;
  }

  // ── Infrastructure ────────────────────────────────────────────────────────
  function updateWinsLossesUI() {
    if (lastUI.wins !== realWins) {
      const we = document.getElementById('tt-wins');
      if (we) we.textContent = realWins;
      lastUI.wins = realWins;
    }
    if (lastUI.losses !== realLosses) {
      const le = document.getElementById('tt-losses');
      if (le) le.textContent = realLosses;
      lastUI.losses = realLosses;
    }
  }
  function updateSignalsUI() {
    const el = document.getElementById('tt-signals-list'); if (!el) return;
    el.innerHTML = ''; signals.slice(-10).reverse().forEach(sig => {
      const div = document.createElement('div'); div.className = `tt-signal tt-signal-${sig.type.toLowerCase()}`;
      const badge = sig.result === 'WIN' ? '<span class="tt-badge tt-badge-win">WIN</span>' : sig.result === 'LOSS' ? '<span class="tt-badge tt-badge-loss">LOSS</span>' : '<span class="tt-badge tt-badge-pending">...</span>';
      div.innerHTML = `<span class="tt-signal-type">${sig.type}</span><span class="tt-signal-price">${(sig.entryPriceReal || sig.price).toFixed(2)}</span><span class="tt-signal-time">${new Date(sig.time*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})} [${sig.confidence}%]</span>${badge}`;
      el.appendChild(div);
    });
  }
  function updateRealUI() {
    const stateStr = realExecState + (realLockReason ? ` (${realLockReason})` : '');
    if (lastUI.state !== stateStr) {
      const stEl = document.getElementById('tt-real-state');
      if (stEl) {
        stEl.textContent = stateStr;
        stEl.style.color = { IDLE: '#3ecf60', RECOVERY: '#e04040', OPEN: '#f0c040', OPEN_PENDING: '#7ec8e3' }[realExecState] || '#fff';
      }
      lastUI.state = stateStr;
    }
    const pnlEl = document.getElementById('tt-real-pnl');
    if (pnlEl) {
      pnlEl.textContent = realPnl.toFixed(2);
      pnlEl.style.color = realPnl >= 0 ? '#3ecf60' : '#e04040';
    }
    updateWinsLossesUI();
  }
  function showAlert(msg) { const el = document.getElementById('tt-alert'); if (el) { el.textContent = msg; el.classList.add('tt-visible'); setTimeout(() => el.classList.remove('tt-visible'), 5000); } }
  function recordSessionTrade(sig) { sessionTradesAll.push(sig); if (sessionTradesAll.length > SESSION_HISTORY_CAP) sessionTradesAll.shift(); }
  function exportCSV() {
    if (!sessionTradesAll.length) return;
    const head = ['Type', 'Strategy', 'Price', 'Time', 'Result', 'Digit', 'Desc', 'Sig RSI', 'Sig ADX', 'Sig BBW', 'Sig Int', 'Sig Eps', 'Sig SLow', 'Sig SHigh', 'Conf RSI', 'Conf ADX', 'Conf BBW', 'Conf Int', 'Conf Eps', 'Conf SLow', 'Conf SHigh'];
    const rows = [head].concat(sessionTradesAll.map(s => {
      const m = s.metrics || {}, cm = s.confirmMetrics || {};
      return [s.type, s.strategy, s.price.toFixed(2), s.time, s.result, s.triggerDigit ?? '', s.triggerDesc ?? '', m.rsi??'', m.adx??'', m.bbw??'', m.intensity??'', m.epsilon??'', m.sLow??'', m.sHigh??'', cm.rsi??'', cm.adx??'', cm.bbw??'', cm.intensity??'', cm.epsilon??'', cm.sLow??'', cm.sHigh??''];
    }));
    const csv = rows.map(r => r.join(',')).join('\n'); const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = '3tick-signals.csv'; a.click();
  }
  function exportRealCSV() {
    if (!realTrades.length) return;
    const head = ['Time', 'Side', 'Result', 'PnL', 'Digit', 'Desc', 'Sig RSI', 'Sig ADX', 'Sig BBW', 'Sig Int', 'Sig Eps', 'Sig SLow', 'Sig SHigh', 'Conf RSI', 'Conf ADX', 'Conf BBW', 'Conf Int', 'Conf Eps', 'Conf SLow', 'Conf SHigh'];
    const rows = [head].concat(realTrades.map(t => {
      const s = t.signalRef || {}, m = s.metrics || {}, cm = t.confirmMetrics || {};
      return [new Date(t.time).toISOString(), t.side, t.result, t.pnl || '', s.triggerDigit ?? '', s.triggerDesc ?? '', m.rsi??'', m.adx??'', m.bbw??'', m.intensity??'', m.epsilon??'', m.sLow??'', m.sHigh??'', cm.rsi??'', cm.adx??'', cm.bbw??'', cm.intensity??'', cm.epsilon??'', cm.sLow??'', cm.sHigh??''];
    }));
    const csv = rows.map(r => r.join(',')).join('\n'); const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = '3tick-real.csv'; a.click();
  }
  function safeStorage(op, key, val) { try { if (op === 'get') return JSON.parse(localStorage.getItem(key)); if (op === 'set') localStorage.setItem(key, JSON.stringify(val)); } catch (_) { } return null; }
  function saveCfg() { safeStorage('set', 'tt-cfg', cfg); }
  function loadCfg() { const stored = safeStorage('get', 'tt-cfg'); return Object.assign({ strategyMode: 'hybrid', epsilon: 0.1, minIntensity: 1.2, realTradeEnabled: false, realTimeoutMs: 40000, realCooldownMs: 5000, postTradeCooldownTicks: 5, postTradeCooldownMs: 5000, debugSignals: true, adxMin: 25, adxMax: 60, adxPeriod: 14, rsiPeriod: 14, rsiBuyMin: 50, rsiBuyMax: 75, rsiSellMin: 20, rsiSellMax: 40, trendEmaPeriod: 10, minBBWidth: 0.2 }, stored || {}); }
  function applyConfigToUI() {
    const dbg = document.getElementById('tt-cfg-debug'),
          re = document.getElementById('tt-cfg-real-enabled'),
          mode = document.getElementById('tt-cfg-strategy-mode'),
          eps = document.getElementById('tt-cfg-epsilon'),
          intensity = document.getElementById('tt-cfg-intensity'),
          mbbw = document.getElementById('tt-cfg-min-bbw'),
          adxMin = document.getElementById('tt-cfg-adx-min'),
          adxMax = document.getElementById('tt-cfg-adx-max'),
          adxPeriod = document.getElementById('tt-cfg-adx-period'),
          rsiPeriod = document.getElementById('tt-cfg-rsi-period'),
          rsiBuyMin = document.getElementById('tt-cfg-rsi-buy-min'),
          rsiBuyMax = document.getElementById('tt-cfg-rsi-buy-max'),
          rsiSellMin = document.getElementById('tt-cfg-rsi-sell-min'),
          rsiSellMax = document.getElementById('tt-cfg-rsi-sell-max'),
          trendEma = document.getElementById('tt-cfg-trend-ema');

    if (dbg) dbg.checked = cfg.debugSignals;
    if (re) re.checked = !!cfg.realTradeEnabled;
    if (mode) mode.value = cfg.strategyMode;
    if (eps) eps.value = cfg.epsilon;
    if (intensity) intensity.value = (cfg.minIntensity !== undefined) ? cfg.minIntensity : 1.2;
    if (mbbw) mbbw.value = cfg.minBBWidth || 0.2;
    if (adxMin) adxMin.value = cfg.adxMin || 25;
    if (adxMax) adxMax.value = cfg.adxMax || 60;
    if (adxPeriod) adxPeriod.value = cfg.adxPeriod || 14;
    if (rsiPeriod) rsiPeriod.value = cfg.rsiPeriod || 14;
    if (rsiBuyMin) rsiBuyMin.value = cfg.rsiBuyMin || 60;
    if (rsiBuyMax) rsiBuyMax.value = cfg.rsiBuyMax || 75;
    if (rsiSellMin) rsiSellMin.value = cfg.rsiSellMin || 30;
    if (rsiSellMax) rsiSellMax.value = cfg.rsiSellMax || 40;
    if (trendEma) trendEma.value = cfg.trendEmaPeriod || 15;
    updateRealUI();
  }
  function startWatchdog() { if (watchdogInterval) clearInterval(watchdogInterval); watchdogInterval = setInterval(() => { const now = Date.now(); if (wsState !== 'connected') return; if (lastTickProcessedAt > 0 && now - lastTickProcessedAt > WATCHDOG_TICK_TIMEOUT) { if (ws) ws.close(); scheduleReconnect(); } }, WATCHDOG_INTERVAL); }
  let subObserver = null, lastFlyoutNode = null;
  function setupFlyoutObserver() {
    if (flyoutObserver) return;
    flyoutObserver = new MutationObserver(() => {
      const flyout = document.querySelector(SEL_FLYOUT);
      if (flyout) {
        if (flyout !== lastFlyoutNode) {
          if (subObserver) subObserver.disconnect();
          lastFlyoutNode = flyout;
          subObserver = new MutationObserver(() => processFlyout(flyout));
          subObserver.observe(flyout, { childList: true, subtree: true, characterData: true });
          processFlyout(flyout);
        }
      } else {
        if (subObserver) { subObserver.disconnect(); subObserver = null; lastFlyoutNode = null; }
        if (realExecState === 'OPEN' || realExecState === 'RECOVERY' || realExecState === 'OPEN_PENDING') {
          realOpenCount = 0;
          finalizeRealTrade({ pnl: lastSeenPnL, result: lastSeenResult || (lastSeenPnL > 0 ? 'WIN' : 'LOSS') });
          realExecState = 'IDLE'; realLockReason = ''; lastSeenPnL = 0; lastSeenResult = null; updateRealUI();
        }
      }
    });
    flyoutObserver.observe(document.body, { childList: true, subtree: true });
  }

  function processFlyout(flyout) {
      const text = flyout.innerText;

      // Purchase confirmation
      if (text.includes("Contract bought") || text.includes("ID:")) {
        const sig = signals.find(s => s.result === 'PENDING' && s.isReal && !s.startTickIndex);
        if (sig) {
          sig.startTickIndex = tickSeq + 1; sig.startTime = Date.now();
          const t0 = ticks[ticks.length - 1];
          if (t0) {
            sig.confirmMetrics = {
              rsi: t0.rsi,
              adx: t0.adx,
              bbw: bbWidth,
              intensity: t0.intensity,
              epsilon: t0.deltaChange,
              sLow: sLow,
              sHigh: sHigh
            };
          }
          const real = realTrades.find(t => t.result === 'PENDING' && !t.startTickIndex);
          if (real) {
            real.startTickIndex = sig.startTickIndex;
            real.startTime = sig.startTime;
            real.confirmMetrics = sig.confirmMetrics;
          }
        }
      }

      // 1. Buffer Result (Watch colors continually)
      const profitCard = flyout.querySelector('.dc-contract-card--profit, .dc-contract-card--green');
      const lossCard   = flyout.querySelector('.dc-contract-card--loss, .dc-contract-card--red');
      if (profitCard) lastSeenResult = 'WIN';
      else if (lossCard) lastSeenResult = 'LOSS';

      // 2. Buffer PnL
      const pnlSpan = flyout.querySelector('[data-testid="dt_span"]');
      if (pnlSpan) {
        const val = parseFloat(pnlSpan.innerText.replace(/[^-0-9.]/g, ''));
        if (!isNaN(val)) lastSeenPnL = val;
      }

      const noOpen = text.includes('no open positions');
      const flyoutCount = noOpen ? 0 : (text.match(/(\d+)\s+open\s+position/i) ? parseInt(text.match(/(\d+)\s+open\s+position/i)[1], 10) : realOpenCount);

      if (flyoutCount !== realOpenCount) {
        realOpenCount = flyoutCount;
        updateRealExecStateFromDOM(flyoutCount);
      }
  }
  function updateRealExecStateFromDOM(count) {
    if (count > 0 && ['IDLE', 'OPEN_PENDING'].includes(realExecState)) {
      realExecState = 'OPEN';
      lastSeenPnL = 0;
      const pending = signals.find(s => s.result === 'PENDING' && !s.entryPriceReal);
      if (pending && ticks.length) {
        pending.entryPriceReal = ticks[ticks.length - 1].price;
        updateSignalsUI();
      }
    }
    updateRealUI();
  }
  function finalizeRealTrade(res) {
    if (!realTrades.length) return;
    const last = realTrades[realTrades.length - 1];
    if (last.result !== 'PENDING') return;
    last.result = res.result || 'LOSS';
    last.pnl = res.pnl || 0;
    if (last.result === 'WIN') realWins++;
    else realLosses++;
    realPnl += last.pnl;
    const simTrade = last.signalRef || signals.find(s => s.result === 'PENDING' && s.isReal);
    if (simTrade) {
      simTrade.result = res.result;
      simTrade.priceAfter = ticks.length ? ticks[ticks.length - 1].price : simTrade.price;
    }
    lastTradeClosedAt = Date.now();
    lastTradeClosedTick = tickSeq;
    if (realExecTimer) { clearTimeout(realExecTimer); realExecTimer = null; }
    updateRealUI();
    updateSignalsUI();
  }
  async function executeRealTrade(side) {
    if (Date.now() - lastRealTradeAt < cfg.realCooldownMs) return;
    const buyLabel = side === 'BUY' ? 'Rise' : 'Fall', activeClass = side === 'BUY' ? CLASS_RISE_ACTIVE : CLASS_FALL_ACTIVE;
    try {
      if (!await setRealTradeSide(buyLabel, activeClass)) throw new Error('side_failed');
      if (!await waitRealBuyReady()) throw new Error('not_ready');
      const btn = document.querySelector(SEL_PURCHASE_BTN); if (!btn || !btn.classList.contains(activeClass)) throw new Error('btn_mismatch');
      simulateExternalClick(btn); lastRealTradeAt = Date.now();
      const signalToMark = signals.find(s => s.result === 'PENDING' && s.isReal);
      realTrades.push({ time: Date.now(), signal: side, side: buyLabel, result: 'PENDING', signalRef: signalToMark, startTickIndex: null, startTime: null });
      realExecTimer = setTimeout(() => { if (['OPEN_PENDING', 'OPEN'].includes(realExecState)) { realExecState = 'RECOVERY'; realLockReason = 'TIMEOUT'; updateRealUI(); } }, cfg.realTimeoutMs);
    } catch (e) { realLockReason = 'ERR:' + e.message; updateRealUI(); setTimeout(() => { if (realExecState === 'OPEN_PENDING') { realExecState = 'IDLE'; realLockReason = ''; updateRealUI(); } }, 3000); }
  }
  async function setRealTradeSide(label, activeClass) {
    for (let i = 0; i < 3; i++) {
      const btn = document.querySelector(SEL_PURCHASE_BTN);
      if (btn && btn.classList.contains(activeClass)) return true;
      const target = Array.from(document.querySelectorAll(SEL_SIDE_BTNS)).find(b => b.innerText.includes(label));
      if (target) {
        simulateExternalClick(target);
        await new Promise(r => setTimeout(r, 150)); // Faster response
      } else {
        await new Promise(r => setTimeout(r, 50));
      }
    }
    return false;
  }
  function simulateExternalClick(el) { const opts = { bubbles: true, cancelable: true, view: window }; el.dispatchEvent(new MouseEvent('mouseenter', opts)); el.dispatchEvent(new MouseEvent('mousedown', opts)); el.focus(); el.dispatchEvent(new MouseEvent('mouseup', opts)); el.dispatchEvent(new MouseEvent('click', opts)); el.dispatchEvent(new MouseEvent('mouseleave', opts)); }
  async function waitRealBuyReady() {
    for (let i = 0; i < 5; i++) {
      const btn = document.querySelector(SEL_PURCHASE_BTN);
      if (btn && btn.getAttribute('data-loading') !== 'true' && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') return true;
      await new Promise(r => setTimeout(r, 100)); // Shorter wait increments
    }
    return false;
  }
  function init() { if (document.getElementById('tt-overlay')) return; cfg = loadCfg(); buildOverlay(); connect(); startWatchdog(); setupFlyoutObserver(); window._tt_cfg = cfg; window._tt_detect = detectSignal; }
  if (document.body) init(); else document.addEventListener('DOMContentLoaded', init);
})();
