import { timingSafeEqual } from 'node:crypto';

export function internalKey(...envNames) {
  for (const name of envNames) {
    const value = String(process.env[name] || '');
    if (value) return value;
  }
  return String(process.env.QUEUE_INTERNAL_KEY || '');
}

function secretsEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ''));
  const expectedBuffer = Buffer.from(String(expected || ''));

  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export function requireInternal(req, res, {
  envNames = [],
  header = 'x-queue-key',
  minLength = 16,
  missingMessage = 'Internal API key is not configured',
} = {}) {
  const expected = internalKey(...envNames);

  if (expected.length < minLength) {
    res.status(503).json({ error: missingMessage });
    return false;
  }

  if (!secretsEqual(req.get(header), expected)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }

  return true;
}
