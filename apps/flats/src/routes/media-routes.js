import {readPhoto, writePhoto} from '../support/photoCache.js';

// 1x1 transparent PNG. Served with 200 instead of forwarding OLX's own CDN
// failure to the browser: apollo.olxcdn.com 404s for reasons entirely outside
// our control (a removed ad, a rotated asset id, a transient edge miss) that
// the client can't do anything about -- a broken-image icon plus a logged
// network error is strictly worse than an empty placeholder.
const OLX_PHOTO_PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const OLX_PHOTO_FETCH_TIMEOUT_MS = Math.max(2_000, Number(process.env.OLX_PHOTO_FETCH_TIMEOUT_MS) || 8_000);
const OLX_PHOTO_NEGATIVE_CACHE_MS = Math.max(30_000, Number(process.env.OLX_PHOTO_NEGATIVE_CACHE_MS) || 5 * 60_000);
const OLX_PHOTO_NEGATIVE_CACHE_MAX = 5_000;

// A URL that just came back missing is remembered briefly so a page full of
// thumbnails for one dead ad doesn't refetch (and re-404) the same OLX URL on
// every request. Bounded and time-boxed, never persisted: a later successful
// fetch simply overwrites the disk cache below.
const olxNegativeCache = new Map();

function isAllowedOlxCdnUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || ''));
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'olxcdn.com' || host.endsWith('.olxcdn.com');
}

function isNegativelyCached(key) {
  const expiresAt = olxNegativeCache.get(key);
  if (expiresAt == null) return false;
  if (expiresAt > Date.now()) return true;
  olxNegativeCache.delete(key);
  return false;
}

function markNegativelyCached(key) {
  if (olxNegativeCache.size >= OLX_PHOTO_NEGATIVE_CACHE_MAX) {
    const now = Date.now();
    for (const [existingKey, expiresAt] of olxNegativeCache) {
      if (expiresAt <= now) olxNegativeCache.delete(existingKey);
    }
  }
  olxNegativeCache.set(key, Date.now() + OLX_PHOTO_NEGATIVE_CACHE_MS);
}

function sendOlxPlaceholder(res) {
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('X-Photo-Cache', 'placeholder');
  return res.status(200).send(OLX_PHOTO_PLACEHOLDER_PNG);
}

export function installMediaRoutes(app) {
  app.get('/api/olx-photo', async (req, res) => {
    const target = String(req.query.src || '');
    if (!isAllowedOlxCdnUrl(target)) return res.status(400).end();
    if (isNegativelyCached(target)) return sendOlxPlaceholder(res);

    const cached = await readPhoto('olx', target);
    if (cached) {
      res.setHeader('Content-Type', cached.contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('X-Photo-Cache', 'hit');
      return res.send(cached.buffer);
    }

    try {
      const upstream = await fetch(target, {signal: AbortSignal.timeout(OLX_PHOTO_FETCH_TIMEOUT_MS)});
      if (!upstream.ok) {
        markNegativelyCached(target);
        return sendOlxPlaceholder(res);
      }

      const buffer = Buffer.from(await upstream.arrayBuffer());
      const contentType = upstream.headers.get('content-type') || 'image/jpeg';

      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('X-Photo-Cache', 'miss');
      res.send(buffer);

      void writePhoto('olx', target, buffer, contentType);
    } catch {
      markNegativelyCached(target);
      sendOlxPlaceholder(res);
    }
  });

  app.get('/api/tg-photo/:channel/:id', async (req, res) => {
    const workerUrl = process.env.TG_WORKER_URL || '';
    if (!workerUrl) return res.status(404).end();

    const {channel, id} = req.params;
    if (!/^[A-Za-z0-9_]{3,64}$/.test(channel) || !/^\d+$/.test(id)) {
      return res.status(400).end();
    }

    const cached = await readPhoto(channel, id);
    if (cached) {
      res.setHeader('Content-Type', cached.contentType);
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      res.setHeader('X-Photo-Cache', 'hit');
      return res.send(cached.buffer);
    }

    try {
      const params = new URLSearchParams({channel, id});
      const response = await fetch(`${workerUrl}/photo?${params}`, {
        signal: AbortSignal.timeout(20_000),
      });

      if (!response.ok) {
        return res.status(response.status === 404 ? 404 : 502).end();
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get('content-type') || 'image/jpeg';

      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      res.setHeader('X-Photo-Cache', 'miss');
      res.send(buffer);

      void writePhoto(channel, id, buffer, contentType);
    } catch {
      res.status(502).end();
    }
  });
}
