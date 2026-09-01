# Telegram subscription bot

Private Telegram bot for whiteslove.me search updates. The deployable runtime
lives in the backend platform; the website keeps only its UI and same-origin
handoff/status routes.

- apartments (`/flat-finder`)
- vacancies (`/jobs`)
- candidates (`/hiring`)
- multiple independent subscriptions per Telegram user
- Russian and English UI
- edit filters on the website, pause/resume, rename, unsubscribe
- apartment photo/media-group delivery using the existing Personal Site photo proxy
- persisted delivery deduplication in PostgreSQL
- OLX availability gate using flat-finder's worker-owned persisted availability state

## UX

The website is the single source of truth for filters. Subscription creation does **not** happen by copying a URL into Telegram:

1. Open `/flat-finder`, `/jobs`, or `/hiring` on whiteslove.me.
2. Set the required filters in the normal website UI.
3. Press **Subscribe to new results / Подписаться на новые**.
4. Nuxt stores a short-lived one-time handoff in PostgreSQL and opens the bot with a compact `start` token.
5. The bot consumes that handoff, creates the subscription, and primes the current result set as already seen.

Telegram `start` payloads are intentionally kept short; raw filter URLs are never stuffed into the deep-link payload.

Editing follows the same path. The bot creates a user-bound 30-minute edit session and opens the saved search with the existing filters plus an internal `_tgEdit` token. After the user changes filters, the website button becomes **Update subscription / Обновить подписку** and returns through Telegram for confirmation. Another Telegram account cannot consume that edit session.

Current results are **primed as already seen** on create, edit, and resume. A pause therefore does not produce a backlog flood when the subscription is resumed.

Already delivered items are durable history. Deduplication uses `(telegram_user_id, kind, item_key)`, so the same apartment/job/candidate is never intentionally sent twice to one user, including when several subscriptions overlap or a subscription is later deleted and recreated.

## Commands

- `/subscriptions` — list active and paused subscriptions
- `/pause ID` — pause without notifications
- `/resume ID` — resume from a fresh baseline (no paused-period backlog)
- `/edit ID` — open the saved website search with its current filters
- `/unsubscribe ID` — delete the subscription
- `/language` — Russian / English

The same actions are available through inline buttons.

## Private-chat-only setup

Runtime code immediately leaves any non-private chat it receives an update from. Also disable group membership at the Telegram platform level:

1. Open `@BotFather`.
2. `/mybots` → select the bot.
3. **Bot Settings** → **Allow Groups?** → **Turn groups off** (equivalent to `/setjoingroups` → Disable).

Do this even though the bot also calls `leaveChat`; BotFather's setting prevents users from adding it to groups in the first place.

## Environment

The service is included in the backend platform `docker-compose.yml` and reads
the platform `.env`. The container is deployed in a safe disabled state by
default. To activate it add:

```env
TELEGRAM_SUBSCRIPTION_BOT_ENABLED=on
TELEGRAM_SUBSCRIPTION_BOT_TOKEN=123456:telegram-token
TELEGRAM_SUBSCRIPTION_BOT_USERNAME=your_bot_username
```

`TELEGRAM_SUBSCRIPTION_BOT_USERNAME` is also forwarded to the Nuxt frontend so `/subscription-link` can generate the website → Telegram deep link.

By default both services reuse `HIRING_DATABASE_URL` for durable storage, in a separate `subscriptions` schema. To use a different PostgreSQL database set `SUBSCRIPTIONS_DATABASE_URL`.

See `.env.example` in this directory for all optional settings.

## Apartment actuality

For OLX the bot calls flat-finder `POST /api/listings/verify`, which is intentionally read-only: the isolated flat-finder availability worker performs the source check and persists `active / inactive / unknown`. With `FLAT_REQUIRE_VERIFIED=on` (default), the bot sends an OLX listing only after persisted status is `active`; inactive items are discarded and unchecked/unknown items are retried later.

Telegram/Facebook/Threads apartment sources currently do not have the same source-level availability verifier in flat-finder. They are sent only while they are present in the active flat feed. This distinction is intentional; the bot does not claim to verify a source that the backend cannot actually probe.

## Development

```bash
cd subscription-bot
npm install
npm run check
TELEGRAM_SUBSCRIPTION_BOT_ENABLED=on TELEGRAM_SUBSCRIPTION_BOT_TOKEN=... HIRING_DATABASE_URL=... npm start
```

The bot uses Telegram Bot API long polling and does not expose an HTTP port.
