// Browsers may call the public API only from origins we operate. Requests with
// no Origin header (the Nuxt BFF, mobile apps, curl, health checks) are not
// browser cross-origin requests and are always allowed.

const DEFAULT_ORIGINS = [
  'https://whiteslove.me',
  'https://www.whiteslove.me',
];

export function parseAllowedOrigins(raw = process.env.CORS_ALLOWED_ORIGINS) {
  const configured = String(raw || '')
    .split(',')
    .map((value) => value.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return new Set(configured.length ? configured : DEFAULT_ORIGINS);
}

export function createCorsOptions(allowed = parseAllowedOrigins()) {
  return {
    origin(origin, callback) {
      // false => no CORS headers; the browser blocks the response.
      callback(null, !origin || allowed.has(origin));
    },
    maxAge: 600,
  };
}
