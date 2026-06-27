const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyTelegramAuth, issueUserSession, issueAdminSession, USER_COOKIE, ADMIN_COOKIE } = require('../auth');

// Public — lets the front end know the bot username without hardcoding it
router.get('/config', (req, res) => {
  res.json({ botUsername: process.env.BOT_USERNAME });
});

// Called by the Telegram Login Widget on the front end with the user's signed data
router.post('/telegram', async (req, res) => {
  const data = req.body;
  if (!verifyTelegramAuth(data)) {
    return res.status(401).json({ error: 'Telegram login verification failed' });
  }

  const user = await db.upsertUser({
    telegramId: data.id,
    username: data.username,
    firstName: data.first_name,
    photoUrl: data.photo_url,
  });

  // Referral via web query param: /?ref=123456789, stashed by the front end into the POST body
  if (req.body.ref) {
    const referrerId = parseInt(req.body.ref, 10);
    if (!isNaN(referrerId)) await db.setReferredBy(user.telegram_id, referrerId);
  }

  issueUserSession(res, user.telegram_id);
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  res.clearCookie(USER_COOKIE);
  res.json({ ok: true });
});

router.post('/admin-login', (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  issueAdminSession(res);
  res.json({ ok: true });
});

router.post('/admin-logout', (req, res) => {
  res.clearCookie(ADMIN_COOKIE);
  res.json({ ok: true });
});

module.exports = router;
