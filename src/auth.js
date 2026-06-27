const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const USER_COOKIE = 'makyton_session';
const ADMIN_COOKIE = 'makyton_admin_session';

// Verifies the data Telegram's Login Widget sends to the browser.
// See: https://core.telegram.org/widgets/login#checking-authorization
function verifyTelegramAuth(data) {
  const { hash, ...rest } = data;
  if (!hash) return false;

  const checkString = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${rest[key]}`)
    .join('\n');

  const secretKey = crypto.createHash('sha256').update(process.env.BOT_TOKEN).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');

  if (computedHash !== hash) return false;

  // Reject stale logins (older than 24h) to limit replay risk
  const authDate = parseInt(rest.auth_date, 10);
  const ageSeconds = Date.now() / 1000 - authDate;
  if (ageSeconds > 86400) return false;

  return true;
}

function issueUserSession(res, telegramId) {
  const token = jwt.sign({ telegramId }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie(USER_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function issueAdminSession(res) {
  const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '12h' });
  res.cookie(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 12 * 60 * 60 * 1000,
  });
}

function requireUser(req, res, next) {
  const token = req.cookies[USER_COOKIE];
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.telegramId = payload.telegramId;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

function requireAdmin(req, res, next) {
  const token = req.cookies[ADMIN_COOKIE];
  if (!token) return res.status(401).json({ error: 'Not logged in as admin' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload.admin) throw new Error('not admin');
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired admin session' });
  }
}

module.exports = {
  USER_COOKIE,
  ADMIN_COOKIE,
  verifyTelegramAuth,
  issueUserSession,
  issueAdminSession,
  requireUser,
  requireAdmin,
};
