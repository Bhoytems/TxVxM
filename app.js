// ============ CONFIG ============
const PASSCODE = "2005"; // change this to your real passcode

const ASSETS = {
  gbpusd_otc: { label: "GBPUSD OTC", symbol: "GBP/USD", command: "/gbpusd" },
  xauusd_otc: { label: "XAUUSD OTC", symbol: "XAU/USD", command: "/xauusd" },
  btc_otc:    { label: "Bitcoin OTC", symbol: "BTC/USD", command: "/btc" },
};
const ASSET_ORDER = ["gbpusd_otc", "xauusd_otc", "btc_otc"];
const EXPIRY_MINUTES = 1; // fixed — the reversal pattern only applies to 1-min candles/expiry

// ============ STATE ============
let config = loadConfig();
let engineRunning = false;
let pollTimer = null;
let commandPollActive = false;
let telegramUpdateOffset = 0;
let lastSignaledCandleTime = {}; // asset_key -> ISO time of the candle that last fired a signal
let assetEnabled = loadAssetToggles();
let activityLog = loadActivityLog();

// ============ UTIL ============
function getWAT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Lagos' }));
}
function watString() {
  return getWAT().toLocaleString('en-GB', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }) + ' WAT';
}
function watTimestamp() {
  const d = getWAT();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} WAT`;
}
function shortId() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function loadConfig() {
  try {
    return JSON.parse(localStorage.getItem('tp_config') || '{}');
  } catch { return {}; }
}
function saveConfigToStorage() {
  localStorage.setItem('tp_config', JSON.stringify(config));
}
function loadAssetToggles() {
  try {
    const saved = JSON.parse(localStorage.getItem('tp_asset_toggles') || '{}');
    const out = {};
    ASSET_ORDER.forEach(k => out[k] = saved[k] !== undefined ? saved[k] : true);
    return out;
  } catch {
    const out = {}; ASSET_ORDER.forEach(k => out[k] = true); return out;
  }
}
function saveAssetToggles() {
  localStorage.setItem('tp_asset_toggles', JSON.stringify(assetEnabled));
}
function loadActivityLog() {
  try { return JSON.parse(localStorage.getItem('tp_activity') || '[]'); } catch { return []; }
}
function saveActivityLog() {
  localStorage.setItem('tp_activity', JSON.stringify(activityLog.slice(0, 50)));
}

// ============ ACTIVITY FEED ============
function logActivity(type, text) {
  activityLog.unshift({ type, text, time: watString() });
  activityLog = activityLog.slice(0, 50);
  saveActivityLog();
  renderActivity();
}
function renderActivity() {
  const feed = document.getElementById('activityFeed');
  if (activityLog.length === 0) {
    feed.innerHTML = '<div class="feed-empty">No activity yet — press START or Analyse Now on an asset.</div>';
    return;
  }
  feed.innerHTML = activityLog.map(item => `
    <div class="feed-item ${item.type}">
      <span>${item.text}</span>
      <span class="feed-time">${item.time}</span>
    </div>
  `).join('');
}

// ============ PASSCODE GATE ============
function initGate() {
  const input = document.getElementById('passcodeInput');
  const btn = document.getElementById('gateBtn');
  const error = document.getElementById('gateError');

  function tryUnlock() {
    if (input.value === PASSCODE) {
      document.getElementById('gate').classList.add('hidden');
      document.getElementById('app').classList.remove('hidden');
      initApp();
    } else {
      error.textContent = 'Incorrect passcode';
      input.value = '';
    }
  }
  btn.addEventListener('click', tryUnlock);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock(); });
}

// ============ TWELVE DATA ============
async function fetchCandles(symbol, outputsize = 10) {
  const key = config.tdApiKey;
  if (!key) throw new Error('Twelve Data API key not set');
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1min&outputsize=${outputsize}&apikey=${key}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status === 'error' || !data.values) {
    throw new Error(data.message || 'Twelve Data request failed');
  }
  // Twelve Data returns newest-first — reverse to oldest-first
  return data.values.reverse().map(v => ({
    time: v.datetime,
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
  }));
}

// ============ STRATEGY: 1-min wick-rejection break pattern ============
// SELL: candle A bullish, candle B bearish with an upper wick, B closes below A's low (breaks A)
// BUY:  candle A bearish, candle B bullish with a lower wick, B closes above A's high (breaks A)
function detectPattern(candles) {
  if (!candles || candles.length < 2) return { signal: null };
  const A = candles[candles.length - 2];
  const B = candles[candles.length - 1];
  const range = (B.high - B.low) || 1e-9;
  const upperWick = B.high - Math.max(B.open, B.close);
  const lowerWick = Math.min(B.open, B.close) - B.low;

  const aBullish = A.close > A.open;
  const aBearish = A.close < A.open;
  const bBullish = B.close > B.open;
  const bBearish = B.close < B.open;

  if (aBullish && bBearish && upperWick > 0 && B.close < A.low) {
    const wickRatio = upperWick / range;
    const breakPct = ((A.low - B.close) / A.low) * 100;
    const confidence = clamp(Math.round(55 + wickRatio * 30 + breakPct * 1500), 50, 97);
    return { signal: 'SELL', confidence, candleTime: B.time, price: B.close };
  }
  if (aBearish && bBullish && lowerWick > 0 && B.close > A.high) {
    const wickRatio = lowerWick / range;
    const breakPct = ((B.close - A.high) / A.high) * 100;
    const confidence = clamp(Math.round(55 + wickRatio * 30 + breakPct * 1500), 50, 97);
    return { signal: 'BUY', confidence, candleTime: B.time, price: B.close };
  }
  return { signal: null, candleTime: B.time, price: B.close };
}

function trendBias(candles) {
  const recent = candles.slice(-6);
  let bull = 0, bear = 0;
  recent.forEach(c => { if (c.close > c.open) bull++; else if (c.close < c.open) bear++; });
  const total = bull + bear || 1;
  const bias = bull > bear ? 'BULLISH' : (bear > bull ? 'BEARISH' : 'NEUTRAL');
  const confidence = Math.round((Math.max(bull, bear) / total) * 100);
  return { bias, confidence };
}

// ============ TELEGRAM ============
async function tgSend(chatId, text) {
  const token = config.tgBotToken;
  if (!token) throw new Error('Telegram bot token not set');
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || 'Telegram send failed');
  return data.result;
}
async function tgBroadcast(text) {
  const channels = config.channels || [];
  for (const c of channels) {
    try { await tgSend(c.chat_id, text); }
    catch (e) { logActivity('error', `Telegram send failed (${c.label || c.chat_id}): ${e.message}`); }
  }
}

function formatSignalMessage(id, assetLabel, direction, confidence) {
  const arrow = direction === 'BUY' ? '🟢 BUY (CALL)' : '🔴 SELL (PUT)';
  return `<b>${arrow}</b>\nAsset: <b>${assetLabel}</b>\nExpiry: ${EXPIRY_MINUTES} min\nConfidence: ${confidence}%\nTime: ${watTimestamp()}\nSignal ID: <code>${id}</code>`;
}
function formatResultMessage(id, assetLabel, direction, result, entry, exit) {
  const emoji = { WIN: '✅', LOSS: '❌', TIE: '➖' }[result] || '';
  return `<b>Result ${emoji}</b>\nSignal ID: <code>${id}</code>\nAsset: ${assetLabel} (${direction})\nOutcome: <b>${result}</b>`;
}
function formatBiasMessage(assetLabel, bias, confidence) {
  const emoji = bias === 'BULLISH' ? '📈' : (bias === 'BEARISH' ? '📉' : '➖');
  return `${emoji} <b>${assetLabel}</b>\nTrend: <b>${bias}</b> (Confidence: ${confidence}%)\nNo fresh reversal signal right now — monitoring for entry.`;
}

// ============ ANALYSIS CORE ============
async function analyzeAsset(assetKey, { autoSend = false, replyChatId = null } = {}) {
  const asset = ASSETS[assetKey];
  const card = document.getElementById(`card-${assetKey}`);
  try {
    const candles = await fetchCandles(asset.symbol, 10);
    const pattern = detectPattern(candles);
    const bias = trendBias(candles);
    const price = candles[candles.length - 1].close;

    updateCardDisplay(assetKey, price, pattern, bias);

    if (pattern.signal) {
      // dedupe: don't refire on the same candle repeatedly
      if (lastSignaledCandleTime[assetKey] === pattern.candleTime && autoSend) {
        return;
      }
      lastSignaledCandleTime[assetKey] = pattern.candleTime;

      const id = shortId();
      const direction = pattern.signal;
      const text = formatSignalMessage(id, asset.label, direction, pattern.confidence);

      if (replyChatId) {
        await tgSend(replyChatId, text);
      } else {
        await tgBroadcast(text);
      }
      logActivity(direction === 'BUY' ? 'buy' : 'sell', `${asset.label}: ${direction} signal sent (${pattern.confidence}% confidence)`);

      // schedule a result check after the 1-min expiry
      const entryPrice = pattern.price;
      setTimeout(async () => {
        try {
          const freshCandles = await fetchCandles(asset.symbol, 3);
          const exitPrice = freshCandles[freshCandles.length - 1].close;
          let result;
          if (direction === 'BUY') result = exitPrice > entryPrice ? 'WIN' : (exitPrice < entryPrice ? 'LOSS' : 'TIE');
          else result = exitPrice < entryPrice ? 'WIN' : (exitPrice > entryPrice ? 'LOSS' : 'TIE');
          const resultText = formatResultMessage(id, asset.label, direction, result, entryPrice, exitPrice);
          if (replyChatId) await tgSend(replyChatId, resultText); else await tgBroadcast(resultText);
          logActivity('info', `${asset.label}: result for ${id} → ${result}`);
        } catch (e) {
          logActivity('error', `Result check failed for ${id}: ${e.message}`);
        }
      }, EXPIRY_MINUTES * 60 * 1000);

    } else if (replyChatId) {
      // command hit but no fresh signal — reply with current bias, never "no signal"
      await tgSend(replyChatId, formatBiasMessage(asset.label, bias.bias, bias.confidence));
    }
  } catch (e) {
    logActivity('error', `${asset.label}: ${e.message}`);
  }
}

function updateCardDisplay(assetKey, price, pattern, bias) {
  const priceEl = document.getElementById(`price-${assetKey}`);
  const badgeEl = document.getElementById(`badge-${assetKey}`);
  const confFillEl = document.getElementById(`conffill-${assetKey}`);
  const confLabelEl = document.getElementById(`conflabel-${assetKey}`);

  if (priceEl) priceEl.textContent = price;

  if (pattern.signal === 'BUY') {
    badgeEl.className = 'signal-badge buy';
    badgeEl.textContent = '🟢 BUY SIGNAL';
    confFillEl.style.width = pattern.confidence + '%';
    confLabelEl.textContent = pattern.confidence + '%';
  } else if (pattern.signal === 'SELL') {
    badgeEl.className = 'signal-badge sell';
    badgeEl.textContent = '🔴 SELL SIGNAL';
    confFillEl.style.width = pattern.confidence + '%';
    confLabelEl.textContent = pattern.confidence + '%';
  } else {
    badgeEl.className = 'signal-badge neutral';
    badgeEl.textContent = bias.bias === 'BULLISH' ? '📈 Leaning Bullish' : (bias.bias === 'BEARISH' ? '📉 Leaning Bearish' : '— Watching —');
    confFillEl.style.width = bias.confidence + '%';
    confLabelEl.textContent = bias.confidence + '%';
  }
}

// ============ ENGINE LOOP ============
async function runCycle() {
  for (const assetKey of ASSET_ORDER) {
    if (!assetEnabled[assetKey]) continue;
    await analyzeAsset(assetKey, { autoSend: true });
  }
}

function startEngine() {
  if (engineRunning) return;
  if (!config.tdApiKey) { logActivity('error', 'Set your Twelve Data API key in Configuration first.'); return; }
  if (!config.tgBotToken) { logActivity('error', 'Set your Telegram bot token in Configuration first.'); return; }
  engineRunning = true;
  updateStatusUI();
  logActivity('info', 'Engine started');
  runCycle();
  const intervalMs = Math.max(30, parseInt(document.getElementById('pollInterval').value || '65', 10)) * 1000;
  pollTimer = setInterval(runCycle, intervalMs);
  startCommandPolling();
}

function stopEngine() {
  engineRunning = false;
  updateStatusUI();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  commandPollActive = false;
  logActivity('info', 'Engine stopped');
}

function updateStatusUI() {
  const dot = document.getElementById('statusDot');
  const label = document.getElementById('statusLabel');
  const btn = document.getElementById('engineBtn');
  if (engineRunning) {
    dot.className = 'status-dot online';
    label.textContent = 'ONLINE';
    btn.textContent = 'STOP';
    btn.className = 'btn btn-stop';
  } else {
    dot.className = 'status-dot offline';
    label.textContent = 'OFFLINE';
    btn.textContent = 'START';
    btn.className = 'btn btn-start';
  }
}

// ============ TELEGRAM COMMAND LONG-POLLING ============
const COMMAND_MAP = { '/gbpusd': 'gbpusd_otc', '/xauusd': 'xauusd_otc', '/btc': 'btc_otc' };

async function startCommandPolling() {
  if (commandPollActive) return;
  commandPollActive = true;
  const token = config.tgBotToken;
  const allowedChatIds = new Set((config.channels || []).map(c => String(c.chat_id)));

  while (commandPollActive && engineRunning) {
    try {
      const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${telegramUpdateOffset}&timeout=25`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.ok) {
        for (const update of data.result) {
          telegramUpdateOffset = update.update_id + 1;
          const msg = update.message || update.channel_post;
          if (!msg || !msg.text) continue;
          const chatId = String(msg.chat.id);
          if (!allowedChatIds.has(chatId)) continue;

          const text = msg.text.trim().toLowerCase();
          const assetKey = COMMAND_MAP[text];
          if (assetKey) {
            logActivity('info', `Command ${text} from ${chatId}`);
            analyzeAsset(assetKey, { replyChatId: chatId });
          }
        }
      }
    } catch (e) {
      logActivity('error', `Command polling error: ${e.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ============ UI: ASSET CARDS ============
function renderAssetCards() {
  const grid = document.getElementById('assetGrid');
  grid.innerHTML = ASSET_ORDER.map(key => {
    const a = ASSETS[key];
    return `
      <div class="asset-card" id="card-${key}">
        <div class="asset-card-head">
          <span class="asset-name">${a.label}</span>
          <label class="asset-toggle">
            <input type="checkbox" id="toggle-${key}" ${assetEnabled[key] ? 'checked' : ''}>
            <span class="toggle-track"></span>
          </label>
        </div>
        <div class="asset-price" id="price-${key}">—</div>
        <div class="asset-meta"><span>${a.symbol}</span><span>1-min expiry</span></div>
        <div class="signal-badge neutral" id="badge-${key}">— WATCHING —</div>
        <div class="confidence-row">
          <div class="confidence-bar"><div class="confidence-fill" id="conffill-${key}" style="width:0%"></div></div>
          <span class="confidence-label" id="conflabel-${key}">—</span>
        </div>
        <div class="asset-actions">
          <button class="btn btn-small analyse-btn" data-asset="${key}">🔍 Analyse Now</button>
        </div>
      </div>
    `;
  }).join('');

  ASSET_ORDER.forEach(key => {
    document.getElementById(`toggle-${key}`).addEventListener('change', e => {
      assetEnabled[key] = e.target.checked;
      saveAssetToggles();
    });
  });
  document.querySelectorAll('.analyse-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      logActivity('info', `Manual analysis: ${ASSETS[btn.dataset.asset].label}`);
      analyzeAssetManual(btn.dataset.asset);
    });
  });
}

// manual run also sends signal to channels (not just displays)
async function analyzeAssetManual(assetKey) {
  const asset = ASSETS[assetKey];
  try {
    const candles = await fetchCandles(asset.symbol, 10);
    const pattern = detectPattern(candles);
    const bias = trendBias(candles);
    updateCardDisplay(assetKey, candles[candles.length - 1].close, pattern, bias);
    if (pattern.signal) {
      const id = shortId();
      const text = formatSignalMessage(id, asset.label, pattern.signal, pattern.confidence);
      await tgBroadcast(text);
      logActivity(pattern.signal === 'BUY' ? 'buy' : 'sell', `${asset.label}: ${pattern.signal} signal sent (manual)`);
    } else {
      await tgBroadcast(formatBiasMessage(asset.label, bias.bias, bias.confidence));
      logActivity('info', `${asset.label}: bias update sent (manual)`);
    }
  } catch (e) {
    logActivity('error', `${asset.label}: ${e.message}`);
  }
}

// ============ UI: CONFIG PANEL ============
function renderChannelList() {
  const list = document.getElementById('channelList');
  const channels = config.channels || [];
  if (channels.length === 0) {
    list.innerHTML = '<li style="color:#7a7d94;justify-content:center;">No channels added yet</li>';
    return;
  }
  list.innerHTML = channels.map((c, i) => `
    <li>
      <span>${c.label || 'Unlabeled'}</span>
      <span class="cid">${c.chat_id}</span>
      <button data-index="${i}" class="remove-channel">Remove</button>
    </li>
  `).join('');
  list.querySelectorAll('.remove-channel').forEach(btn => {
    btn.addEventListener('click', () => {
      config.channels.splice(parseInt(btn.dataset.index, 10), 1);
      saveConfigToStorage();
      renderChannelList();
    });
  });
}

function initConfigPanel() {
  document.getElementById('tdApiKey').value = config.tdApiKey || '';
  document.getElementById('tgBotToken').value = config.tgBotToken || '';
  document.getElementById('pollInterval').value = config.pollInterval || 65;
  config.channels = config.channels || [];
  renderChannelList();

  document.getElementById('configToggle').addEventListener('click', () => {
    document.getElementById('configBody').classList.toggle('collapsed');
    document.getElementById('configChevron').classList.toggle('open');
  });

  document.getElementById('addChannelBtn').addEventListener('click', () => {
    const idInput = document.getElementById('channelIdInput');
    const labelInput = document.getElementById('channelLabelInput');
    const chatId = idInput.value.trim();
    if (!chatId) return;
    config.channels.push({ chat_id: chatId, label: labelInput.value.trim() });
    saveConfigToStorage();
    renderChannelList();
    idInput.value = ''; labelInput.value = '';
  });

  document.getElementById('saveConfigBtn').addEventListener('click', () => {
    config.tdApiKey = document.getElementById('tdApiKey').value.trim();
    config.tgBotToken = document.getElementById('tgBotToken').value.trim();
    config.pollInterval = parseInt(document.getElementById('pollInterval').value || '65', 10);
    saveConfigToStorage();
    const status = document.getElementById('saveStatus');
    status.textContent = '✓ Saved';
    setTimeout(() => { status.textContent = ''; }, 2000);
  });

  document.getElementById('clearLogBtn').addEventListener('click', () => {
    activityLog = [];
    saveActivityLog();
    renderActivity();
  });
}

// ============ CLOCK ============
function tickClock() {
  document.getElementById('watClock').textContent = watString();
}

// ============ INIT ============
function initApp() {
  renderAssetCards();
  initConfigPanel();
  renderActivity();
  updateStatusUI();
  tickClock();
  setInterval(tickClock, 1000);

  document.getElementById('engineBtn').addEventListener('click', () => {
    if (engineRunning) stopEngine(); else startEngine();
  });
}

document.addEventListener('DOMContentLoaded', initGate);
