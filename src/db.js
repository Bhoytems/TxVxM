const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('[db] schema ready');
}

// ---------- users ----------

async function upsertUser({ telegramId, username, firstName, photoUrl }) {
  const result = await pool.query(
    `INSERT INTO users (telegram_id, username, first_name, photo_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (telegram_id)
     DO UPDATE SET username = EXCLUDED.username, first_name = EXCLUDED.first_name,
                   photo_url = COALESCE(EXCLUDED.photo_url, users.photo_url)
     RETURNING *`,
    [telegramId, username || null, firstName || null, photoUrl || null]
  );
  return result.rows[0];
}

async function getUser(telegramId) {
  const result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
  return result.rows[0] || null;
}

async function getUserByUsername(username) {
  const clean = username.replace(/^@/, '').toLowerCase();
  const result = await pool.query('SELECT * FROM users WHERE LOWER(username) = $1', [clean]);
  return result.rows[0] || null;
}

async function addBalance(telegramId, amount) {
  const result = await pool.query(
    'UPDATE users SET balance = GREATEST(balance + $2, 0) WHERE telegram_id = $1 RETURNING *',
    [telegramId, amount]
  );
  return result.rows[0];
}

async function setWallet(telegramId, wallet) {
  const result = await pool.query(
    'UPDATE users SET wallet_address = $2 WHERE telegram_id = $1 RETURNING *',
    [telegramId, wallet]
  );
  return result.rows[0];
}

async function setReferredBy(telegramId, referrerId) {
  await pool.query(
    `UPDATE users SET referred_by = $2
     WHERE telegram_id = $1 AND referred_by IS NULL AND $1 != $2`,
    [telegramId, referrerId]
  );
}

async function awardReferralIfDue(referredUserId) {
  const user = await getUser(referredUserId);
  if (!user || !user.referred_by || user.referral_awarded) return null;

  const referrer = await getUser(user.referred_by);
  if (!referrer) return null;

  await pool.query('UPDATE users SET referral_awarded = TRUE WHERE telegram_id = $1', [referredUserId]);
  await pool.query('UPDATE users SET referral_count = referral_count + 1 WHERE telegram_id = $1', [referrer.telegram_id]);
  return referrer;
}

async function markFixedTaskDone(telegramId, column) {
  const allowed = ['x_follow_done', 'x_like_done', 'x_repost_done', 'joined_channel_task_done', 'started_bot_task_done'];
  if (!allowed.includes(column)) throw new Error('Invalid task column');

  const result = await pool.query(
    `UPDATE users SET ${column} = TRUE WHERE telegram_id = $1 AND ${column} = FALSE RETURNING *`,
    [telegramId]
  );
  return result.rows[0] || null; // null = already done
}

async function getTopUsers(limit = 500) {
  const result = await pool.query(
    'SELECT telegram_id, username, first_name, photo_url, balance FROM users ORDER BY balance DESC, telegram_id ASC LIMIT $1',
    [limit]
  );
  return result.rows;
}

async function getUserRank(telegramId) {
  const result = await pool.query(
    `SELECT rank FROM (
       SELECT telegram_id, RANK() OVER (ORDER BY balance DESC) as rank FROM users
     ) ranked WHERE telegram_id = $1`,
    [telegramId]
  );
  return result.rows[0] ? result.rows[0].rank : null;
}

async function getAllUsers(searchQuery) {
  if (searchQuery) {
    const result = await pool.query(
      `SELECT * FROM users WHERE LOWER(username) LIKE $1 OR CAST(telegram_id AS TEXT) LIKE $1 ORDER BY balance DESC LIMIT 200`,
      [`%${searchQuery.toLowerCase()}%`]
    );
    return result.rows;
  }
  const result = await pool.query('SELECT * FROM users ORDER BY balance DESC LIMIT 200');
  return result.rows;
}

// ---------- daily bonus ----------

async function claimDailyBonus(telegramId, cooldownMs, rewardAmount) {
  const result = await pool.query(
    `UPDATE users
     SET balance = balance + $2,
         last_daily_bonus_at = NOW()
     WHERE telegram_id = $1
       AND (last_daily_bonus_at IS NULL OR NOW() - last_daily_bonus_at >= ($3 || ' milliseconds')::interval)
     RETURNING *`,
    [telegramId, rewardAmount, String(cooldownMs)]
  );
  return result.rows[0] || null; // null = still on cooldown
}

// ---------- admin-configured tasks ----------

async function createTask(type, title, link, reward) {
  const result = await pool.query(
    `INSERT INTO tasks (type, title, link, reward) VALUES ($1, $2, $3, $4) RETURNING *`,
    [type, title, link, reward]
  );
  return result.rows[0];
}

async function getTask(taskId) {
  const result = await pool.query('SELECT * FROM tasks WHERE id = $1', [taskId]);
  return result.rows[0] || null;
}

async function getActiveTasks() {
  const result = await pool.query('SELECT * FROM tasks WHERE active = TRUE ORDER BY id DESC');
  return result.rows;
}

async function getAllTasks() {
  const result = await pool.query('SELECT * FROM tasks ORDER BY id DESC');
  return result.rows;
}

async function deactivateTask(taskId) {
  const result = await pool.query('UPDATE tasks SET active = FALSE WHERE id = $1 RETURNING *', [taskId]);
  return result.rows[0] || null;
}

async function getCompletedTaskIds(telegramId) {
  const result = await pool.query('SELECT task_id FROM task_completions WHERE telegram_id = $1', [telegramId]);
  return result.rows.map((r) => r.task_id);
}

async function startVisitSession(taskId, telegramId) {
  await pool.query(
    `INSERT INTO visit_sessions (task_id, telegram_id) VALUES ($1, $2)
     ON CONFLICT (task_id, telegram_id) DO UPDATE SET started_at = NOW()`,
    [taskId, telegramId]
  );
}

async function getVisitSession(taskId, telegramId) {
  const result = await pool.query(
    'SELECT * FROM visit_sessions WHERE task_id = $1 AND telegram_id = $2',
    [taskId, telegramId]
  );
  return result.rows[0] || null;
}

async function claimTask(taskId, telegramId) {
  try {
    await pool.query('INSERT INTO task_completions (task_id, telegram_id) VALUES ($1, $2)', [taskId, telegramId]);
    return true;
  } catch (err) {
    if (err.code === '23505') return false; // already claimed
    throw err;
  }
}

// ---------- redeem codes ----------

async function createRedeemCode(code, reward, maxUses) {
  const result = await pool.query(
    `INSERT INTO redeem_codes (code, reward, max_uses) VALUES ($1, $2, $3) RETURNING *`,
    [code.toUpperCase(), reward, maxUses || null]
  );
  return result.rows[0];
}

async function getAllRedeemCodes() {
  const result = await pool.query('SELECT * FROM redeem_codes ORDER BY created_at DESC');
  return result.rows;
}

async function redeemCode(rawCode, telegramId) {
  const code = rawCode.trim().toUpperCase();
  const codeRow = await pool.query('SELECT * FROM redeem_codes WHERE code = $1 AND active = TRUE', [code]);
  if (codeRow.rows.length === 0) return { ok: false, reason: 'invalid' };

  const entry = codeRow.rows[0];
  if (entry.max_uses !== null && entry.use_count >= entry.max_uses) {
    return { ok: false, reason: 'exhausted' };
  }

  try {
    await pool.query('INSERT INTO redeem_code_uses (code, telegram_id) VALUES ($1, $2)', [code, telegramId]);
  } catch (err) {
    if (err.code === '23505') return { ok: false, reason: 'already_used' };
    throw err;
  }

  await pool.query('UPDATE redeem_codes SET use_count = use_count + 1 WHERE code = $1', [code]);
  const user = await addBalance(telegramId, entry.reward);
  return { ok: true, reward: entry.reward, user };
}

module.exports = {
  pool,
  initDb,
  upsertUser,
  getUser,
  getUserByUsername,
  addBalance,
  setWallet,
  setReferredBy,
  awardReferralIfDue,
  markFixedTaskDone,
  getTopUsers,
  getUserRank,
  getAllUsers,
  claimDailyBonus,
  createTask,
  getTask,
  getActiveTasks,
  getAllTasks,
  deactivateTask,
  getCompletedTaskIds,
  startVisitSession,
  getVisitSession,
  claimTask,
  createRedeemCode,
  getAllRedeemCodes,
  redeemCode,
};
