import {createHash} from 'node:crypto';

const CURSOR_VERSION = 1;
const SCOPE_VERSION = 1;
const MAX_CURSOR_TOKEN_LENGTH = 1024;
const BIGINT_MAX = 9_223_372_036_854_775_807n;
const NON_SEMANTIC_FILTER_KEYS = new Set([
  'cursor',
  'offset',
  'limit',
  'includeStats',
  'statsOnly',
  'mapOnly',
]);

function normalizeScopeValue(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    return value
      .map(normalizeScopeValue)
      .filter((item) => item !== undefined)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, normalizeScopeValue(value[key])]),
    );
  }
  return String(value);
}

function decodeCursor(value) {
  if (!value) return null;
  const token = String(value);
  if (token.length > MAX_CURSOR_TOKEN_LENGTH) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    return parsed?.v === CURSOR_VERSION && parsed && typeof parsed === 'object'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function normalizeCursorPosition(parsed, {keepCount = true} = {}) {
  const supportedSorts = ['newest', 'oldest', 'priceAsc', 'priceDesc'];
  if (!parsed || !supportedSorts.includes(parsed.sort)) return null;

  const id = String(parsed.id ?? '');
  if (!/^[1-9]\d*$/.test(id)) return null;
  try {
    if (BigInt(id) > BIGINT_MAX) return null;
  } catch {
    return null;
  }

  const normalized = {
    v: CURSOR_VERSION,
    sort: parsed.sort,
    id,
  };

  if (['newest', 'oldest'].includes(parsed.sort)) {
    let time = null;
    if (parsed.t) {
      const milliseconds = Date.parse(String(parsed.t));
      if (!Number.isFinite(milliseconds)) return null;
      time = new Date(milliseconds).toISOString();
    }
    normalized.t = time;
  } else {
    const price = parsed.p == null ? null : Number(parsed.p);
    if (price != null && !Number.isFinite(price)) return null;
    normalized.p = price;
  }

  const count = Number(parsed.c);
  if (keepCount && Number.isSafeInteger(count) && count >= 0) normalized.c = count;
  if (parsed.s != null) normalized.s = parsed.s;
  return normalized;
}

export function searchCursorScope(filters = {}, countries = []) {
  const semanticFilters = {};
  for (const key of Object.keys(filters || {}).sort()) {
    if (NON_SEMANTIC_FILTER_KEYS.has(key) || filters[key] === undefined) continue;
    semanticFilters[key] = normalizeScopeValue(filters[key]);
  }

  const normalizedCountries = [...new Set((countries || [])
    .map((value) => String(value).trim().toUpperCase())
    .filter(Boolean))]
    .sort();

  return createHash('sha256')
    .update(JSON.stringify({v: SCOPE_VERSION, countries: normalizedCountries, filters: semanticFilters}))
    .digest('base64url')
    .slice(0, 22);
}

export function prepareCursorForScope(value, scope) {
  if (!value) return '';
  const parsed = decodeCursor(value);
  if (!parsed) return '';

  if (parsed.s != null) {
    if (parsed.s !== scope) return '';
    const normalized = normalizeCursorPosition(parsed);
    return normalized ? encodeCursor(normalized) : '';
  }

  // Legacy v1 cursors remain usable as positional cursors, but their carried
  // total predates scope binding and therefore cannot be trusted for a new
  // request. Removing `c` forces the core query to calculate the count once.
  const normalized = normalizeCursorPosition(parsed, {keepCount: false});
  return normalized ? encodeCursor(normalized) : '';
}

export function attachScopeToCursor(value, scope) {
  if (!value) return null;
  const parsed = decodeCursor(value);
  const normalized = normalizeCursorPosition(parsed);
  if (!normalized) return null;
  return encodeCursor({...normalized, s: scope});
}
