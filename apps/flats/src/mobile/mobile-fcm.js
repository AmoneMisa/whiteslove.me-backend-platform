import {createSign} from 'node:crypto';

let credentials;
let accessTokenCache;

function serviceAccount() {
  if (credentials !== undefined) return credentials;
  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT_B64 || '').trim();
  if (!raw) {
    credentials = null;
    return credentials;
  }
  try {
    credentials = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch (err) {
    console.warn('[mobile-push] invalid FIREBASE_SERVICE_ACCOUNT_B64:', err?.message ?? err);
    credentials = null;
  }
  return credentials;
}

export function mobilePushConfigured() {
  const account = serviceAccount();
  return Boolean(account?.client_email && account?.private_key && account?.project_id);
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (accessTokenCache?.expiresAt > now + 60) return accessTokenCache.value;

  const account = serviceAccount();
  if (!account) throw new Error('firebase_not_configured');

  const header = base64url(JSON.stringify({alg: 'RS256', typ: 'JWT'}));
  const claims = base64url(JSON.stringify({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${signer.sign(account.private_key).toString('base64url')}`;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(`firebase_token_${response.status}:${data.error_description || data.error || 'unknown'}`);
  }
  accessTokenCache = {
    value: data.access_token,
    expiresAt: now + Number(data.expires_in || 3600),
  };
  return accessTokenCache.value;
}

export async function sendMobilePush({token, title, body, data = {}}) {
  const account = serviceAccount();
  if (!account) throw new Error('firebase_not_configured');
  const auth = await getAccessToken();
  const payloadData = Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, String(value ?? '')]),
  );
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${auth}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token,
          notification: {title, body},
          data: payloadData,
          android: {priority: 'high'},
        },
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`firebase_send_${response.status}:${result?.error?.message || 'unknown'}`);
    error.status = response.status;
    error.firebaseStatus = result?.error?.status || '';
    throw error;
  }
  return result;
}
