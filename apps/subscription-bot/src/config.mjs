function positiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function cleanUrl(value, fallback) {
  return String(value || fallback).replace(/\/$/, '');
}

export const config = {
  enabled: String(process.env.TELEGRAM_SUBSCRIPTION_BOT_ENABLED || 'off').toLowerCase() === 'on',
  token: String(process.env.TELEGRAM_SUBSCRIPTION_BOT_TOKEN || '').trim(),
  databaseUrl: String(
    process.env.SUBSCRIPTIONS_DATABASE_URL
      || process.env.HIRING_DATABASE_URL
      || process.env.JOBS_QUEUE_DATABASE_URL
      || '',
  ).trim(),
  dbSchema: String(process.env.SUBSCRIPTIONS_DB_SCHEMA || 'subscriptions').trim(),
  siteBaseUrl: cleanUrl(process.env.SITE_BASE_URL, 'https://whiteslove.me'),
  sitePublicUrl: cleanUrl(process.env.SITE_PUBLIC_URL, 'https://whiteslove.me'),
  flatApiUrl: cleanUrl(process.env.FLAT_API_URL, 'http://flats-api:4000'),
  pollSeconds: positiveInt(process.env.SUBSCRIPTION_POLL_SECONDS, 60, 30, 3600),
  telegramLongPollSeconds: positiveInt(process.env.TELEGRAM_LONG_POLL_SECONDS, 25, 5, 50),
  maxNotificationsPerScan: positiveInt(process.env.SUBSCRIPTION_MAX_NOTIFICATIONS_PER_SCAN, 10, 1, 50),
  fetchTimeoutMs: positiveInt(process.env.SUBSCRIPTION_FETCH_TIMEOUT_MS, 20_000, 3_000, 120_000),
  flatRequireVerified: String(process.env.FLAT_REQUIRE_VERIFIED || 'on').toLowerCase() !== 'off',
};

if (!/^[a-z_][a-z0-9_]*$/i.test(config.dbSchema)) {
  throw new Error(`Invalid SUBSCRIPTIONS_DB_SCHEMA: ${config.dbSchema}`);
}

export function validateConfig() {
  const missing = [];
  if (!config.token) missing.push('TELEGRAM_SUBSCRIPTION_BOT_TOKEN');
  if (!config.databaseUrl) missing.push('SUBSCRIPTIONS_DATABASE_URL or HIRING_DATABASE_URL');
  if (missing.length) throw new Error(`Missing required environment: ${missing.join(', ')}`);
}
