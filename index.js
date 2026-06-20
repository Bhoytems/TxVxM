require('dotenv').config();
const { Telegraf } = require('telegraf');
const db = require('./db');

const { handleStart } = require('./handlers/start');
const { onVerifyButton, onWithdrawButton, onWalletMessage, onVerifyDone } = require('./handlers/verify');
const { onNewChatMembers, onChatMember } = require('./handlers/groupEvents');
const { handleStats } = require('./handlers/stats');
const { handleRefCode } = require('./handlers/refcode');
const { handleAddTask, handleListTasks, handleRemoveTask, onClaimTask } = require('./handlers/tasks');

if (!process.env.BOT_TOKEN) {
  console.error('Missing BOT_TOKEN in environment variables.');
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

// --- Commands ---
bot.start(handleStart);
bot.command('stats', handleStats);
bot.command('refcode', handleRefCode);
bot.command('addtask', handleAddTask);
bot.command('removetask', handleRemoveTask);
bot.command('tasks', handleListTasks);

// --- Inline button callbacks ---
bot.action('verify_start', onVerifyButton);
bot.action('verify_done', onVerifyDone);
bot.action('withdraw', onWithdrawButton);
bot.action(/^claim_(\d+)$/, onClaimTask);

// --- Group events ---
bot.on('new_chat_members', onNewChatMembers);
bot.on('chat_member', onChatMember);

// --- Plain text messages (used for capturing wallet address mid-verification) ---
bot.on('text', async (ctx, next) => {
  // Ignore commands and group chats here; wallet capture only happens in DM
  if (ctx.chat.type !== 'private') return next();
  if (ctx.message.text.startsWith('/')) return next();

  const user = await db.getUser(ctx.from.id);
  if (user && user.awaiting_wallet) {
    return onWalletMessage(ctx);
  }
  return next();
});

async function main() {
  await db.initDb();

  // Long polling. Switch to a webhook (bot.launch({ webhook: {...} })) once you
  // have a stable public Railway URL if you want lower latency at scale.
  await bot.launch();
  console.log('[makyton] bot is running');
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
