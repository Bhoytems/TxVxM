const { Telegraf } = require('telegraf');
const db = require('./db');

const START_BOT_REWARD = parseInt(process.env.START_BOT_REWARD || '15', 10);
const JOIN_CHANNEL_REWARD = parseInt(process.env.JOIN_CHANNEL_REWARD || '20', 10);

function createBot() {
  if (!process.env.BOT_TOKEN) {
    console.warn('[bot] BOT_TOKEN not set — companion bot disabled. Start Bot / Join Channel tasks will not auto-credit.');
    return null;
  }

  const bot = new Telegraf(process.env.BOT_TOKEN);

  // "Start Telegram bot" task — fires once per user
  bot.start(async (ctx) => {
    const tgUser = ctx.from;
    await db.upsertUser({ telegramId: tgUser.id, username: tgUser.username, firstName: tgUser.first_name });

    // Referral payload: /start ref_123456789
    const payload = ctx.startPayload;
    if (payload && payload.startsWith('ref_')) {
      const referrerId = parseInt(payload.replace('ref_', ''), 10);
      if (!isNaN(referrerId)) await db.setReferredBy(tgUser.id, referrerId);
    }

    const justCompleted = await db.markFixedTaskDone(tgUser.id, 'started_bot_task_done');
    if (justCompleted) {
      await db.addBalance(tgUser.id, START_BOT_REWARD);
    }

    await ctx.reply(
      `Welcome to Makyton! You earned ${START_BOT_REWARD} $MYT for starting the bot.\n\n` +
        `Open the Makyton web app to see your full dashboard, tasks, and leaderboard.`
    );
  });

  // "Join Telegram channel/group" task — fires when someone joins the configured chat
  bot.on('chat_member', async (ctx) => {
    const update = ctx.chatMember;
    if (!update) return;
    if (String(update.chat.id) !== String(process.env.JOIN_CHAT_ID)) return;

    const newStatus = update.new_chat_member.status;
    const oldStatus = update.old_chat_member.status;
    const justJoined = ['member', 'administrator'].includes(newStatus) && !['member', 'administrator'].includes(oldStatus);
    if (!justJoined) return;

    const member = update.new_chat_member.user;
    if (member.is_bot) return;

    await db.upsertUser({ telegramId: member.id, username: member.username, firstName: member.first_name });
    await db.markFixedTaskDone(member.id, 'joined_channel_task_done').then((row) => {
      if (row) db.addBalance(member.id, JOIN_CHANNEL_REWARD);
    });
  });

  // Also handle joins detected as a regular group message (for groups, not channels)
  bot.on('new_chat_members', async (ctx) => {
    if (String(ctx.chat.id) !== String(process.env.JOIN_CHAT_ID)) return;
    for (const member of ctx.message.new_chat_members) {
      if (member.is_bot) continue;
      await db.upsertUser({ telegramId: member.id, username: member.username, firstName: member.first_name });
      const justCompleted = await db.markFixedTaskDone(member.id, 'joined_channel_task_done');
      if (justCompleted) await db.addBalance(member.id, JOIN_CHANNEL_REWARD);
    }
  });

  return bot;
}

module.exports = { createBot };
