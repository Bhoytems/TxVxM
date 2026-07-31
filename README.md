# Trend Pulse — Browser Signal Bot

Runs entirely in your browser — no backend, no hosting needed. Open
`index.html`, keep the tab open while it runs, and it monitors GBPUSD OTC,
XAUUSD OTC, and Bitcoin OTC for a 1-minute reversal pattern, sending signals
to your Telegram channel(s).

## ⚠️ Must stay open

Since everything runs in the browser tab (fetching prices, checking the
pattern, polling Telegram for commands), closing or navigating away from the
tab stops the engine. There's no warning banner for this per your last
request — just keep it in mind.

## Strategy (1-minute candles, 1-minute expiry — the only timeframe this applies to)

- **SELL**: the previous candle is bullish (green); the current candle is
  bearish (red), has an upper wick, and still closes below the previous
  candle's low (breaks it)
- **BUY**: mirror — previous candle bearish (red); current candle bullish
  (green), has a lower wick, and closes above the previous candle's high

No multi-timeframe trend filter — this pattern is the entire strategy now.
Confidence % is a simple heuristic combining wick size and how far price
broke past the prior candle — not a statistically validated figure.

When a Telegram command hits but no fresh pattern just fired, the bot
replies with the current trend bias + confidence instead of "no signal."

## Setup

### 1. Twelve Data API key
Sign up free at [twelvedata.com](https://twelvedata.com) → copy your API
key. Free tier is roughly 8 requests/min and 800/day — the default 65-second
poll interval (single batched-ish cycle across 3 assets = 3 requests) uses
that up fairly fast if left running for many hours. Increase the poll
interval in Configuration, or upgrade your Twelve Data plan, if you plan to
run this for long stretches.

### 2. Telegram bot
Message **@BotFather** → `/newbot` → copy the token. Add the bot as admin to
your channel(s). Get each channel's chat ID by forwarding a channel message
to **@userinfobot**, or via `getUpdates` on the Bot API.

### 3. Open the app
Open `index.html` in a browser (double-click, or serve it — either works,
no build step). Enter the passcode (`2005` by default — change the
`PASSCODE` constant at the top of `app.js` to your own).

In **Configuration**:
- Paste your Twelve Data API key and Telegram bot token
- Add your channel(s) (chat ID + optional label)
- Save

Press **START**. Each enabled asset card shows live price, current
signal/bias, and confidence. Use **Analyse Now** on any card to force an
immediate check (also sends to your channels).

## Telegram commands

Send these (lowercase) from a chat/channel you've added in Configuration —
the bot only responds to configured chat IDs:

- `/gbpusd`
- `/xauusd`
- `/btc`

Each replies instantly with either a fresh signal or the current bias —
this only works while the tab is open and the engine is running, since
command polling is also happening in-browser.

## Where things are stored

Everything (API key, bot token, channels, asset toggles, activity log) is
saved in your browser's `localStorage` — nothing leaves your device except
the actual API calls to Twelve Data and Telegram. Clearing browser data or
switching browsers/devices resets the configuration.

## Message formats

**Signal:**
```
🟢 BUY (CALL)
Asset: GBPUSD OTC
Expiry: 1 min
Confidence: 82%
Time: 2026-07-31 10:42 WAT
Signal ID: A1B2C3D4
```

**Result** (sent automatically ~1 min after the signal):
```
Result ✅
Signal ID: A1B2C3D4
Asset: GBPUSD OTC (BUY)
Entry: 1.35862
Exit: 1.35901
Outcome: WIN
```

**Bias reply** (when a command hits but no fresh signal just fired):
```
📈 GBPUSD OTC
Trend: BULLISH (Confidence: 63%)
No fresh reversal signal right now — monitoring for entry.
```

## Project layout

```
index.html   Structure — passcode gate, dashboard, config panel
style.css    Dark theme, gradient accents, cards
app.js       Everything: strategy, Twelve Data fetch, Telegram send +
             command long-polling, all state in localStorage
```
