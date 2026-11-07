import test from 'node:test';
import assert from 'node:assert/strict';
import {createBudgetLimiter} from '../src/support/request-rate-limit.js';

function res() {
  return {headers: {}, set(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; }};
}

test('allows up to the limit, then 429 with Retry-After, then resets', () => {
  let t = 0;
  const check = createBudgetLimiter({now: () => t});
  const req = {ip: '1.1.1.1'};
  for (let i = 0; i < 3; i++) assert.equal(check(req, res(), 's', 3, 1000), true);
  const r = res();
  assert.equal(check(req, r, 's', 3, 1000), false);
  assert.equal(r.code, 429);
  assert.equal(r.headers['Retry-After'], '1');
  t = 1001;
  assert.equal(check(req, res(), 's', 3, 1000), true);
});

test('clients are independent and limit 0 disables', () => {
  const check = createBudgetLimiter();
  assert.equal(check({ip: 'a'}, res(), 's', 1, 1000), true);
  assert.equal(check({ip: 'b'}, res(), 's', 1, 1000), true);
  for (let i = 0; i < 5; i++) assert.equal(check({ip: 'c'}, res(), 's', 0, 1000), true);
});
