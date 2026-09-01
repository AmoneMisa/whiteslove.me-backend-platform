import assert from 'node:assert/strict';
import test from 'node:test';

import { internalKey, requireInternal } from '../src/internal-auth.js';

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('internalKey prefers explicit keys and falls back to queue key', () => {
  withEnv({ SOCIAL_INTERNAL_KEY: 'social-secret-1234', QUEUE_INTERNAL_KEY: 'queue-secret-12345' }, () => {
    assert.equal(internalKey('SOCIAL_INTERNAL_KEY'), 'social-secret-1234');
  });

  withEnv({ SOCIAL_INTERNAL_KEY: null, QUEUE_INTERNAL_KEY: 'queue-secret-12345' }, () => {
    assert.equal(internalKey('SOCIAL_INTERNAL_KEY'), 'queue-secret-12345');
  });
});

test('requireInternal rejects missing and invalid credentials', () => {
  withEnv({ QUEUE_INTERNAL_KEY: null }, () => {
    const res = responseRecorder();
    assert.equal(requireInternal({ get: () => '' }, res), false);
    assert.equal(res.statusCode, 503);
  });

  withEnv({ QUEUE_INTERNAL_KEY: 'queue-secret-12345' }, () => {
    const res = responseRecorder();
    assert.equal(requireInternal({ get: () => 'wrong' }, res), false);
    assert.equal(res.statusCode, 401);
  });
});

test('requireInternal accepts the configured credential', () => {
  withEnv({ QUEUE_INTERNAL_KEY: 'queue-secret-12345' }, () => {
    const res = responseRecorder();
    const req = { get: (name) => (name === 'x-queue-key' ? 'queue-secret-12345' : '') };
    assert.equal(requireInternal(req, res), true);
    assert.equal(res.statusCode, 200);
  });
});
