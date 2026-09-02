import test from 'node:test';
import assert from 'node:assert/strict';

import {createRateLimiter} from '../src/support/request-rate-limit.js';

function responseRecorder() {
  const headers = new Map();
  return {
    statusCode: null,
    body: null,
    set(name, value) {
      headers.set(name.toLowerCase(), String(value));
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    header(name) {
      return headers.get(name.toLowerCase());
    },
  };
}

test('rate limiter returns Retry-After during the active window', () => {
  let timestamp = 10_000;
  const checkRate = createRateLimiter({now: () => timestamp});
  const req = {ip: '203.0.113.10'};

  assert.equal(checkRate(req, responseRecorder(), 'reloadAll', 8_000), true);

  timestamp += 1_500;
  const blocked = responseRecorder();
  assert.equal(checkRate(req, blocked, 'reloadAll', 8_000), false);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.header('Retry-After'), '7');
  assert.equal(blocked.body.error, 'Too many requests');
  assert.equal(blocked.body.retryAfterMs, 6_500);

  timestamp += 6_500;
  assert.equal(checkRate(req, responseRecorder(), 'reloadAll', 8_000), true);
});

test('rate limiter bounds unique client state instead of growing forever', () => {
  let timestamp = 20_000;
  const checkRate = createRateLimiter({
    now: () => timestamp,
    maxEntries: 2,
  });

  const res = () => responseRecorder();
  assert.equal(checkRate({ip: '198.51.100.1'}, res(), 'reloadAll', 60_000), true);
  assert.equal(checkRate({ip: '198.51.100.2'}, res(), 'reloadAll', 60_000), true);
  assert.equal(checkRate({ip: '198.51.100.3'}, res(), 'reloadAll', 60_000), true);

  // Inserting the third active client evicts the oldest entry, proving the
  // process-local map remains bounded even under high-cardinality traffic.
  assert.equal(checkRate({ip: '198.51.100.1'}, res(), 'reloadAll', 60_000), true);

  timestamp += 60_000;
  assert.equal(checkRate({ip: '198.51.100.2'}, res(), 'reloadAll', 60_000), true);
});

test('rate limiter clamps non-positive capacity instead of looping forever', () => {
  const checkRate = createRateLimiter({
    now: () => 30_000,
    maxEntries: 0,
  });

  assert.equal(
    checkRate({ip: '192.0.2.1'}, responseRecorder(), 'customSourceSearch', 3000),
    true,
  );
  assert.equal(
    checkRate({ip: '192.0.2.2'}, responseRecorder(), 'customSourceSearch', 3000),
    true,
  );
});
