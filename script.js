// ============================================================
//  CONFIGURATION – edit these values
// ============================================================
const CONFIG = {
  // ---- passcodes (add more codes here) ----
  validPasscodes: ['022005'],

  // ---- Telegram bot token (required) ----
  botToken: 'YOUR_BOT_TOKEN_HERE',   // ← replace with your bot token

  // ---- List of private user IDs (only numeric IDs) ----
  chatIds: [
    '123456789',   // User 1
    '987654321',   // User 2
    // add as many as you like
  ],

  // ---- API key for Twelve Data (free tier) ----
  twelveDataKey: '2fb822c09c1c42e19c07e94090f18b42',

  // ---- All available assets (users can select which ones to monitor) ----
  availableAssets: [
    { id: 'GBPUSD', label: 'GBPUSD', symbol: 'GBP/USD', source: 'twelve' },
    { id: 'XAUUSD', label: 'XAUUSD', symbol: 'XAU/USD', source: 'twelve' },
    { id: 'BTCUSD', label: 'BTCUSD', symbol: 'BTC/USD', source: 'twelve' },
    // Add more assets here if needed (e.g., EURUSD, etc.)
  ],

  // ---- Selectable timeframes (spot trading, not fixed binary expiry) ----
  timeframes: [
    { id: '1m',  label: '1m',  interval: '1min',  outputsize: 300 },
    { id: '5m',  label: '5m',  interval: '5min',  outputsize: 300 },
    { id: '15m', label: '15m', interval: '15min', outputsize: 300 },
    { id: '1h',  label: '1h',  interval: '1h',    outputsize: 300 },
    { id: '4h',  label: '4h',  interval: '4h',    outputsize: 300 },
  ],

  defaultTimeframe: '5m',

  // ---- how often (ms) the auto-trigger loop re-checks selected assets ----
  autoCheckIntervalMs: 60 * 1000,
};

// ============================================================
//  SMC STRATEGY  (Order Block + Fair Value Gap + Break of Structure)
// ============================================================
//
// Model:
//  1. BOS   – price closes beyond the most recent confirmed swing
//             high (bullish) or swing low (bearish).
//  2. OB    – the last opposite-colour candle before the impulsive
//             leg that produced the BOS.
//  3. FVG   – the 3-candle imbalance formed inside that impulsive
//             leg (candle[i-2] vs candle[i] gap).
//  4. Entry – price fully fills the FVG (trades back through the
//             whole gap), then closes back through the gap in the
//             direction of the trade ("bounce").
//  5. SL    – the far edge of the OB.
//  6. TP    – the swing point that was broken to create the BOS.
//
// evaluateModel() returns the current stage for a candle series so
// the UI can show live progress even before a signal fires.
// ============================================================
const SMC = {
  SWING_LOOKBACK: 2,

  findSwings(candles) {
    const swings = [];
    const n = candles.length;
    const lb = this.SWING_LOOKBACK;
    for (let i = lb; i < n - lb; i++) {
      const c = candles[i];
      let isHigh = true, isLow = true;
      for (let j = i - lb; j <= i + lb; j++) {
        if (j === i) continue;
        if (candles[j].high >= c.high) isHigh = false;
        if (candles[j].low <= c.low) isLow = false;
      }
      if (isHigh) swings.push({ index: i, price: c.high, type: 'high' });
      if (isLow) swings.push({ index: i, price: c.low, type: 'low' });
    }
    return swings;
  },

  // Most recent BOS (bullish or bearish), whichever break happened later.
  detectBOS(candles, swings) {
    const highs = swings.filter(s => s.type === 'high');
    const lows = swings.filter(s => s.type === 'low');

    let bestBull = null;
    let bestBear = null;

    for (const sh of highs) {
      for (let i = sh.index + 1; i < candles.length; i++) {
        if (candles[i].close > sh.price) {
          if (!bestBull || i > bestBull.breakIndex) {
            bestBull = { direction: 'bullish', swingIndex: sh.index, swingPrice: sh.price, breakIndex: i };
          }
          break;
        }
      }
    }

    for (const sl of lows) {
      for (let i = sl.index + 1; i < candles.length; i++) {
        if (candles[i].close < sl.price) {
          if (!bestBear || i > bestBear.breakIndex) {
            bestBear = { direction: 'bearish', swingIndex: sl.index, swingPrice: sl.price, breakIndex: i };
          }
          break;
        }
      }
    }

    if (!bestBull && !bestBear) return null;
    if (bestBull && !bestBear) return bestBull;
    if (bestBear && !bestBull) return bestBear;
    return bestBull.breakIndex >= bestBear.breakIndex ? bestBull : bestBear;
  },

  // Last opposite-colour candle before the impulsive break.
  findOB(candles, bos) {
    const isBullish = bos.direction === 'bullish';
    for (let i = bos.breakIndex - 1; i > bos.swingIndex; i--) {
      const c = candles[i];
      const isDown = c.close < c.open;
      const isUp = c.close > c.open;
      if (isBullish && isDown) return { index: i, candle: c };
      if (!isBullish && isUp) return { index: i, candle: c };
    }
    return null;
  },

  // 3-candle imbalance somewhere between the OB and the break candle.
  findFVG(candles, ob, bos) {
    const isBullish = bos.direction === 'bullish';
    const start = ob.index + 1;
    const end = bos.breakIndex;
    for (let i = start + 1; i <= end; i++) {
      const a = candles[i - 2];
      const c = candles[i];
      if (!a || !c) continue;
      if (isBullish && a.high < c.low) {
        return { formedIndex: i, top: c.low, bottom: a.high };
      }
      if (!isBullish && a.low > c.high) {
        return { formedIndex: i, top: a.low, bottom: c.high };
      }
    }
    return null;
  },

  // Scan candles after the FVG formed for a full fill, then a bounce.
  scanFill(candles, fvg, bos) {
    const isBullish = bos.direction === 'bullish';
    let touched = false;
    let touchIndex = null;
    let triggered = false;
    let entryIndex = null;

    for (let i = fvg.formedIndex + 1; i < candles.length; i++) {
      const c = candles[i];
      if (!touched) {
        if (isBullish && c.low <= fvg.bottom) { touched = true; touchIndex = i; }
        if (!isBullish && c.high >= fvg.top) { touched = true; touchIndex = i; }
        if (touched) continue; // bounce can't be on the same candle as the touch
      } else if (!triggered) {
        if (isBullish && c.close > fvg.bottom) { triggered = true; entryIndex = i; }
        if (!isBullish && c.close < fvg.top) { triggered = true; entryIndex = i; }
        if (triggered) break;
      }
    }

    return { touched, touchIndex, triggered, entryIndex };
  },

  fillPercent(latestCandle, fvg, bos) {
    const isBullish = bos.direction === 'bullish';
    const range = fvg.top - fvg.bottom;
    if (range <= 0) return 0;
    let pct;
    if (isBullish) {
      pct = ((fvg.top - latestCandle.close) / range) * 100;
    } else {
      pct = ((latestCandle.close - fvg.bottom) / range) * 100;
    }
    return Math.max(0, Math.min(100, pct));
  },

  evaluateModel(candles) {
    if (!candles || candles.length < this.SWING_LOOKBACK * 2 + 10) {
      return { stage: 'insufficient-data' };
    }

    const swings = this.findSwings(candles);
    const bos = this.detectBOS(candles, swings);
    if (!bos) return { stage: 'no-bos' };

    const ob = this.findOB(candles, bos);
    if (!ob) return { stage: 'bos-no-ob', direction: bos.direction };

    const fvg = this.findFVG(candles, ob, bos);
    if (!fvg) return { stage: 'bos-no-fvg', direction: bos.direction };

    const fill = this.scanFill(candles, fvg, bos);
    const latest = candles[candles.length - 1];
    const pct = fill.touched ? 100 : this.fillPercent(latest, fvg, bos);

    const isBullish = bos.direction === 'bullish';
    const sl = isBullish ? ob.candle.low : ob.candle.high;
    const tp = bos.swingPrice;

    if (fill.triggered) {
      return {
        stage: 'triggered',
        direction: bos.direction,
        entryPrice: candles[fill.entryIndex].close,
        entryIndex: fill.entryIndex,
        sl,
        tp,
        fillPercent: 100,
        fvg,
        ob,
        bos,
      };
    }

    if (fill.touched) {
      return {
        stage: 'filled-waiting-bounce',
        direction: bos.direction,
        sl,
        tp,
        fillPercent: 100,
        fvg,
        ob,
        bos,
      };
    }

    return {
      stage: 'waiting-fill',
      direction: bos.direction,
      sl,
      tp,
      fillPercent: pct,
      fvg,
      ob,
      bos,
    };
  },
};

// ============================================================
//  DATA FETCHING
// ============================================================
const DataFetcher = {
  async fetchTwelve(symbol, interval, outputsize) {
    const url =
      `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${interval}&outputsize=${outputsize}&apikey=${CONFIG.twelveDataKey}`;
    const resp = await fetch(url);
    const json = await resp.json();
    if (json.status === 'error' || !json.values) throw new Error(json.message || 'Twelve Data error');
    return json.values
      .map(v => ({
        time: v.datetime,
        open: parseFloat(v.open),
        high: parseFloat(v.high),
        low: parseFloat(v.low),
        close: parseFloat(v.close),
        volume: parseFloat(v.volume) || 0,
      }))
      .reverse(); // Twelve Data returns newest-first; strategy expects oldest-first
  },

  async fetchCandles(asset, timeframeId) {
    const tf = CONFIG.timeframes.find(t => t.id === timeframeId) || CONFIG.timeframes.find(t => t.id === CONFIG.defaultTimeframe);
    if (asset.source === 'twelve') {
      return await this.fetchTwelve(asset.symbol, tf.interval, tf.outputsize);
    }
    throw new Error(`Unknown source for ${asset.id}`);
  },
};

// ============================================================
//  TELEGRAM BOT (sends to multiple private users)
// ============================================================
const Bot = {
  async sendMessage(text, parseMode = 'Markdown') {
    if (!CONFIG.botToken || !CONFIG.chatIds || CONFIG.chatIds.length === 0) {
      console.warn('Bot not configured or no user IDs provided');
      return false;
    }

    let allSuccess = true;
    for (const userId of CONFIG.chatIds) {
      const url = `https://api.telegram.org/bot${CONFIG.botToken}/sendMessage`;
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: userId,
            text: text,
            parse_mode: parseMode,
            disable_web_page_preview: true,
          }),
        });
        const json = await resp.json();
        if (!json.ok) {
          console.error(`Failed to send to user ${userId}:`, json.description);
          allSuccess = false;
        } else {
          console.log(`✅ Signal sent to user ${userId}`);
        }
      } catch (e) {
        console.error(`Error sending to user ${userId}:`, e);
        allSuccess = false;
      }
    }
    return allSuccess;
  },

  formatSignal(assetLabel, timeframeLabel, result) {
    const isCall = result.direction === 'bullish';
    const emoji = isCall ? '🟢' : '🔴';
    const action = isCall ? 'BUY' : 'SELL';
    const arrow = isCall ? '📈' : '📉';
    const now = new Date();

    return `${emoji} *${action} SIGNAL* ${emoji}

${arrow} *Asset:* ${assetLabel} (${timeframeLabel})
🎯 *Entry:* ${result.entryPrice}
🟩 *TP:* ${result.tp}
🟥 *SL:* ${result.sl}

⏰ *WAT Time:* ${now.toLocaleTimeString('en-GB')}

_OB + FVG + BOS (SMC) · spot signal_`;
  },
};

// ============================================================
//  UI HELPERS
// ============================================================
const UI = {
  passcodeOverlay: document.getElementById('passcodeOverlay'),
  passcodeInputs: document.querySelectorAll('#passcodeInputGroup input'),
  passcodeError: document.getElementById('passcodeError'),

  statusLed: document.getElementById('statusLed'),
  statusText: document.getElementById('statusText'),
  assetGrid: document.getElementById('assetGrid'),
  analyzeBtn: document.getElementById('analyzeBtn'),
  resultsContainer: document.getElementById('resultsContainer'),
  timestampMsg: document.getElementById('timestampMsg'),

  selection: {}, // { assetId: { checked: bool, timeframe: '5m' } }

  updateStatus(state) {
    const map = {
      online: { cls: 'online', label: '🟢 ONLINE' },
      offline: { cls: 'offline', label: '⚫ OFFLINE' },
      checking: { cls: 'checking', label: '🟡 CHECKING...' },
    };
    const s = map[state] || map.offline;
    this.statusLed.className = `status-led ${s.cls}`;
    this.statusText.className = `status-text ${s.cls}`;
    this.statusText.textContent = s.label;
  },

  loadSelection() {
    const saved = localStorage.getItem('trendpulse_selection_v2');
    if (saved) {
      try { return JSON.parse(saved); } catch (e) { /* fall through */ }
    }
    const fresh = {};
    CONFIG.availableAssets.forEach(a => {
      fresh[a.id] = { checked: true, timeframe: CONFIG.defaultTimeframe };
    });
    return fresh;
  },

  saveSelection() {
    localStorage.setItem('trendpulse_selection_v2', JSON.stringify(this.selection));
  },

  renderAssets() {
    this.selection = this.loadSelection();
    const grid = this.assetGrid;
    grid.innerHTML = '';

    CONFIG.availableAssets.forEach(asset => {
      const sel = this.selection[asset.id] || { checked: true, timeframe: CONFIG.defaultTimeframe };
      this.selection[asset.id] = sel;

      const pill = document.createElement('div');
      pill.className = `asset-pill ${sel.checked ? 'active' : ''}`;
      pill.dataset.assetId = asset.id;

      const tfOptions = CONFIG.timeframes
        .map(tf => `<option value="${tf.id}" ${tf.id === sel.timeframe ? 'selected' : ''}>${tf.label}</option>`)
        .join('');

      pill.innerHTML = `
        <input type="checkbox" id="chk_${asset.id}" ${sel.checked ? 'checked' : ''}>
        <label for="chk_${asset.id}">
          <span class="signal-dot neutral" id="dot_${asset.id}"></span>
          ${asset.label}
        </label>
        <select class="tf-select" id="tf_${asset.id}">${tfOptions}</select>
      `;

      pill.querySelector('input').addEventListener('change', (e) => {
        this.selection[asset.id].checked = e.target.checked;
        pill.classList.toggle('active', e.target.checked);
        this.saveSelection();
      });

      pill.querySelector('select').addEventListener('change', (e) => {
        this.selection[asset.id].timeframe = e.target.value;
        this.saveSelection();
      });

      grid.appendChild(pill);
    });

    const toggleBtn = document.createElement('button');
    toggleBtn.textContent = '☑ Toggle All';
    toggleBtn.addEventListener('click', () => {
      const allChecked = CONFIG.availableAssets.every(a => this.selection[a.id].checked);
      CONFIG.availableAssets.forEach(a => (this.selection[a.id].checked = !allChecked));
      this.saveSelection();
      this.renderAssets();
    });
    grid.appendChild(toggleBtn);
  },

  getSelectedAssets() {
    return CONFIG.availableAssets
      .filter(a => this.selection[a.id] && this.selection[a.id].checked)
      .map(a => ({ asset: a, timeframe: this.selection[a.id].timeframe }));
  },

  updateAssetDot(assetId, direction) {
    const dot = document.getElementById(`dot_${assetId}`);
    if (!dot) return;
    dot.className = 'signal-dot';
    if (direction === 'bullish') dot.classList.add('bullish');
    else if (direction === 'bearish') dot.classList.add('bearish');
    else dot.classList.add('neutral');
  },

  stageLabel(stage) {
    const labels = {
      'insufficient-data': 'Not enough data yet',
      'no-bos': 'No structure break yet',
      'bos-no-ob': 'BOS found, no order block yet',
      'bos-no-fvg': 'BOS + OB found, no FVG yet',
      'waiting-fill': 'Waiting for FVG fill',
      'filled-waiting-bounce': 'FVG filled — waiting for bounce',
      'triggered': 'ENTRY TRIGGERED',
    };
    return labels[stage] || stage;
  },

  renderResultCard(asset, timeframeId, result) {
    const tfLabel = CONFIG.timeframes.find(t => t.id === timeframeId).label;
    let card = document.getElementById(`result_${asset.id}`);
    if (!card) {
      card = document.createElement('div');
      card.className = 'result-card';
      card.id = `result_${asset.id}`;
      this.resultsContainer.appendChild(card);
    }

    const dirClass = result.direction === 'bullish' ? 'bullish' : result.direction === 'bearish' ? 'bearish' : 'neutral';
    const dirLabel = result.direction === 'bullish' ? '🟢 BUY' : result.direction === 'bearish' ? '🔴 SELL' : '⚪ NO SETUP';
    const pct = result.fillPercent !== undefined ? Math.round(result.fillPercent) : 0;

    let body = `
      <div class="result-header">
        <span class="result-asset">${asset.label} · ${tfLabel}</span>
        <span class="result-dir ${dirClass}">${dirLabel}</span>
      </div>
      <div class="result-stage">${this.stageLabel(result.stage)}</div>
    `;

    if (result.stage === 'waiting-fill' || result.stage === 'filled-waiting-bounce' || result.stage === 'triggered') {
      body += `
        <div class="progress-track">
          <div class="progress-fill ${dirClass}" style="width:${pct}%"></div>
        </div>
        <div class="progress-label">${pct}% toward entry</div>
      `;
    }

    if (result.stage === 'triggered') {
      body += `
        <div class="tpsl-row">
          <div><span class="info-label">Entry</span><div class="info-value">${result.entryPrice}</div></div>
          <div><span class="info-label">TP</span><div class="info-value">${result.tp}</div></div>
          <div><span class="info-label">SL</span><div class="info-value">${result.sl}</div></div>
        </div>
      `;
    } else if (result.stage === 'waiting-fill' || result.stage === 'filled-waiting-bounce') {
      body += `
        <div class="tpsl-row">
          <div><span class="info-label">Planned TP</span><div class="info-value">${result.tp}</div></div>
          <div><span class="info-label">Planned SL</span><div class="info-value">${result.sl}</div></div>
        </div>
      `;
    }

    card.className = `result-card ${dirClass}`;
    card.innerHTML = body;
  },

  setTimestamp(msg) {
    this.timestampMsg.textContent = msg;
  },

  showError(msg) {
    console.warn(msg);
    this.timestampMsg.textContent = `⚠️ ${msg}`;
  },
};

// ============================================================
//  PASSCODE LOGIC  (unchanged)
// ============================================================
const Passcode = {
  inputs: UI.passcodeInputs,
  errorEl: UI.passcodeError,

  init() {
    this.inputs.forEach((inp, idx) => {
      inp.addEventListener('input', () => {
        if (inp.value.length === 1 && idx < this.inputs.length - 1) {
          this.inputs[idx + 1].focus();
        }
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && inp.value.length === 0 && idx > 0) {
          this.inputs[idx - 1].focus();
        }
        if (e.key === 'Enter') {
          this.submit();
        }
      });
      inp.addEventListener('keypress', (e) => {
        if (!/^\d$/.test(e.key)) e.preventDefault();
      });
    });

    document.getElementById('passcodeSubmitBtn').addEventListener('click', () => this.submit());
    this.inputs[0].focus();
  },

  getCode() {
    let code = '';
    this.inputs.forEach(inp => code += inp.value);
    return code;
  },

  submit() {
    const code = this.getCode();
    this.errorEl.textContent = '';
    if (code.length !== 6) {
      this.errorEl.textContent = 'Please enter all 6 digits';
      this.shake();
      return;
    }
    if (CONFIG.validPasscodes.includes(code)) {
      UI.passcodeOverlay.classList.add('hidden');
      UI.updateStatus('online');
      this.inputs.forEach(inp => inp.value = '');
      App.start();
    } else {
      this.errorEl.textContent = '❌ Invalid passcode. Try again.';
      this.shake();
      this.inputs.forEach(inp => inp.value = '');
      this.inputs[0].focus();
    }
  },

  shake() {
    const group = document.getElementById('passcodeInputGroup');
    group.querySelectorAll('input').forEach(inp => {
      inp.classList.add('error');
      setTimeout(() => inp.classList.remove('error'), 500);
    });
  },
};

// ============================================================
//  MAIN APP
// ============================================================
const App = {
  state: {
    isAnalyzing: false,
    autoTimer: null,
    // tracks the last entryIndex we already sent to Telegram, per asset,
    // so the auto-trigger loop doesn't spam the same signal repeatedly
    lastSentEntryIndex: {},
  },

  async start() {
    UI.renderAssets();

    const welcomeMsg = `🤖 *Trend Pulse Bot is ONLINE!*\n\n` +
                       `📊 Monitoring selected assets (spot signals)\n` +
                       `📐 Model: OB + FVG + BOS (SMC)\n` +
                       `✅ Signals will be sent here when a setup fully triggers.`;
    await Bot.sendMessage(welcomeMsg);

    await this.runAnalysis(true);
    this.startAutoCheck();

    document.getElementById('analyzeBtn').addEventListener('click', async () => {
      await this.runAnalysis(true);
    });
  },

  startAutoCheck() {
    if (this.state.autoTimer) clearInterval(this.state.autoTimer);
    this.state.autoTimer = setInterval(async () => {
      await this.runAnalysis(false);
    }, CONFIG.autoCheckIntervalMs);
  },

  async runAnalysis(manual) {
    if (this.state.isAnalyzing) return;
    this.state.isAnalyzing = true;
    const btn = UI.analyzeBtn;
    if (manual) {
      btn.disabled = true;
      btn.innerHTML = '⏳ Analysing…';
    }
    UI.updateStatus('checking');

    const selected = UI.getSelectedAssets();
    if (selected.length === 0) {
      UI.setTimestamp('⚠️ No assets selected – please check at least one asset');
      UI.updateStatus('offline');
      if (manual) {
        btn.disabled = false;
        btn.innerHTML = '🔍 Analyse Now';
      }
      this.state.isAnalyzing = false;
      return;
    }

    for (const { asset, timeframe } of selected) {
      try {
        const candles = await DataFetcher.fetchCandles(asset, timeframe);
        const result = SMC.evaluateModel(candles);
        UI.updateAssetDot(asset.id, result.direction);
        UI.renderResultCard(asset, timeframe, result);

        if (result.stage === 'triggered') {
          const alreadySent = this.state.lastSentEntryIndex[asset.id] === result.entryIndex;
          if (!alreadySent) {
            const tfLabel = CONFIG.timeframes.find(t => t.id === timeframe).label;
            await Bot.sendMessage(Bot.formatSignal(asset.label, tfLabel, result));
            this.state.lastSentEntryIndex[asset.id] = result.entryIndex;
          }
        }
      } catch (err) {
        console.error(`Error on ${asset.id}:`, err.message);
        UI.updateAssetDot(asset.id, null);
        UI.showError(`${asset.label}: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 600));
    }

    const ts = new Date().toLocaleTimeString();
    UI.setTimestamp(`🕒 Last scan: ${ts} · ${selected.length} asset(s) monitored`);
    UI.updateStatus('online');

    if (manual) {
      btn.disabled = false;
      btn.innerHTML = '🔍 Analyse Now';
    }
    this.state.isAnalyzing = false;
  },
};

// ============================================================
//  BOOT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  Passcode.init();
});
