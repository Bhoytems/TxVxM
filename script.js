// ============================================================
//  CONFIGURATION – edit these values
// ============================================================
const CONFIG = {
  // ---- passcodes (add more codes here) ----
  validPasscodes: ['022005'],

  // ---- Telegram bot token (required) ----
  botToken: '8616558500:AAE3Q_TMTCVrxYGk-d9pQSb2ZRwt8_ZLbrM',   // ← replace with your bot token

  // ---- Telegram bot username, no @ (used for the "Back to Chat" link) ----
  botUsername: 'https://t.me/Magnificoai_bot',

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
  // These also define which /ASSETEXPIRY chat commands exist, e.g. /GBPUSD1m
  expiryTimes: [
    { id: '1m',  label: '1m' },
    { id: '5m',  label: '5m' },
    { id: '15m', label: '15m' },
    { id: '30m', label: '30m' },
    { id: '1h',  label: '1h' },
  ],
  defaultExpiry: '5m',

  // ---- how many 5m candles to pull per request ----
  // Needs to be large enough that resampling into 1h/4h buckets still leaves
  // enough history for a stable 21-period EMA on those higher timeframes.
  // Twelve Data's free plan caps outputsize — check your plan if this gets
  // silently truncated.
  fetchOutputSize: 5000,

  // ---- how long a fetched candle set is reused before re-fetching ----
  // protects your API rate limit when commands/Analyse Now overlap
  cacheTtlMs: 30 * 1000,

  // ---- Telegram long-poll timeout (seconds) for the command listener ----
  commandPollTimeoutSec: 30,
};

// ============================================================
//  STRATEGY (multi-timeframe EMA trend + crossover)
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

  // Full status of an asset right now — used by both the Analyse Now button
  // and instant chat commands. `fresh` = a true crossover just happened
  // (1h+4h aligned, 15m confirms, 5m just crossed, RSI not extreme).
  // If not fresh, `direction` still reports the current 1h/4h bias so
  // commands always have something to say.
  getStatus(candlesByTf) {
    const tf1h = candlesByTf['1h'] || null;
    const tf4h = candlesByTf['4h'] || null;
    const tf15m = candlesByTf['15m'] || null;
    const tf5m = candlesByTf['5m'] || null;

    const bias1h = this.trendBias(tf1h);
    const bias4h = this.trendBias(tf4h);
    const bias15m = this.trendBias(tf15m);

    const alignedBias = (bias1h && bias1h === bias4h) ? bias1h : null;
    const confirmedBias = (alignedBias && bias15m === alignedBias) ? alignedBias : null;

    let fresh = false;
    if (confirmedBias && this.justCrossed(tf5m, confirmedBias)) {
      const closes = (tf5m || []).map(c => c.close);
      const rsiVal = this.rsi(closes, 14);
      const rsiBlocks = (confirmedBias === 'CALL' && rsiVal > 80) || (confirmedBias === 'PUT' && rsiVal < 20);
      fresh = !rsiBlocks;
    }

    const direction = confirmedBias || alignedBias || bias1h || bias4h || null;

    return { direction, fresh };
  },

  // Confidence % — fresh crossovers start from a higher base than a plain
  // "here's the current bias" read, since the latter is informational, not
  // an active trigger. Heuristic, not backtested — tune freely.
  confidence(candlesByTf, direction, fresh) {
    const tf5m = candlesByTf['5m'] || [];
    const closes = tf5m.map(c => c.close);
    const price = closes[closes.length - 1];
    const ema9 = this.ema(closes, 9);
    const ema21 = this.ema(closes, 21);
    const rsiVal = this.rsi(closes, 14);

    let score = fresh ? 60 : 40;

    if (ema9 !== null && ema21 !== null && price) {
      const gapPct = Math.abs(ema9 - ema21) / price * 100;
      score += Math.min(20, gapPct * 400);
    }

    if (direction === 'CALL') {
      score += Math.min(15, Math.max(0, rsiVal - 50) / 50 * 15);
    } else if (direction === 'PUT') {
      score += Math.min(15, Math.max(0, 50 - rsiVal) / 50 * 15);
    }

    const floor = fresh ? 60 : 35;
    const ceiling = fresh ? 95 : 75;
    return Math.round(Math.min(ceiling, Math.max(floor, score)));
  },
};

// ============================================================
//  DATA FETCHING
// ============================================================
const DataFetcher = {
  cache: {}, // { assetId: { data: {...timeframes}, fetchedAt: ms } }

  async fetchTwelve(symbol, interval, outputsize) {
    const url =
      `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${interval}&outputsize=${outputsize}&apikey=${CONFIG.twelveDataKey}`;
    const resp = await fetch(url);
    const json = await resp.json();
    if (json.status === 'error' || !json.values) throw new Error(json.message || 'Twelve Data error');
    // Twelve Data returns newest-first; the strategy expects oldest-first.
    return json.values
      .map(v => ({
        time: v.datetime,
        open: parseFloat(v.open),
        high: parseFloat(v.high),
        low: parseFloat(v.low),
        close: parseFloat(v.close),
        volume: parseFloat(v.volume) || 0,
      }))
      .reverse();
  },

  async fetchFiveMin(asset) {
    if (asset.source === 'twelve') {
      return await this.fetchTwelve(asset.symbol, '5min', CONFIG.fetchOutputSize);
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
    const cached = this.cache[asset.id];
    const now = Date.now();
    if (cached && (now - cached.fetchedAt) < CONFIG.cacheTtlMs) {
      return cached.data;
    }

    const raw5m = await this.fetchFiveMin(asset);
    if (!raw5m || raw5m.length < 25) throw new Error(`Not enough 5m data for ${asset.id}`);

    const tf5m = raw5m;
    const tf15m = this.resample(raw5m, 15);
    const tf1h = this.resample(raw5m, 60);
    const tf4h = this.resample(raw5m, 240);

    const data = { '5m': tf5m, '15m': tf15m, '1h': tf1h, '4h': tf4h };
    this.cache[asset.id] = { data, fetchedAt: now };
    return data;
  },
};

// ============================================================
//  TELEGRAM BOT
// ============================================================
const Bot = {
  async sendMessage(text, parseMode = 'Markdown') {
    if (!CONFIG.botToken || !CONFIG.chatIds || CONFIG.chatIds.length === 0) {
      console.warn('Bot not configured or no user IDs provided');
      return false;
    }
    let allSuccess = true;
    for (const userId of CONFIG.chatIds) {
      const ok = await this.sendMessageTo(userId, text, parseMode);
      if (!ok) allSuccess = false;
    }
    return allSuccess;
  },

  async sendMessageTo(chatId, text, parseMode = 'Markdown') {
    const url = `https://api.telegram.org/bot${CONFIG.botToken}/sendMessage`;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: parseMode,
          disable_web_page_preview: true,
        }),
      });
      const json = await resp.json();
      if (!json.ok) {
        console.error(`Failed to send to ${chatId}:`, json.description);
        return false;
      }
      return true;
    } catch (e) {
      console.error(`Error sending to ${chatId}:`, e);
      return false;
    }
  },

  formatSignal(assetLabel, status, confidence, price, expiryLabel) {
    const now = new Date().toLocaleTimeString('en-GB');

    if (!status.direction) {
      return `⚪ *${assetLabel}*\n\nNo clear directional bias right now — timeframes disagree.\n\n⏰ *WAT Time:* ${now}`;
    }

    const isCall = status.direction === 'CALL';
    const emoji = isCall ? '🟢' : '🔴';
    const arrow = isCall ? '📈' : '📉';
    const header = status.fresh
      ? `${emoji} *${isCall ? 'BUY' : 'SELL'} SIGNAL* ${emoji}`
      : `📊 *Current Bias: ${isCall ? 'CALL' : 'PUT'}* _(no fresh crossover yet)_`;

    return `${header}

${arrow} *Asset:* ${assetLabel}
💰 *Price:* ${price}
🎯 *Confidence:* ${confidence}%
⏱ *Expiry:* ${expiryLabel}

⏰ *WAT Time:* ${now}

_Multi-timeframe EMA strategy · Binary OTC_`;
  },
};

// ============================================================
//  CHAT COMMAND LISTENER  (/GBPUSD1m, /XAUUSD5m, etc.)
// ============================================================
const CommandBot = {
  offset: 0,
  running: false,
  commandMap: {},

  buildCommandMap() {
    const map = {};
    CONFIG.availableAssets.forEach(asset => {
      CONFIG.expiryTimes.forEach(exp => {
        const key = (asset.id + exp.label).toUpperCase();
        map[key] = { asset, expiry: exp };
      });
    });
    this.commandMap = map;
  },

  start() {
    if (this.running) return;
    this.buildCommandMap();
    this.running = true;
    this.poll();
  },

  stop() {
    this.running = false;
  },

  async poll() {
    while (this.running) {
      try {
        const url = `https://api.telegram.org/bot${CONFIG.botToken}/getUpdates?timeout=${CONFIG.commandPollTimeoutSec}&offset=${this.offset}`;
        const resp = await fetch(url);
        const json = await resp.json();
        if (json.ok && json.result && json.result.length) {
          for (const update of json.result) {
            this.offset = update.update_id + 1;
            await this.handleUpdate(update);
          }
        }
      } catch (e) {
        console.error('Command poll error:', e);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  },

  async handleUpdate(update) {
    const msg = update.message;
    if (!msg || !msg.text || !msg.text.startsWith('/')) return;

    const chatId = String(msg.chat.id);
    if (!CONFIG.chatIds.map(String).includes(chatId)) return; // registered chat IDs only

    const cmd = msg.text.slice(1).trim().toUpperCase();

    if (cmd === 'START' || cmd === 'HELP') {
      const list = Object.keys(this.commandMap).map(k => '/' + k).join('\n');
      await Bot.sendMessageTo(chatId, `📋 *Available commands:*\n\n${list}`);
      return;
    }

    const match = this.commandMap[cmd];
    if (!match) return;

    const { asset, expiry } = match;
    try {
      const candles = await DataFetcher.getAllTimeframes(asset);
      const status = Strategy.getStatus(candles);
      const confidence = status.direction ? Strategy.confidence(candles, status.direction, status.fresh) : null;
      const tf5m = candles['5m'];
      const price = tf5m[tf5m.length - 1].close;
      const text = Bot.formatSignal(asset.label, status, confidence, price, expiry.label);
      await Bot.sendMessageTo(chatId, text);
    } catch (err) {
      console.error(`Command error for ${cmd}:`, err.message);
      await Bot.sendMessageTo(chatId, `⚠️ Couldn't fetch data for ${asset.label} right now — try again shortly.`);
    }
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
  timestampMsg: document.getElementById('timestampMsg'),
  backToChatBtn: document.getElementById('backToChatBtn'),

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

  setupBackToChat() {
    if (this.backToChatBtn) {
      this.backToChatBtn.href = `https://t.me/${CONFIG.botUsername}`;
    }
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
    lastSentCandleTime: {}, // avoids re-sending the same crossover on repeated presses
  },

  async start() {
    UI.renderAssets();
    UI.setupBackToChat();
    CommandBot.start();

    const welcomeMsg = `🤖 *Trend Pulse Bot is ONLINE!*\n\n` +
                       `📊 Binary OTC signals · multi-timeframe EMA strategy\n` +
                       `⌨️ Send a command any time, e.g. /GBPUSD1m, /XAUUSD5m, /BTCUSD1h — instant reply, no button needed\n` +
                       `✅ Or press Analyse Now here to scan your selected assets`;
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
        const status = Strategy.getStatus(candles);

        // Analyse Now stays conservative: only pings Telegram on a true
        // fresh crossover, so scanning several assets doesn't spam
        // bias-only noise. Chat commands (above) always answer.
        if (status.fresh) {
          const tf5m = candles['5m'];
          const latestCandle = tf5m[tf5m.length - 1];
          const alreadySent = this.state.lastSentCandleTime[asset.id] === latestCandle.time;

          if (!alreadySent) {
            const price = latestCandle.close;
            const confidence = Strategy.confidence(candles, status.direction, true);
            const expiryLabel = CONFIG.expiryTimes.find(e => e.id === expiry).label;
            await Bot.sendMessage(Bot.formatSignal(asset.label, status, confidence, price, expiryLabel));
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
