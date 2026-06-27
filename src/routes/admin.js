const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAdmin } = require('../auth');

router.use(requireAdmin);

// ---------- users ----------

router.get('/users', async (req, res) => {
  const users = await db.getAllUsers(req.query.q);
  res.json(users);
});

router.post('/users/:telegramId/adjust', async (req, res) => {
  const telegramId = parseInt(req.params.telegramId, 10);
  const { amount, direction } = req.body; // direction: 'add' | 'deduct'

  if (!amount || amount <= 0 || !['add', 'deduct'].includes(direction)) {
    return res.status(400).json({ error: 'Invalid amount or direction' });
  }

  const delta = direction === 'add' ? amount : -amount;
  const user = await db.addBalance(telegramId, delta);
  if (!user) return res.status(404).json({ error: 'User not found' });

  res.json(user);
});

// ---------- tasks ----------

router.get('/tasks', async (req, res) => {
  const tasks = await db.getAllTasks();
  res.json(tasks);
});

router.post('/tasks', async (req, res) => {
  const { type, title, link, reward } = req.body;
  if (!['visit_website', 'bot_link'].includes(type) || !title || !link || !reward) {
    return res.status(400).json({ error: 'type, title, link, and reward are all required' });
  }
  const task = await db.createTask(type, title, link, parseInt(reward, 10));
  res.json(task);
});

router.delete('/tasks/:id', async (req, res) => {
  const task = await db.deactivateTask(parseInt(req.params.id, 10));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json({ ok: true });
});

// ---------- redeem codes ----------

router.get('/redeem-codes', async (req, res) => {
  const codes = await db.getAllRedeemCodes();
  res.json(codes);
});

router.post('/redeem-codes', async (req, res) => {
  const { code, reward, maxUses } = req.body;
  if (!code || !reward) {
    return res.status(400).json({ error: 'code and reward are required' });
  }
  try {
    const created = await db.createRedeemCode(code, parseInt(reward, 10), maxUses ? parseInt(maxUses, 10) : null);
    res.json(created);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That code already exists' });
    throw err;
  }
});

module.exports = router;
