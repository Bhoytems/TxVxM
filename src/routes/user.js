const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireUser } = require('../auth');

const DAILY_BONUS_REWARD = parseInt(process.env.DAILY_BONUS_REWARD || '5', 10);
const DAILY_BONUS_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const VISIT_DWELL_MS = 15 * 1000;

const X_FOLLOW_REWARD = parseInt(process.env.X_FOLLOW_REWARD || '20', 10);
const X_LIKE_REWARD = parseInt(process.env.X_LIKE_REWARD || '10', 10);
const X_REPOST_REWARD = parseInt(process.env.X_REPOST_REWARD || '10', 10);
const JOIN_CHANNEL_REWARD = parseInt(process.env.JOIN_CHANNEL_REWARD || '20', 10);
const START_BOT_REWARD = parseInt(process.env.START_BOT_REWARD || '15', 10);

router.use(requireUser);

// ---------- profile ----------

router.get('/me', async (req, res) => {
  const user = await db.getUser(req.telegramId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const rank = await db.getUserRank(req.telegramId);
  res.json({ ...user, rank });
});

// ---------- wallet ----------

router.post('/wallet', async (req, res) => {
  const { wallet } = req.body;
  if (!/^0x[a-fA-F0-9]{40}$/.test((wallet || '').trim())) {
    return res.status(400).json({ error: 'Invalid MATIC wallet address' });
  }
  const user = await db.setWallet(req.telegramId, wallet.trim());

  // Referral pays out once the referred user has a wallet on file
  const referrer = await db.awardReferralIfDue(req.telegramId);
  if (referrer) {
    await db.addBalance(referrer.telegram_id, parseInt(process.env.REFERRAL_REWARD || '12', 10));
  }

  res.json(user);
});

// ---------- referral ----------

router.get('/referral', (req, res) => {
  const link = `https://t.me/${process.env.BOT_USERNAME}?start=ref_${req.telegramId}`;
  res.json({ link });
});

// ---------- daily bonus ----------

router.post('/daily-bonus/claim', async (req, res) => {
  const user = await db.claimDailyBonus(req.telegramId, DAILY_BONUS_COOLDOWN_MS, DAILY_BONUS_REWARD);
  if (!user) return res.status(429).json({ error: 'Daily bonus is still on cooldown' });
  res.json({ ok: true, balance: user.balance, lastClaimedAt: user.last_daily_bonus_at });
});

// ---------- tasks ----------

router.get('/tasks', async (req, res) => {
  const user = await db.getUser(req.telegramId);
  const dynamicTasks = await db.getActiveTasks();
  const completedIds = await db.getCompletedTaskIds(req.telegramId);

  const fixed = [
    { key: 'x_follow', title: 'Follow Makyton on X', link: process.env.X_FOLLOW_LINK, reward: X_FOLLOW_REWARD, done: user.x_follow_done, kind: 'fixed_honor' },
    { key: 'x_like', title: 'Like our pinned post', link: process.env.X_POST_LINK, reward: X_LIKE_REWARD, done: user.x_like_done, kind: 'fixed_honor' },
    { key: 'x_repost', title: 'Repost our pinned post', link: process.env.X_POST_LINK, reward: X_REPOST_REWARD, done: user.x_repost_done, kind: 'fixed_honor' },
    { key: 'join_channel', title: 'Join our Telegram channel/group', link: null, reward: JOIN_CHANNEL_REWARD, done: user.joined_channel_task_done, kind: 'bot_verified' },
    { key: 'start_bot', title: 'Start the Telegram bot', link: `https://t.me/${process.env.BOT_USERNAME}`, reward: START_BOT_REWARD, done: user.started_bot_task_done, kind: 'bot_verified' },
  ];

  const dynamic = dynamicTasks.map((t) => ({
    id: t.id,
    type: t.type,
    title: t.title,
    link: t.link,
    reward: t.reward,
    done: completedIds.includes(t.id),
    kind: t.type, // 'visit_website' | 'bot_link'
  }));

  res.json({ fixed, dynamic });
});

// Honor-system claim for the 3 X tasks (no verification possible)
router.post('/tasks/fixed/:key/claim', async (req, res) => {
  const map = {
    x_follow: { column: 'x_follow_done', reward: X_FOLLOW_REWARD },
    x_like: { column: 'x_like_done', reward: X_LIKE_REWARD },
    x_repost: { column: 'x_repost_done', reward: X_REPOST_REWARD },
  };
  const entry = map[req.params.key];
  if (!entry) return res.status(400).json({ error: 'Unknown task' });

  const updated = await db.markFixedTaskDone(req.telegramId, entry.column);
  if (!updated) return res.status(409).json({ error: 'Already claimed' });

  const user = await db.addBalance(req.telegramId, entry.reward);
  res.json({ ok: true, balance: user.balance });
});

// Visit-website task: start the 15s dwell timer
router.post('/tasks/visit/:taskId/start', async (req, res) => {
  const taskId = parseInt(req.params.taskId, 10);
  const task = await db.getTask(taskId);
  if (!task || task.type !== 'visit_website' || !task.active) {
    return res.status(404).json({ error: 'Task not found' });
  }
  await db.startVisitSession(taskId, req.telegramId);
  res.json({ ok: true, startedAt: Date.now() });
});

// Visit-website task: claim, only valid once 15s have genuinely elapsed since /start
router.post('/tasks/visit/:taskId/claim', async (req, res) => {
  const taskId = parseInt(req.params.taskId, 10);
  const task = await db.getTask(taskId);
  if (!task || task.type !== 'visit_website' || !task.active) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const session = await db.getVisitSession(taskId, req.telegramId);
  if (!session) {
    return res.status(400).json({ error: 'not_started' });
  }
  const elapsed = Date.now() - new Date(session.started_at).getTime();
  if (elapsed < VISIT_DWELL_MS) {
    return res.status(400).json({ error: 'too_soon', message: "you didn't complete the task" });
  }

  const isNewClaim = await db.claimTask(taskId, req.telegramId);
  if (!isNewClaim) return res.status(409).json({ error: 'already_claimed' });

  const user = await db.addBalance(req.telegramId, task.reward);
  res.json({ ok: true, balance: user.balance });
});

// "Start bot" task type tasks (links to OTHER bots) — honor system, instant claim
router.post('/tasks/bot-link/:taskId/claim', async (req, res) => {
  const taskId = parseInt(req.params.taskId, 10);
  const task = await db.getTask(taskId);
  if (!task || task.type !== 'bot_link' || !task.active) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const isNewClaim = await db.claimTask(taskId, req.telegramId);
  if (!isNewClaim) return res.status(409).json({ error: 'already_claimed' });

  const user = await db.addBalance(req.telegramId, task.reward);
  res.json({ ok: true, balance: user.balance });
});

// ---------- redeem codes ----------

router.post('/redeem', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });

  const result = await db.redeemCode(code, req.telegramId);
  if (!result.ok) {
    const messages = {
      invalid: 'That code is not valid.',
      exhausted: 'That code has reached its maximum uses.',
      already_used: "You've already used this code.",
    };
    return res.status(400).json({ error: result.reason, message: messages[result.reason] || 'Could not redeem code.' });
  }

  res.json({ ok: true, reward: result.reward, balance: result.user.balance });
});

// ---------- leaderboard ----------

router.get('/leaderboard', async (req, res) => {
  const top = await db.getTopUsers(500);
  res.json(top);
});

module.exports = router;
