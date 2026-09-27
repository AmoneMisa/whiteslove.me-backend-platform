import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, sign} from 'node:crypto';

import {configuredGoogleClientIds, createGoogleIdTokenVerifier, GoogleTokenError} from '../src/mobile/google-id-token.js';

const CLIENT_ID = 'web-client.apps.googleusercontent.com';
const NOW = Date.parse('2026-09-27T12:00:00Z');
const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
const other = generateKeyPairSync('rsa', {modulusLength: 2048});
const jwk = {...publicKey.export({format: 'jwk'}), kid: 'key-1', alg: 'RS256', use: 'sig'};

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(claims = {}, {header = {}, key = privateKey} = {}) {
  const head = b64({alg: 'RS256', kid: 'key-1', typ: 'JWT', ...header});
  const body = b64({
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: '110169484474386276334',
    iat: NOW / 1000 - 10,
    exp: NOW / 1000 + 3600,
    email: 'someone@example.com',
    ...claims,
  });
  const signature = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${signature}`;
}

function verifier({fetchKeys} = {}) {
  let fetches = 0;
  const verify = createGoogleIdTokenVerifier({
    clientIds: [CLIENT_ID],
    now: () => NOW,
    fetchKeys: fetchKeys ?? (async () => { fetches += 1; return {keys: [jwk], ttlMs: 60_000}; }),
  });
  return {verify, fetches: () => fetches};
}

async function rejects(promise, code) {
  await assert.rejects(promise, (error) => error instanceof GoogleTokenError && error.code === code);
}

test('a genuine token yields only the subject id', async () => {
  const {verify} = verifier();
  // Email, name and picture are in the token but never returned.
  assert.deepEqual(await verify(token()), {sub: '110169484474386276334'});
  assert.deepEqual(await verify(token({iss: 'accounts.google.com'})), {sub: '110169484474386276334'});
});

test('a token for another site, from another issuer, or expired is refused', async () => {
  const {verify} = verifier();
  await rejects(verify(token({aud: 'someone-elses-client.apps.googleusercontent.com'})), 'bad_audience');
  await rejects(verify(token({iss: 'https://evil.example'})), 'bad_issuer');
  await rejects(verify(token({exp: NOW / 1000 - 120})), 'expired');
  await rejects(verify(token({iat: NOW / 1000 + 600})), 'issued_in_future');
  await rejects(verify(token({sub: ''})), 'bad_subject');
});

test('forged signatures and algorithm tricks are refused', async () => {
  const {verify} = verifier();
  await rejects(verify(token({}, {key: other.privateKey})), 'bad_signature');
  // A valid signature over different claims.
  const [head, , signature] = token().split('.');
  await rejects(verify(`${head}.${b64({iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'attacker', exp: NOW / 1000 + 60})}.${signature}`), 'bad_signature');
  // The token never chooses the algorithm.
  await rejects(verify(token({}, {header: {alg: 'none'}})), 'bad_header');
  await rejects(verify(token({}, {header: {alg: 'HS256'}})), 'bad_header');
  await rejects(verify('not-a-jwt'), 'malformed');
  await rejects(verify(undefined), 'malformed');
});

test('an unknown key refetches once, then is throttled', async () => {
  const {verify, fetches} = verifier();
  await verify(token());
  assert.equal(fetches(), 1);
  await rejects(verify(token({}, {header: {kid: 'rotated'}})), 'unknown_key');
  await rejects(verify(token({}, {header: {kid: 'rotated-again'}})), 'unknown_key');
  // The first unknown kid was inside the throttle window of the initial fetch.
  assert.equal(fetches(), 1);
});

test('without configured client ids sign-in is off, not open', async () => {
  const verify = createGoogleIdTokenVerifier({clientIds: [], fetchKeys: async () => ({keys: [jwk], ttlMs: 1})});
  await rejects(verify(token()), 'not_configured');
  assert.deepEqual(configuredGoogleClientIds({GOOGLE_OAUTH_CLIENT_IDS: ' a.apps , b.apps ,'}), ['a.apps', 'b.apps']);
  assert.deepEqual(configuredGoogleClientIds({}), []);
});
