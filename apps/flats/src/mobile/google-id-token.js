// Verifies Google ID tokens ("Sign in with Google") without a Google SDK.
//
// A Google ID token is an RS256 JWT signed with one of Google's rotating keys,
// published as a JWK set. Verifying it means: the signature is valid under the
// key named by `kid`, the issuer is Google, the audience is one of OUR OAuth
// client ids (so a token minted for another site cannot be replayed here), and
// it has not expired. Only `sub` -- Google's stable, never-reassigned user id --
// is returned; email, name and picture are deliberately not read.
import {createPublicKey, verify as verifySignature} from 'node:crypto';

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const CLOCK_SKEW_SECONDS = 60;
const DEFAULT_KEYS_TTL_MS = 60 * 60 * 1000;
// An unknown kid triggers a refetch (Google rotated keys), but at most this
// often, so a stream of forged kids cannot make us hammer Google.
const MIN_REFETCH_INTERVAL_MS = 60 * 1000;
const JWKS_FETCH_TIMEOUT_MS = 5_000;

export class GoogleTokenError extends Error {
  constructor(code) {
    super(`google id token rejected: ${code}`);
    this.code = code;
  }
}

/** The OAuth client ids a token may be issued to (web + Android server client). */
export function configuredGoogleClientIds(env = process.env) {
  return String(env.GOOGLE_OAUTH_CLIENT_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function decodeSegment(segment) {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function maxAgeMs(cacheControl) {
  const match = /max-age=(\d+)/u.exec(String(cacheControl || ''));
  return match ? Number(match[1]) * 1000 : DEFAULT_KEYS_TTL_MS;
}

async function fetchGoogleKeys(fetchImpl) {
  const response = await fetchImpl(GOOGLE_JWKS_URL, {signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS)});
  if (!response.ok) throw new Error(`google jwks HTTP ${response.status}`);
  const body = await response.json();
  return {keys: Array.isArray(body?.keys) ? body.keys : [], ttlMs: maxAgeMs(response.headers?.get?.('cache-control'))};
}

/**
 * Builds a verifier. `fetchKeys` and `now` are injectable for tests; the
 * defaults fetch Google's JWK set and use the wall clock.
 */
export function createGoogleIdTokenVerifier({
  clientIds = configuredGoogleClientIds(),
  fetchKeys = () => fetchGoogleKeys(fetch),
  now = () => Date.now(),
} = {}) {
  let keysByKid = new Map();
  let expiresAt = 0;
  let lastFetchAt = -Infinity;
  let inflight = null;

  async function refresh() {
    if (!inflight) {
      inflight = (async () => {
        lastFetchAt = now();
        const {keys, ttlMs} = await fetchKeys();
        keysByKid = new Map(keys.filter((key) => key?.kid && key.kty === 'RSA').map((key) => [key.kid, key]));
        expiresAt = now() + ttlMs;
      })().finally(() => { inflight = null; });
    }
    await inflight;
  }

  async function keyFor(kid) {
    if (now() >= expiresAt) await refresh();
    let jwk = keysByKid.get(kid);
    if (!jwk && now() - lastFetchAt >= MIN_REFETCH_INTERVAL_MS) {
      await refresh();
      jwk = keysByKid.get(kid);
    }
    return jwk || null;
  }

  return async function verifyGoogleIdToken(token) {
    if (!clientIds.length) throw new GoogleTokenError('not_configured');
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 3 || token.length > 8192) throw new GoogleTokenError('malformed');

    const header = decodeSegment(parts[0]);
    const claims = decodeSegment(parts[1]);
    if (!header || !claims) throw new GoogleTokenError('malformed');
    // Pin the algorithm: never let the token choose it ("alg: none" et al.).
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new GoogleTokenError('bad_header');

    const jwk = await keyFor(header.kid);
    if (!jwk) throw new GoogleTokenError('unknown_key');
    let valid = false;
    try {
      const key = createPublicKey({key: jwk, format: 'jwk'});
      valid = verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
    } catch {
      valid = false;
    }
    if (!valid) throw new GoogleTokenError('bad_signature');

    const seconds = Math.floor(now() / 1000);
    if (!GOOGLE_ISSUERS.has(claims.iss)) throw new GoogleTokenError('bad_issuer');
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.some((aud) => clientIds.includes(aud))) throw new GoogleTokenError('bad_audience');
    if (!Number.isFinite(claims.exp) || claims.exp + CLOCK_SKEW_SECONDS < seconds) throw new GoogleTokenError('expired');
    if (Number.isFinite(claims.iat) && claims.iat - CLOCK_SKEW_SECONDS > seconds) throw new GoogleTokenError('issued_in_future');
    const sub = typeof claims.sub === 'string' ? claims.sub.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,255}$/u.test(sub)) throw new GoogleTokenError('bad_subject');

    return {sub};
  };
}
