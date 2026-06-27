-- Makyton web app database schema. Runs automatically on server startup.

CREATE TABLE IF NOT EXISTS users (
  telegram_id BIGINT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  photo_url TEXT,
  wallet_address TEXT,
  balance INTEGER DEFAULT 0,

  -- fixed honor-system tasks (X has no verification available)
  x_follow_done BOOLEAN DEFAULT FALSE,
  x_like_done BOOLEAN DEFAULT FALSE,
  x_repost_done BOOLEAN DEFAULT FALSE,

  -- server-verified Telegram tasks (confirmed by the companion bot)
  joined_channel_task_done BOOLEAN DEFAULT FALSE,
  started_bot_task_done BOOLEAN DEFAULT FALSE,

  -- referrals
  referred_by BIGINT,
  referral_awarded BOOLEAN DEFAULT FALSE,
  referral_count INTEGER DEFAULT 0,

  -- daily bonus
  last_daily_bonus_at TIMESTAMP,

  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users (LOWER(username));
CREATE INDEX IF NOT EXISTS idx_users_balance ON users (balance DESC);

-- Admin-configured tasks: "visit website" (15s dwell) and "start bot" (honor system, links to OTHER bots)
CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('visit_website', 'bot_link')),
  title TEXT NOT NULL,
  link TEXT NOT NULL,
  reward INTEGER NOT NULL,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_completions (
  task_id INTEGER REFERENCES tasks(id),
  telegram_id BIGINT NOT NULL,
  completed_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (task_id, telegram_id)
);

-- Tracks when a user started a "visit website" task, to enforce the 15s dwell time server-side
CREATE TABLE IF NOT EXISTS visit_sessions (
  task_id INTEGER REFERENCES tasks(id),
  telegram_id BIGINT NOT NULL,
  started_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (task_id, telegram_id)
);

CREATE TABLE IF NOT EXISTS redeem_codes (
  code TEXT PRIMARY KEY,
  reward INTEGER NOT NULL,
  max_uses INTEGER,           -- NULL = unlimited
  use_count INTEGER DEFAULT 0,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS redeem_code_uses (
  code TEXT REFERENCES redeem_codes(code),
  telegram_id BIGINT NOT NULL,
  used_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (code, telegram_id)
);
