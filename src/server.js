require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const db = require('./db');
const { createBot } = require('./bot');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const adminRoutes = require('./routes/admin');

const requiredEnvVars = ['DATABASE_URL', 'JWT_SECRET', 'BOT_TOKEN', 'BOT_USERNAME', 'ADMIN_PASSWORD'];
const missing = requiredEnvVars.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(cookieParser());

app.use('/api/auth', authRoutes);
app.use('/api', userRoutes);
app.use('/api/admin', adminRoutes);

// Serve the front-end (index.html, home.html, leaderboard.html, me.html, admin.html)
app.use(express.static(path.join(__dirname, '..', 'public')));

async function main() {
  await db.initDb();

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`[makyton] server listening on port ${port}`));

  const bot = createBot();
  if (bot) {
    await bot.launch();
    console.log('[makyton] companion bot is running (long polling)');
  }
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

process.once('SIGINT', () => process.exit(0));
process.once('SIGTERM', () => process.exit(0));
