// ============================================================
//  CONFIGURATION – edit these values
// ============================================================
const CONFIG = {
  // ---- passcodes (add more codes here) ----
  validPasscodes: ['022005'],

  // ---- Telegram bot (required) ----
  botToken: '8616558500:AAE3Q_TMTCVrxYGk-d9pQSb2ZRwt8_ZLbrM',   // ← replace with your bot token
  chatId: '-1003739885976',       // ← replace with your chat ID

  // ---- API key for Twelve Data ----
  twelveDataKey: '2fb822c09c1c42e19c07e94090f18b42',

  // ---- assets to monitor (only these 3) ----
  assets: [
    { id: 'GBPUSD', label: 'GBPUSD OTC', symbol: 'GBP/USD', source: 'twelve' },
    { id: 'XAUUSD', label: 'XAUUSD OTC', symbol: 'XAU/USD', source: 'twelve' },
    { id: 'BTCUSD', label: 'BTCUSD OTC', symbol: 'BTC/USD', source: 'twelve' },
  ],
};

// ============================================================
//  STRATEGY (ported from strategy.py)
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
    // previous values
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
  }
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

  // resample 5m → 15m, 1h, 4h
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
    // ignore incomplete bucket
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
  }
};

// ============================================================
//  TELEGRAM BOT
// ============================================================
const Bot = {

  async sendMessage(text, parseMode = 'Markdown') {
    if (!CONFIG.botToken || !CONFIG.chatId) {
      console.warn('Bot not configured');
      return false;
    }
    const url = `https://api.telegram.org/bot${CONFIG.botToken}/sendMessage`;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CONFIG.chatId,
          text: text,
          parse_mode: parseMode,
          disable_web_page_preview: true,
        }),
      });
      const json = await resp.json();
      return json.ok === true;
    } catch (e) {
      console.error('Bot send error:', e);
      return false;
    }
  },

  formatSignal(assetLabel, signal, price, change, confidence, rsi, emaInfo, expiryTime) {
    const isCall = signal === 'CALL';
    const emoji = isCall ? '🟢' : '🔴';
    const action = isCall ? 'BUY' : 'SELL';
    const arrow = isCall ? '📈' : '📉';
    const now = new Date();
    const expiryStr = expiryTime.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

    return `${emoji} *${action} SIGNAL* ${emoji}

${arrow} *Asset:* ${assetLabel}
💰 *Price:* ${price}
📊 *Change (5m):* ${change}%
🎯 *Confidence:* ${confidence}%
📈 *RSI:* ${rsi}
📉 *EMA:* ${emaInfo}

⏰ *WAT Time:* ${now.toLocaleTimeString('en-GB')}
⏱ *Expiry:* ${expiryStr} (5-minute trade)

_Multi-timeframe EMA strategy_`;
  }
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
  tradeTimer: document.getElementById('tradeTimer'),
  signalDisplay: document.getElementById('signalDisplay'),
  priceVal: document.getElementById('priceVal'),
  changeVal: document.getElementById('changeVal'),
  strengthVal: document.getElementById('strengthVal'),
  emaSpan: document.getElementById('emaSpan'),
  rsiSpan: document.getElementById('rsiSpan'),
  momSpan: document.getElementById('momSpan'),
  timestampMsg: document.getElementById('timestampMsg'),

  updateStatus(state) {
    const led = this.statusLed;
    const text = this.statusText;
    const map = {
      online: { cls: 'online', label: '🟢 ONLINE' },
      offline: { cls: 'offline', label: '⚫ OFFLINE' },
      checking: { cls: 'checking', label: '🟡 CHECKING...' },
    };
    const s = map[state] || map.offline;
    led.className = `status-led ${s.cls}`;
    text.className = `status-text ${s.cls}`;
    text.textContent = s.label;
  },

  renderAssets() {
    const grid = this.assetGrid;
    grid.innerHTML = '';
    CONFIG.assets.forEach(asset => {
      const pill = document.createElement('div');
      pill.className = 'asset-pill active';
      pill.dataset.assetId = asset.id;
      pill.innerHTML = `
        <span class="signal-dot neutral" id="dot_${asset.id}"></span>
        ${asset.label}
      `;
      grid.appendChild(pill);
    });
  },

  updateAssetSignal(assetId, signal) {
    const dot = document.getElementById(`dot_${assetId}`);
    if (!dot) return;
    dot.className = 'signal-dot';
    if (signal === 'CALL') dot.classList.add('bullish');
    else if (signal === 'PUT') dot.classList.add('bearish');
    else dot.classList.add('neutral');
  },

  setSignalDisplay(signal, confidence) {
    const el = this.signalDisplay;
    if (signal === 'CALL') {
      el.innerHTML =
        `<div class="signal-big bullish">🟢 CALL · BUY 🟢</div><div style="font-size:0.7rem;">Confidence ${Math.round(confidence)}%</div>`;
    } else if (signal === 'PUT') {
      el.innerHTML =
        `<div class="signal-big bearish">🔴 PUT · SELL 🔴</div><div style="font-size:0.7rem;">Confidence ${Math.round(confidence)}%</div>`;
    } else {
      el.innerHTML = `<div class="signal-big neutral">⚪ NEUTRAL · HOLD ⚪</div>`;
    }
  },

  updateTimerDisplay(secondsUntilNext) {
    const el = this.tradeTimer;
    if (secondsUntilNext === null || secondsUntilNext === undefined) {
      el.textContent = '--:--';
      el.style.color = '#26A5E4';
      return;
    }
    const mins = Math.floor(secondsUntilNext / 60);
    const secs = Math.floor(secondsUntilNext % 60);
    const display = `${mins}:${secs.toString().padStart(2, '0')}`;
    if (secondsUntilNext <= 10) {
      el.textContent = `⏰ ${display}`;
      el.style.color = '#ffaa00';
    } else {
      el.textContent = `📡 ${display}`;
      el.style.color = '#26A5E4';
    }
  },

  updateInfo(price, change, confidence, ema9, ema21, rsi, momentum) {
    this.priceVal.textContent = price || '—';
    this.changeVal.textContent = change !== undefined ? `${change}%` : '—';
    this.strengthVal.textContent = confidence !== undefined ? `${Math.round(confidence)}%` : '—';
    this.emaSpan.textContent = (ema9 && ema21) ? `${ema9}/${ema21}` : '—';
    this.rsiSpan.textContent = rsi !== undefined ? rsi.toFixed(1) : '—';
    this.momSpan.textContent = momentum !== undefined ? `${momentum.toFixed(2)}%` : '—';
  },

  setTimestamp(msg) {
    this.timestampMsg.textContent = msg;
  },

  showError(msg) {
    console.warn(msg);
    this.timestampMsg.textContent = `⚠️ ${msg}`;
  }
};

// ============================================================
//  PASSCODE LOGIC
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
  }
};

// ============================================================
//  MAIN APP
// ============================================================
const App = {
  state: {
    lastSignals: {},
    isAnalyzing: false,
    autoTimer: null,
    countdownTimer: null,
  },
  async start() {
  UI.renderAssets();
  
  // --- ADD THIS BLOCK ---
  // Send activation message to Telegram
  const activationMsg = `🤖 *Trend Pulse Bot is ONLINE!*\n\n` +
                        `📊 Monitoring: GBPUSD, XAUUSD, BTCUSD\n` +
                        `⏱ Checking every 5 minutes (WAT)\n` +
                        `✅ Signals will be sent here when detected.`;
  await Bot.sendMessage(activationMsg);
  // --- END OF ADDED BLOCK ---

  await this.runAnalysis();
  this.startAutoRefresh();
  this.startCountdown();
  // ...
  }

  async start() {
    UI.renderAssets();
    await this.runAnalysis();
    this.startAutoRefresh();
    this.startCountdown();
    document.getElementById('analyzeBtn').addEventListener('click', async () => {
      await this.runAnalysis(true);
    });
  },

  startCountdown() {
    if (this.state.countdownTimer) clearInterval(this.state.countdownTimer);
    this.state.countdownTimer = setInterval(() => {
      const now = this.getWAT();
      const minutes = now.getMinutes();
      const nextFive = Math.ceil((minutes + 0.1) / 5) * 5;
      const nextTime = new Date(now);
      nextTime.setMinutes(nextFive, 0, 0);
      const seconds = Math.max(0, (nextTime - now) / 1000);
      UI.updateTimerDisplay(seconds);
    }, 1000);
  },

  startAutoRefresh() {
    if (this.state.autoTimer) clearTimeout(this.state.autoTimer);
    const schedule = () => {
      const now = this.getWAT();
      const minutes = now.getMinutes();
      const nextFive = Math.ceil((minutes + 0.1) / 5) * 5;
      const nextTime = new Date(now);
      nextTime.setMinutes(nextFive, 0, 0);
      const delay = Math.max(0, nextTime - now);
      this.state.autoTimer = setTimeout(async () => {
        await this.runAnalysis();
        schedule();
      }, delay);
    };
    schedule();
  },

  getWAT() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Lagos' }));
  },

  async runAnalysis(manual = false) {
    if (this.state.isAnalyzing) return;
    this.state.isAnalyzing = true;
    const btn = document.getElementById('analyzeBtn');
    if (manual) {
      btn.disabled = true;
      btn.innerHTML = '⏳ Analyzing…';
    }
    UI.updateStatus('checking');

    let firstResult = null;

    for (const asset of CONFIG.assets) {
      try {
        const result = await this.analyzeAsset(asset);
        if (!firstResult) firstResult = result;
        UI.updateAssetSignal(asset.id, result.signal);
        await this.maybeSendSignal(asset, result);
      } catch (err) {
        console.error(`Error on ${asset.id}:`, err.message);
        UI.updateAssetSignal(asset.id, null);
        UI.showError(`${asset.label} fetch failed`);
      }
      await new Promise(r => setTimeout(r, 600));
    }

    if (firstResult) {
      const r = firstResult;
      UI.updateInfo(
        r.price,
        r.changePercent,
        r.confidence,
        r.ema9,
        r.ema21,
        r.rsi,
        r.momentum
      );
      UI.setSignalDisplay(r.signal, r.confidence);
    }

    const ts = new Date().toLocaleTimeString();
    UI.setTimestamp(`🕒 Last scan: ${ts} · ${CONFIG.assets.length} assets monitored`);
    UI.updateStatus('online');

    if (manual) {
      btn.disabled = false;
      btn.innerHTML = '🔍 Manual Analysis Now';
    }
    this.state.isAnalyzing = false;
  },

  async analyzeAsset(asset) {
    const candles = await DataFetcher.getAllTimeframes(asset);
    const signal = Strategy.generateSignal(candles);
    const tf5m = candles['5m'] || [];
    const last = tf5m.length > 0 ? tf5m[tf5m.length - 1] : null;
    const prev = tf5m.length > 1 ? tf5m[tf5m.length - 2] : null;
    const price = last ? last.close : 0;
    const changePercent = last && prev ? ((last.close - prev.close) / prev.close * 100) : 0;
    const closes = tf5m.map(c => c.close);
    const rsi = Strategy.rsi(closes, 14);
    const ema9 = Strategy.ema(closes, 9);
    const ema21 = Strategy.ema(closes, 21);
    const momentum = tf5m.length > 5 ? ((tf5m[tf5m.length - 1].close - tf5m[tf5m.length - 6].close) / tf5m[tf5m.length - 6].close * 100) : 0;

    let confidence = 55;
    if (signal === 'CALL') confidence = 78 + Math.min(16, Math.abs(ema9 - ema21) / 0.5);
    else if (signal === 'PUT') confidence = 78 + Math.min(16, Math.abs(ema9 - ema21) / 0.5);
    confidence = Math.min(94, Math.max(48, confidence));

    return {
      assetId: asset.id,
      label: asset.label,
      signal: signal || 'NEUTRAL',
      price: price,
      changePercent: changePercent,
      confidence: confidence,
      rsi: rsi,
      ema9: ema9 !== null ? ema9.toFixed(5) : '—',
      ema21: ema21 !== null ? ema21.toFixed(5) : '—',
      momentum: momentum,
      candles: candles,
    };
  },

  async maybeSendSignal(asset, result) {
    const key = asset.id;
    const lastSignal = this.state.lastSignals[key] || null;
    const newSignal = result.signal;

    if (newSignal !== 'NEUTRAL' && newSignal !== lastSignal) {
      this.state.lastSignals[key] = newSignal;

      const expiryTime = new Date();
      expiryTime.setMinutes(expiryTime.getMinutes() + 5);

      const priceStr = this.formatPrice(result.price, asset.id);
      const changeStr = result.changePercent.toFixed(4);
      const emaInfo = `${result.ema9}/${result.ema21}`;
      const rsiStr = result.rsi.toFixed(1);

      const msg = Bot.formatSignal(
        asset.label,
        newSignal,
        priceStr,
        changeStr,
        result.confidence,
        rsiStr,
        emaInfo,
        expiryTime
      );

      const sent = await Bot.sendMessage(msg);
      if (sent) {
        console.log(`📨 Signal sent: ${newSignal} on ${asset.id}`);
      } else {
        console.warn(`⚠️ Failed to send signal for ${asset.id}`);
      }
    } else if (newSignal === 'NEUTRAL') {
      this.state.lastSignals[key] = null;
    }
  },

  formatPrice(price, assetId) {
    if (!price) return '—';
    const isCrypto = assetId === 'BTCUSD';
    if (isCrypto) {
      if (price > 1000) return price.toFixed(2);
      if (price > 0.1) return price.toFixed(4);
      return price.toFixed(6);
    }
    return price.toFixed(5);
  }
};

// ============================================================
//  INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  // Check bot configuration
  if (!CONFIG.botToken || CONFIG.botToken === 'YOUR_BOT_TOKEN_HERE') {
    UI.updateStatus('offline');
    console.warn('⚠️ Bot not configured — set botToken and chatId in CONFIG');
  } else {
    UI.updateStatus('offline');
  }

  Passcode.init();
});
