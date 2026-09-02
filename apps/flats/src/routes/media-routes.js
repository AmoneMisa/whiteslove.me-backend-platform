import {readPhoto, writePhoto} from '../support/photoCache.js';

export function installMediaRoutes(app) {
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
