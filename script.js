// ============================================================
//  CONFIGURATION – edit these values
// ============================================================
const CONFIG = {
  // ---- passcodes (add more codes here) ----
  validPasscodes: ['022005'],

  // ---- Telegram bot token (required) ----
  botToken: '8616558500:AAE3Q_TMTCVrxYGk-d9pQSb2ZRwt8_ZLbrM',   // ← replace with your bot token

  // ---- List of private user IDs (only numeric IDs) ----
  chatIds: [
    '6274537011',   // User 1
    '987654321',   // User 2
    // add as many as you like
  ],

  // ---- API key for Twelve Data (free tier) ----
  twelveDataKey: '2fb822c09c1c42e19c07e94090f18b42',

  // ---- All available assets (users can select which ones to monitor) ----
  availableAssets: [
    { id: 'GBPUSD', label: 'GBPUSD OTC', symbol: 'GBP/USD', source: 'twelve' },
    { id: 'XAUUSD', label: 'XAUUSD OTC', symbol: 'XAU/USD', source: 'twelve' },
    { id: 'BTCUSD', label: 'BTCUSD OTC', symbol: 'BTC/USD', source: 'twelve' },
    // Add more assets here if needed (e.g., EURUSD, etc.)
  ],

  // ---- Selectable expiry time per asset (binary OTC trade duration) ----
  expiryTimes: [
    { id: '1m',  label: '1m',  ms: 60 * 1000 },
    { id: '5m',  label: '5m',  ms: 5 * 60 * 1000 },
    { id: '15m', label: '15m', ms: 15 * 60 * 1000 },
    { id: '1h',  label: '1h',  ms: 60 * 60 * 1000 },
    { id: '4h',  label: '4h',  ms: 4 * 60 * 60 * 1000 },
  ],
  defaultExpiry: '5m',
};

// ============================================================
//  STRATEGY (multi-timeframe EMA trend + crossover, as originally supplied)
// ============================================================
const Strategy = {
  ema(series, span) {
    if (!series || series.length < span) return null;
    const k = 2 / (span + 1);
    let emaVal = series[0];
    for (let i = 1; i < series.length; i++) {
      emaVal = series[i] * k + emaVal * (1 - k);
    }
    return emaVal;
  },

  rsi(series, period = 14) {
    if (!series || series.length < period + 1) return 50;
    const len = series.length;
    let gain = 0, loss = 0;
    for (let i = len - period - 1; i < len - 1; i++) {
      const diff = series[i + 1] - series[i];
      if (diff >= 0) gain += diff;
      else loss += Math.abs(diff);
    }
    if (loss === 0) return 100;
    const rs = gain / loss;
    return Math.min(100, Math.max(0, 100 - (100 / (1 + rs))));
  },

  trendBias(candles) {
    if (!candles || candles.length < 25) return null;
    const closes = candles.map(c => c.close);
    const ema9 = this.ema(closes, 9);
    const ema21 = this.ema(closes, 21);
    if (ema9 === null || ema21 === null) return null;
    if (ema9 > ema21) return 'CALL';
    if (ema9 < ema21) return 'PUT';
    return null;
  },

  justCrossed(candles, direction) {
    if (!candles || candles.length < 25) return false;
    const closes = candles.map(c => c.close);
    const ema9 = this.ema(closes, 9);
    const ema21 = this.ema(closes, 21);
    if (ema9 === null || ema21 === null) return false;
    const prevCloses = closes.slice(0, -1);
    const prevEma9 = this.ema(prevCloses, 9);
    const prevEma21 = this.ema(prevCloses, 21);
    if (prevEma9 === null || prevEma21 === null) return false;
    const prevDiff = prevEma9 - prevEma21;
    const currDiff = ema9 - ema21;
    if (direction === 'CALL') return prevDiff <= 0 && currDiff > 0;
    if (direction === 'PUT') return prevDiff >= 0 && currDiff < 0;
    return false;
  },

  generateSignal(candlesByTf) {
    const tf1h = candlesByTf['1h'] || null;
    const tf4h = candlesByTf['4h'] || null;
    const tf15m = candlesByTf['15m'] || null;
    const tf5m = candlesByTf['5m'] || null;

    const bias1h = this.trendBias(tf1h);
    const bias4h = this.trendBias(tf4h);
    if (bias1h === null || bias4h === null || bias1h !== bias4h) return null;

    const bias = bias1h;
    const bias15m = this.trendBias(tf15m);
    if (bias15m !== bias) return null;

    if (!this.justCrossed(tf5m, bias)) return null;

    if (!tf5m || tf5m.length < 20) return null;
    const closes = tf5m.map(c => c.close);
    const rsiVal = this.rsi(closes, 14);
    if (bias === 'CALL' && rsiVal > 80) return null;
    if (bias === 'PUT' && rsiVal < 20) return null;

    return bias;
  },

  // Confidence % — built from how far EMA9/EMA21 have separated (momentum)
  // and how far RSI sits in the signal's favour, on top of a base score for
  // having all timeframes aligned. Tune the weights below as you see fit.
  confidence(candlesByTf, direction) {
    const tf5m = candlesByTf['5m'] || [];
    const closes = tf5m.map(c => c.close);
    const price = closes[closes.length - 1];
    const ema9 = this.ema(closes, 9);
    const ema21 = this.ema(closes, 21);
    const rsiVal = this.rsi(closes, 14);

    let score = 60; // base: all timeframes already agreed to get this far

    if (ema9 !== null && ema21 !== null && price) {
      const gapPct = Math.abs(ema9 - ema21) / price * 100;
      score += Math.min(20, gapPct * 400);
    }

    if (direction === 'CALL') {
      score += Math.min(20, Math.max(0, rsiVal - 50) / 50 * 20);
    } else {
      score += Math.min(20, Math.max(0, 50 - rsiVal) / 50 * 20);
    }

    return Math.round(Math.min(95, Math.max(60, score)));
  },
};

// ============================================================
//  DATA FETCHING
// ============================================================
const DataFetcher = {
  async fetchTwelve(symbol, interval, limit = 500) {
    const url =
      `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${interval}&outputsize=${limit}&apikey=${CONFIG.twelveDataKey}`;
    const resp = await fetch(url);
    const json = await resp.json();
    if (json.status === 'error' || !json.values) throw new Error(json.message || 'Twelve Data error');
    return json.values.map(v => ({
      time: v.datetime,
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
      volume: parseFloat(v.volume) || 0,
    }));
  },

  async fetchFiveMin(asset) {
    if (asset.source === 'twelve') {
      return await this.fetchTwelve(asset.symbol, '5min', 500);
    }
    throw new Error(`Unknown source for ${asset.id}`);
  },

  resample(candles5m, targetMinutes) {
    if (!candles5m || candles5m.length === 0) return [];
    const bucketSize = targetMinutes / 5;
    const buckets = [];
    let current = [];
    for (const c of candles5m) {
      current.push(c);
      if (current.length >= bucketSize) {
        const open = current[0].open;
        const high = Math.max(...current.map(x => x.high));
        const low = Math.min(...current.map(x => x.low));
        const close = current[current.length - 1].close;
        const volume = current.reduce((s, x) => s + x.volume, 0);
        buckets.push({ open, high, low, close, volume });
        current = [];
      }
    }
    return buckets;
  },

  async getAllTimeframes(asset) {
    const raw5m = await this.fetchFiveMin(asset);
    if (!raw5m || raw5m.length < 25) throw new Error(`Not enough 5m data for ${asset.id}`);
    const data = raw5m.slice(-500);

    const tf5m = data;
    const tf15m = this.resample(data, 15);
    const tf1h = this.resample(data, 60);
    const tf4h = this.resample(data, 240);

    return {
      '5m': tf5m,
      '15m': tf15m,
      '1h': tf1h,
      '4h': tf4h,
    };
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

  formatSignal(assetLabel, direction, price, confidence, expiryLabel) {
    const isCall = direction === 'CALL';
    const emoji = isCall ? '🟢' : '🔴';
    const action = isCall ? 'BUY' : 'SELL';
    const arrow = isCall ? '📈' : '📉';
    const now = new Date();

    return `${emoji} *${action} SIGNAL* ${emoji}

${arrow} *Asset:* ${assetLabel}
💰 *Price:* ${price}
🎯 *Confidence:* ${confidence}%
⏱ *Expiry:* ${expiryLabel}

⏰ *WAT Time:* ${now.toLocaleTimeString('en-GB')}

_Multi-timeframe EMA strategy · Binary OTC_`;
  },
};

// ============================================================
//  UI HELPERS (selection only — no signal display in the webapp)
// ============================================================
const UI = {
  passcodeOverlay: document.getElementById('passcodeOverlay'),
  passcodeInputs: document.querySelectorAll('#passcodeInputGroup input'),
  passcodeError: document.getElementById('passcodeError'),

  statusLed: document.getElementById('statusLed'),
  statusText: document.getElementById('statusText'),
  assetGrid: document.getElementById('assetGrid'),
  analyzeBtn: document.getElementById('analyzeBtn'),
  timestampMsg: document.getElementById('timestampMsg'),

  selection: {}, // { assetId: { checked: bool, expiry: '5m' } }

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
    const saved = localStorage.getItem('trendpulse_selection_binary');
    if (saved) {
      try { return JSON.parse(saved); } catch (e) { /* fall through */ }
    }
    const fresh = {};
    CONFIG.availableAssets.forEach(a => {
      fresh[a.id] = { checked: true, expiry: CONFIG.defaultExpiry };
    });
    return fresh;
  },

  saveSelection() {
    localStorage.setItem('trendpulse_selection_binary', JSON.stringify(this.selection));
  },

  renderAssets() {
    this.selection = this.loadSelection();
    const grid = this.assetGrid;
    grid.innerHTML = '';

    CONFIG.availableAssets.forEach(asset => {
      const sel = this.selection[asset.id] || { checked: true, expiry: CONFIG.defaultExpiry };
      this.selection[asset.id] = sel;

      const pill = document.createElement('div');
      pill.className = `asset-pill ${sel.checked ? 'active' : ''}`;
      pill.dataset.assetId = asset.id;

      const expiryOptions = CONFIG.expiryTimes
        .map(e => `<option value="${e.id}" ${e.id === sel.expiry ? 'selected' : ''}>${e.label}</option>`)
        .join('');

      pill.innerHTML = `
        <input type="checkbox" id="chk_${asset.id}" ${sel.checked ? 'checked' : ''}>
        <label for="chk_${asset.id}">${asset.label}</label>
        <select class="tf-select" id="exp_${asset.id}">${expiryOptions}</select>
      `;

      pill.querySelector('input').addEventListener('change', (e) => {
        this.selection[asset.id].checked = e.target.checked;
        pill.classList.toggle('active', e.target.checked);
        this.saveSelection();
      });

      pill.querySelector('select').addEventListener('change', (e) => {
        this.selection[asset.id].expiry = e.target.value;
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
      .map(a => ({ asset: a, expiry: this.selection[a.id].expiry }));
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
    // avoids re-sending the same crossover signal on repeated presses
    // before the underlying 5m candle has actually moved on
    lastSentCandleTime: {}, // { assetId: '2026-07-20 10:05:00' }
  },

  async start() {
    UI.renderAssets();

    const welcomeMsg = `🤖 *Magnifico AI Bot is ONLINE!*\n\n` +
                       `📊 Binary OTC signals · multi-timeframe EMA strategy\n` +
                       `✅ Press Analyse Now to scan your selected assets.`;
    await Bot.sendMessage(welcomeMsg);

    document.getElementById('analyzeBtn').addEventListener('click', async () => {
      await this.runAnalysis();
    });
  },

  async runAnalysis() {
    if (this.state.isAnalyzing) return;
    this.state.isAnalyzing = true;
    const btn = UI.analyzeBtn;
    btn.disabled = true;
    btn.innerHTML = '⏳ Analysing…';
    UI.updateStatus('checking');

    const selected = UI.getSelectedAssets();
    if (selected.length === 0) {
      UI.setTimestamp('⚠️ No assets selected – please check at least one asset');
      UI.updateStatus('offline');
      btn.disabled = false;
      btn.innerHTML = '🔍 Analyse Now';
      this.state.isAnalyzing = false;
      return;
    }

    let signalsSent = 0;

    for (const { asset, expiry } of selected) {
      try {
        const candles = await DataFetcher.getAllTimeframes(asset);
        const direction = Strategy.generateSignal(candles);

        if (direction) {
          const tf5m = candles['5m'];
          const latestCandle = tf5m[tf5m.length - 1];
          const alreadySent = this.state.lastSentCandleTime[asset.id] === latestCandle.time;

          if (!alreadySent) {
            const price = latestCandle.close;
            const confidence = Strategy.confidence(candles, direction);
            const expiryLabel = CONFIG.expiryTimes.find(e => e.id === expiry).label;
            await Bot.sendMessage(Bot.formatSignal(asset.label, direction, price, confidence, expiryLabel));
            this.state.lastSentCandleTime[asset.id] = latestCandle.time;
            signalsSent++;
          }
        }
      } catch (err) {
        console.error(`Error on ${asset.id}:`, err.message);
        UI.showError(`${asset.label}: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 600));
    }

    const ts = new Date().toLocaleTimeString();
    UI.setTimestamp(`🕒 Last scan: ${ts} · ${selected.length} asset(s) checked · ${signalsSent} signal(s) sent`);
    UI.updateStatus('online');

    btn.disabled = false;
    btn.innerHTML = '🔍 Analyse Now';
    this.state.isAnalyzing = false;
  },
};

// ============================================================
//  BOOT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  Passcode.init();
});
