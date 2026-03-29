/* ====================================================
 * 3Tick Scalper – Step Index 100 Micro-Timing V2 Collector
 * Content script for dtrader.deriv.com
 * ==================================================== */
(function () {
  'use strict';

  // ── Constants & config ────────────────────────────────────────────────────
  const WS_URL          = 'wss://ws.derivws.com/websockets/v3?app_id=1089';
  const WS_URL_FALLBACK = 'wss://ws.deriv.com/websockets/v3?app_id=1089';
  const FALLBACK_AFTER  = 3;
  const TICK_BUF        = 1000;
  const RECONNECT_BASE  = 4000;
  const RECONNECT_MAX   = 64000;
  const TICK_LOG_MAX    = 100000; // Each T0 generates 3 rows

  // ── State ─────────────────────────────────────────────────────────────────
  let ticks       = [];  // { price, epoch, receivedAt, deltaSteps }
  let pendingV2   = [];  // { t0, futureTicks[] }
  let tickLog     = [];  // finalized micro-timing logs
  let tickLogging = false;

  let upStreak = 0;
  let downStreak = 0;

  let ws             = null;
  let wsState        = 'disconnected';
  let reconnectTimer = null;
  let resolvedSymbol = null;
  let manualClose    = false;
  let reconnectDelay = RECONNECT_BASE;
  let failCount      = 0;
  let usingFallback  = false;

  // ── Overlay build ─────────────────────────────────────────────────────────
  function buildOverlay () {
    if (document.getElementById('tt-overlay')) return;

    const el = document.createElement('div');
    el.id = 'tt-overlay';
    el.innerHTML = `
      <div id="tt-header">
        <span class="tt-title">3Tick Timing V2</span>
        <div class="tt-header-btns">
          <button id="tt-min-btn"   title="Minimise">_</button>
          <button id="tt-close-btn" title="Close">✕</button>
        </div>
      </div>
      <div id="tt-body">
        <div class="tt-row">
          <span class="tt-label">Status</span>
          <span class="tt-val" id="tt-status">
            <span class="tt-dot tt-dot-disconnected"></span>Disconnected
          </span>
        </div>
        <div class="tt-row">
          <span class="tt-label">Symbol</span>
          <span class="tt-val" id="tt-symbol">–</span>
        </div>
        <div class="tt-row">
          <span class="tt-label">Last Price</span>
          <span class="tt-val" id="tt-price">–</span>
        </div>
        <div class="tt-row">
          <span class="tt-label">Finalized Rows</span>
          <span class="tt-val" id="tt-log-count">0</span>
        </div>

        <button id="tt-log-toggle">▶ Start Collection</button>
        <button id="tt-log-export">⬇ Export CSV</button>
        <button id="tt-log-clear" style="background:#3d1a1a;color:#e04040;margin-top:2px;">Clear Log</button>
      </div>
    `;

    document.body.appendChild(el);

    const saved = safeStorage('get', 'tt-pos');
    if (saved) {
      el.style.right = 'auto';
      el.style.left  = saved.left + 'px';
      el.style.top   = saved.top  + 'px';
    }

    makeDraggable(el);
    bindButtons(el);
  }

  function makeDraggable (el) {
    const header = document.getElementById('tt-header');
    let ox = 0, oy = 0;
    header.addEventListener('mousedown', function (e) {
      if (e.target.tagName === 'BUTTON') return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      ox = e.clientX - rect.left;
      oy = e.clientY - rect.top;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
    function onMove (e) {
      const left = e.clientX - ox;
      const top  = e.clientY - oy;
      el.style.right = 'auto';
      el.style.left  = Math.max(0, Math.min(window.innerWidth  - el.offsetWidth,  left)) + 'px';
      el.style.top   = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, top))  + 'px';
    }
    function onUp () {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      safeStorage('set', 'tt-pos', { left: parseInt(el.style.left), top: parseInt(el.style.top) });
    }
  }

  function bindButtons (el) {
    document.getElementById('tt-min-btn').addEventListener('click', function () {
      el.classList.toggle('tt-minimized');
      this.textContent = el.classList.contains('tt-minimized') ? '□' : '_';
    });
    document.getElementById('tt-close-btn').addEventListener('click', function () {
      manualClose = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (ws) { ws.close(); ws = null; }
      el.remove();
    });
    const logToggleBtn = document.getElementById('tt-log-toggle');
    logToggleBtn.addEventListener('click', function () {
      tickLogging = !tickLogging;
      this.textContent = tickLogging ? '⏹ Stop Collection' : '▶ Start Collection';
      this.style.color = tickLogging ? '#e04040' : '#a0c8a0';
    });
    document.getElementById('tt-log-export').addEventListener('click', exportTickLog);
    document.getElementById('tt-log-clear').addEventListener('click', function() {
        if (confirm('Clear all logged data?')) {
            tickLog = [];
            pendingV2 = [];
            updateLogCount();
        }
    });
  }

  function updateLogCount() {
    const el = document.getElementById('tt-log-count');
    if (el) el.textContent = tickLog.length;
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────
  function resolveSymbol (symbols) {
    var candidates = ['stpRNG', 'STPRNG'];
    for (var i = 0; i < candidates.length; i++) {
      if (symbols.find(function (s) { return s.symbol === candidates[i]; })) {
        return candidates[i];
      }
    }
    var byName = symbols.find(function (s) {
      return /step\s*index\s*100/i.test(s.display_name) || /step\s*100/i.test(s.display_name);
    });
    return byName ? byName.symbol : (symbols.find(s => /step/i.test(s.display_name))?.symbol || null);
  }

  function connect () {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    var url = usingFallback ? WS_URL_FALLBACK : WS_URL;
    setWsState('connecting');
    ws = new WebSocket(url);
    ws.addEventListener('open', function () {
      setWsState('connected');
      reconnectDelay = RECONNECT_BASE;
      failCount = 0; usingFallback = false;
      ws.send(JSON.stringify({ active_symbols: 'brief', product_type: 'basic' }));
    });
    ws.addEventListener('message', function (e) {
      var msg; try { msg = JSON.parse(e.data); } catch (_) { return; }
      if (msg.error) return;
      if (msg.msg_type === 'active_symbols') {
        var sym = resolveSymbol(msg.active_symbols || []);
        if (sym) {
          resolvedSymbol = sym;
          const symEl = document.getElementById('tt-symbol');
          if (symEl) symEl.textContent = resolvedSymbol;
          ws.send(JSON.stringify({ ticks: resolvedSymbol, subscribe: 1 }));
        }
        return;
      }
      if (msg.msg_type === 'tick') { handleTick(msg.tick); }
    });
    ws.addEventListener('close', function (e) {
      setWsState('disconnected');
      resolvedSymbol = null;
      if (!manualClose) scheduleReconnect();
    });
    ws.addEventListener('error', function (e) {
      setWsState('disconnected');
      ws.close();
    });
  }

  function scheduleReconnect () {
    if (reconnectTimer) return;
    failCount++;
    if (failCount >= FALLBACK_AFTER) { usingFallback = !usingFallback; failCount = 0; }
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
  }

  function setWsState (state) {
    wsState = state;
    const el = document.getElementById('tt-status');
    if (!el) return;
    const dotClass = { connected: 'tt-dot-connected', connecting: 'tt-dot-connecting', disconnected: 'tt-dot-disconnected' };
    const label    = { connected: 'Connected', connecting: 'Connecting…', disconnected: 'Disconnected' };
    el.innerHTML = `<span class="tt-dot ${dotClass[state]}"></span>${label[state]}`;
  }

  // ── Tick handling ─────────────────────────────────────────────────────────
  function handleTick (tick) {
    if (!tick || tick.symbol !== resolvedSymbol) return;
    const price = parseFloat(tick.quote);
    const epoch = tick.epoch;
    const now   = Date.now();

    const prevTick = ticks.length ? ticks[ticks.length - 1] : null;
    const delta = prevTick ? price - prevTick.price : 0;
    const deltaSteps = delta / 0.1;
    const direction = delta > 0 ? 'UP' : (delta < 0 ? 'DOWN' : 'FLAT');
    const deltaTime = prevTick ? (now - prevTick.receivedAt) : 1000; // default 1s
    const speed = deltaTime > 0 ? deltaSteps / deltaTime : 0;
    const lastDigit = Math.floor(Math.round(price * 100) / 10) % 10;
    const deltaChange = prevTick ? deltaSteps - prevTick.deltaSteps : 0;

    if (delta > 0) { upStreak++; downStreak = 0; }
    else if (delta < 0) { downStreak++; upStreak = 0; }
    else { upStreak = 0; downStreak = 0; }

    const t0_state = {
        epoch, price, direction, deltaSteps, deltaTime, speed,
        upStreak, downStreak, lastDigit, deltaChange,
        receivedAt: now
    };

    ticks.push(t0_state);
    if (ticks.length > TICK_BUF) ticks.shift();

    const priceEl = document.getElementById('tt-price');
    if (priceEl) priceEl.textContent = price.toFixed(2);

    // ── Entry Offset Simulation (V2) ──
    pendingV2.forEach(log => {
        log.futureTicks.push(price);
        if (log.futureTicks.length === 6) {
            finalizeV2Log(log);
        }
    });
    pendingV2 = pendingV2.filter(log => log.futureTicks.length < 6);

    if (tickLogging) {
        pendingV2.push({
            t0: t0_state,
            futureTicks: []
        });
    }
  }

  function finalizeV2Log(log) {
    const t0 = log.t0;
    const ft = log.futureTicks; // ft[0]=T1, ft[1]=T2, ft[2]=T3, ft[3]=T4, ft[4]=T5, ft[5]=T6

    // offset = 1: entry=T1, t1=T2, t2=T3, t3=T4. outcome = T4 vs T1
    addFinalRow(t0, 1, ft[0], ft[1], ft[2], ft[3]);

    // offset = 2: entry=T2, t1=T3, t2=T4, t3=T5. outcome = T5 vs T2
    addFinalRow(t0, 2, ft[1], ft[2], ft[3], ft[4]);

    // offset = 3: entry=T3, t1=T4, t2=T5, t3=T6. outcome = T6 vs T3
    addFinalRow(t0, 3, ft[2], ft[3], ft[4], ft[5]);

    updateLogCount();
  }

  function addFinalRow(t0, offset, entry, t1, t2, t3) {
    tickLog.push({
        t0_epoch:      t0.epoch,
        t0_price:      t0.price,
        t0_direction:  t0.direction,
        t0_delta_steps: t0.deltaSteps.toFixed(1),
        t0_delta_time: t0.deltaTime,
        t0_speed:      t0.speed.toFixed(6),
        t0_up_streak:  t0.upStreak,
        t0_down_streak: t0.downStreak,
        t0_last_digit: t0.lastDigit,
        t0_delta_change: t0.deltaChange.toFixed(1),

        entry_offset:  offset,
        entry_price:   entry,
        t1:            t1,
        t2:            t2,
        t3:            t3,

        buy_win:       t3 >= entry ? 1 : 0,
        sell_win:      t3 <= entry ? 1 : 0
    });

    if (tickLog.length > TICK_LOG_MAX) tickLog.shift();
  }

  // ── CSV export ────────────────────────────────────────────────────────────
  function exportTickLog () {
    if (!tickLog.length) return;
    const headers = [
        't0_epoch', 't0_price', 't0_direction', 't0_delta_steps', 't0_delta_time',
        't0_speed', 't0_up_streak', 't0_down_streak', 't0_last_digit', 't0_delta_change',
        'entry_offset', 'entry_price', 't1', 't2', 't3', 'buy_win', 'sell_win'
    ];
    const rows = [headers].concat(tickLog.map(r => headers.map(h => r[h])));
    const csv  = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = '3tick-timing-v2-' + Date.now() + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  function safeStorage (op, key, value) {
    try {
      if (op === 'get') return JSON.parse(localStorage.getItem(key));
      if (op === 'set') localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {} return null;
  }

  function init () {
    if (document.getElementById('tt-overlay')) return;
    buildOverlay();
    connect();
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();
