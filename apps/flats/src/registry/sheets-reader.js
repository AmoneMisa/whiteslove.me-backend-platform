import { readFile } from 'node:fs/promises';
import { createSign } from 'node:crypto';

/**
 * Read-only Google Sheets access for the legacy registry.
 *
 * Implemented directly against the REST API with a service-account JWT rather
 * than pulling in the googleapis SDK: the whole requirement is "read some
 * ranges", and the SDK is a large dependency for one GET.
 *
 * Secrets are never inlined. The service-account key is read from a file path
 * given in configuration, and nothing here logs the key, the assertion or the
 * access token.
 *
 * This is a *seed* path. §8 requires that normal request handling never depend
 * on a live Sheets call, so nothing in the request path may import this module;
 * it is for the importer only.
 */

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const TOKEN_TTL_SECONDS = 3600;
/** Refresh early so a long import cannot expire mid-run. */
const TOKEN_SKEW_MS = 60_000;

const base64url = (input) => Buffer.from(input).toString('base64url');

/** Signs the assertion Google exchanges for an access token (RS256). */
function signAssertion({ clientEmail, privateKey }) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + TOKEN_TTL_SECONDS,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${signer.sign(privateKey, 'base64url')}`;
}

export async function loadServiceAccount(filePath) {
  if (!filePath) throw new Error('REGISTRY_GOOGLE_SERVICE_ACCOUNT_FILE is not configured');
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    // Deliberately does not include the file contents in the message.
    throw new Error(`Could not read the registry service account file at ${filePath}: ${error.code ?? 'unreadable'}`);
  }
  const clientEmail = parsed.client_email;
  const privateKey = parsed.private_key;
  if (!clientEmail || !privateKey) throw new Error('The registry service account file is missing client_email or private_key');
  return { clientEmail, privateKey };
}

/** Caches the access token for its lifetime; one token serves a whole import. */
export function createSheetsReader(options = {}) {
  const { sheetId, serviceAccount, fetchImpl = fetch } = options;
  if (!sheetId) throw new Error('REGISTRY_GOOGLE_SHEET_ID is not configured');
  let token = null;
  let tokenExpiresAt = 0;

  async function accessToken() {
    if (token && Date.now() < tokenExpiresAt - TOKEN_SKEW_MS) return token;
    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signAssertion(serviceAccount),
      }),
    });
    if (!response.ok) {
      // The body can echo the assertion; report only the status.
      throw new Error(`Google token exchange failed with status ${response.status}`);
    }
    const payload = await response.json();
    token = payload.access_token;
    tokenExpiresAt = Date.now() + (Number(payload.expires_in) || TOKEN_TTL_SECONDS) * 1000;
    if (!token) throw new Error('Google token exchange returned no access token');
    return token;
  }

  /**
   * Reads several ranges in one request. batchGet exists precisely so an
   * importer does not make one call per tab, and it keeps the whole import to a
   * single round trip against a quota-limited API.
   */
  async function readTabs(tabNames) {
    const names = (tabNames ?? []).filter(Boolean);
    if (!names.length) return {};
    const params = new URLSearchParams();
    for (const name of names) params.append('ranges', name);
    // UNFORMATTED_VALUE keeps a phone written as a number from arriving as
    // "9.98901234567e+11"; FORMATTED_STRING keeps what the operator sees.
    params.set('valueRenderOption', 'FORMATTED_VALUE');
    params.set('majorDimension', 'ROWS');

    const response = await fetchImpl(`${SHEETS_API}/${encodeURIComponent(sheetId)}/values:batchGet?${params}`, {
      headers: { authorization: `Bearer ${await accessToken()}` },
    });
    if (!response.ok) {
      if (response.status === 403) throw new Error('The service account does not have Viewer access to the registry workbook');
      if (response.status === 404) throw new Error('The configured REGISTRY_GOOGLE_SHEET_ID does not resolve to a workbook');
      throw new Error(`Google Sheets read failed with status ${response.status}`);
    }
    const payload = await response.json();
    const byName = {};
    for (const range of payload.valueRanges ?? []) {
      // The API echoes "Tab name!A1:Z999"; key results by the tab we asked for.
      const name = String(range.range ?? '').split('!')[0].replace(/^'|'$/g, '');
      byName[name] = range.values ?? [];
    }
    return byName;
  }

  return { readTabs };
}

/** Tab names as they appear in the workbook, mapped to the plan's tab keys. */
export const REGISTRY_TABS = Object.freeze({
  risk: 'Risk clusters',
  trusted: 'Trusted',
  identifiers: 'Aliases & phones',
  sources: 'Sources',
  review: 'Review',
});

/** Reads every registry tab in one batch and keys them for the planner. */
export async function readRegistryTabs(reader, tabNames = REGISTRY_TABS) {
  const wanted = Object.values(tabNames);
  const byName = await reader.readTabs(wanted);
  const tabs = {};
  for (const [key, name] of Object.entries(tabNames)) tabs[key] = byName[name] ?? [];
  return tabs;
}
