# Makyton — Full Web App + Backend

The complete Makyton app: a Postgres-backed Express API, a small companion
Telegram bot (for the two tasks that need real Telegram verification), and
the front-end (loading screen, home dashboard, leaderboard, profile, and a
password-protected admin panel) — all wired together and ready to deploy.

## What's real now

Unlike the earlier prototype, this version has actual persistence and logic:

- **Postgres** stores every user, balance, task completion, wallet, redeem
  code, and admin action
- **Telegram Login Widget** authenticates real users — the "Me" page shows
  their actual Telegram photo, username, and ID
- **A companion Telegram bot** auto-credits the two tasks that need real
  Telegram-side confirmation: starting the bot, and joining your channel/group
- **The 3 X tasks** (follow/like/repost) stay honor-system, exactly as
  discussed — there's still no way to verify those without X's expensive
  Enterprise API tier
- **Daily Bonus** cooldown is enforced server-side (in the database), so it
  survives refreshes and can't be reset by clearing browser state
- **Wallet and referral link** are tied to the real logged-in user
- **Redeem codes** and **admin-added tasks** (Visit Website / Start Another
  Bot) are created and managed from the admin panel and stored in Postgres
- **Admin login** is verified server-side with a JWT session cookie, not a
  password sitting in the page's JavaScript

## Project structure

```
makyton-app/
  src/
    server.js        — Express app entry point, starts the API + bot together
    db.js             — all Postgres queries
    auth.js           — Telegram Login verification + JWT session helpers
    bot.js            — companion Telegram bot (Start Bot / Join Channel tasks)
    routes/
      auth.js         — /api/auth/* (login, logout, admin login)
      user.js         — /api/* (profile, tasks, wallet, referral, redeem, leaderboard)
      admin.js         — /api/admin/* (users, tasks, redeem codes)
  public/
    index.html        — loading screen + Telegram login
    home.html          — dashboard
    leaderboard.html   — top 500
    me.html            — profile, wallet, referral, redeem
    admin.html          — admin panel (separate, not linked from user nav)
  schema.sql          — Postgres schema, runs automatically on startup
  .env.example
```

## 1. Set up the Telegram bot

1. Create the bot with [@BotFather](https://t.me/BotFather), save the `BOT_TOKEN`
2. Run `/setprivacy` → **Disable** (so it can see join events properly)
3. Run `/setjoingroups` → **Enable**
4. **Important for login to work**: run `/setdomain` and give it the exact
   domain your app will be hosted on (e.g. `yourapp.up.railway.app`) — the
   Telegram Login Widget will not work without this
5. Add the bot to your channel/group as an **admin** (required to detect joins)
6. Get that channel/group's chat ID (e.g. by temporarily adding `@RawDataBot`
   to it) — this is `JOIN_CHAT_ID`

## 2. Environment variables

Set these in Railway's Variables tab (or a local `.env` for testing):

| Variable | Description |
|---|---|
| `DATABASE_URL` | Auto-filled by Railway's Postgres plugin |
| `PGSSL` | `true` if your Postgres needs SSL |
| `JWT_SECRET` | Any long random string |
| `BOT_TOKEN` | From BotFather |
| `BOT_USERNAME` | Bot's username, no `@` |
| `JOIN_CHAT_ID` | Channel/group chat ID for the join task |
| `ADMIN_PASSWORD` | Password for the admin panel |
| `X_FOLLOW_LINK` / `X_POST_LINK` | Links shown for the 3 honor-system X tasks |
| `X_FOLLOW_REWARD`, `X_LIKE_REWARD`, `X_REPOST_REWARD`, `JOIN_CHANNEL_REWARD`, `START_BOT_REWARD`, `REFERRAL_REWARD`, `DAILY_BONUS_REWARD` | Reward amounts — defaults match what we agreed on (20/10/10/20/15/12/5) |

## 3. Deploy to Railway

1. Push this project to GitHub
2. Railway → **New Project → Deploy from GitHub repo**
3. Add a **Postgres** plugin (injects `DATABASE_URL` automatically)
4. Add all the variables from the table above
5. Railway runs `npm start` automatically — check the logs for:
   ```
   [db] schema ready
   [makyton] server listening on port ...
   [makyton] companion bot is running (long polling)
   ```
6. Once deployed, go back to BotFather and run `/setdomain` with your live
   Railway URL (steps above) — login won't work until this is set correctly

## How the trickier features actually work now

- **Daily Bonus**: `last_daily_bonus_at` is stored per user in Postgres. The
  claim endpoint only succeeds if 24 real hours have passed since that
  timestamp — there's no way to reset it from the browser.
- **Visit Website task (15s dwell)**: clicking "Visit" calls
  `POST /tasks/visit/:id/start`, which records a server-side timestamp.
  Clicking "Done" calls `POST /tasks/visit/:id/claim`, which only succeeds
  if **at least 15 real seconds** have passed since that timestamp — checked
  server-side, not by a client-side timer, so it can't be bypassed by editing
  the page.
- **Referral payout**: still pays out when the *referred* user submits a
  wallet address (not just on login), same anti-abuse reasoning as before.
- **Start Bot / Join Channel tasks**: these are the only two tasks the
  companion bot can verify for real. Everything else (X tasks, admin-added
  "start another bot" tasks) remains honor-system, because Telegram and X
  don't give third parties a way to verify those actions automatically.

## Known limitations (be aware of these)

- **Admin panel access control is password-only** — there's no per-admin
  account or audit log of who changed what. Fine for a single admin (you),
  but worth upgrading if you ever add more admins.
- **No rate limiting yet** on the API — consider adding it before this gets
  real traffic, especially on `/api/redeem` and the admin login endpoint.
- **The companion bot uses long polling**, same trade-off as before — fine
  at moderate scale, switch to webhooks later if needed.
- **No automated withdrawal system** — as discussed, $MYT is still purely an
  in-app balance. Nothing here touches a real token contract or wallet funds.
