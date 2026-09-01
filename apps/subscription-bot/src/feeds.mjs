import { config } from './config.mjs';

const PERIOD_TO_YEAR = { hour: 1920, month: 12, year: 1 };
const UI_ONLY = new Set(['job', 'cv', 'cvSource', 'cvCountry', 'flat', 'flatSource', 'flatCountry', 'listingId', 'sourceName', 'countryCode', '_tgEdit']);

function timeoutSignal() {
  return AbortSignal.timeout(config.fetchTimeoutMs);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: options.signal || timeoutSignal() });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return response.json();
}

function canonicalPath(pathname) {
  return pathname.replace(/^\/(?:ru|en|kk)(?=\/)/i, '') || '/';
}

function allowedHosts() {
  const host = new URL(config.sitePublicUrl).hostname.toLowerCase();
  return new Set([host, host.startsWith('www.') ? host.slice(4) : `www.${host}`]);
}

export function parseSearchUrl(input) {
  let value = String(input || '').trim();
  if (!value) throw new Error('empty_url');
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  const url = new URL(value);
  if (!allowedHosts().has(url.hostname.toLowerCase())) throw new Error('invalid_host');
  const originalPath = url.pathname.replace(/\/$/, '') || '/';
  const path = canonicalPath(originalPath);
  const kind = path === '/flat-finder' ? 'flats' : path === '/jobs' ? 'jobs' : path === '/hiring' ? 'candidates' : null;
  if (!kind) throw new Error('invalid_path');
  const filters = {};
  for (const [key, val] of url.searchParams.entries()) {
    if (!UI_ONLY.has(key) && val !== '') filters[key] = val;
  }
  const canonical = new URL(config.sitePublicUrl);
  canonical.pathname = originalPath;
  canonical.search = new URLSearchParams(filters).toString();
  return { kind, filters, searchUrl: canonical.toString() };
}

export function allResultsSearch(kind) {
  const path = kind === 'flats' ? '/flat-finder' : kind === 'jobs' ? '/jobs' : '/hiring';
  const url = new URL(path, `${config.sitePublicUrl}/`);
  return { kind, filters: {}, searchUrl: url.toString() };
}

function stringParams(filters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters || {})) {
    if (value != null && value !== '') params.set(key, String(value));
  }
  return params;
}

async function jobApiParams(filters) {
  const ui = { ...(filters || {}) };
  const params = new URLSearchParams();
  const passthrough = ['q', 'source', 'country', 'cities', 'workMode', 'relocation', 'language', 'skills'];
  for (const key of passthrough) if (ui[key]) params.set(key, String(ui[key]));
  if (ui.includeRu === '1') params.set('includeRu', 'true');
  if (ui.includeBy === '1') params.set('includeBy', 'true');
  if (ui.employment) params.set('employmentKind', String(ui.employment));
  if (ui.hasSalary === '1') params.set('hasSalary', 'true');
  if (ui.maxExp) params.set('maxExperienceYears', String(ui.maxExp));
  if (ui.foreigner === '1') params.set('foreignerFriendly', 'true');
  if (ui.hideRisky === '0') params.set('hideRiskyIndustries', 'false');
  if (ui.noExp === '1') params.set('noExperience', 'true');
  if (ui.level) params.set('languageLevel', String(ui.level));
  if (ui.exclLang) params.set('excludeLanguage', String(ui.exclLang));

  if (ui.salaryMin) {
    const amount = Number(ui.salaryMin);
    if (Number.isFinite(amount) && amount > 0) {
      const currency = String(ui.currency || 'USD').toUpperCase();
      const period = Object.hasOwn(PERIOD_TO_YEAR, ui.period) ? ui.period : 'month';
      const rateResult = await fetchJson(`${config.siteBaseUrl}/jobs-feed?page=1&pageSize=1`);
      const rates = rateResult?.rates || {};
      const fromRate = Number(rates[currency]);
      const usdRate = Number(rates.USD || 1);
      if (fromRate > 0 && usdRate > 0) {
        const usd = (amount * fromRate) / usdRate;
        params.set('salaryMin', String(Math.round(usd * PERIOD_TO_YEAR[period])));
      }
    }
  }

  // Sorting is presentation state, not a subscription predicate. Always read newest
  // first so a newly published match cannot hide beyond a price/title-sorted page.
  params.set('sort', 'date');
  params.set('page', '1');
  params.set('pageSize', '100');
  return params;
}

function flatApiParams(filters) {
  const params = stringParams(filters);
  params.delete('currency');
  if ((filters?.priceMin || filters?.priceMax)) params.set('priceCurrency', String(filters.currency || 'USD'));
  params.set('limit', '60');
  params.set('offset', '0');
  // The web page defaults to both legacy sources; the proxy interprets this as all
  // current apartment sources, including Facebook/Threads.
  if (!params.has('sources')) params.set('sources', 'olx,telegram');
  // As with jobs, sorting does not define membership in the subscription.
  params.set('sort', 'newest');
  return params;
}

function candidateApiParams(filters) {
  const params = stringParams(filters);
  params.set('limit', '60');
  params.set('offset', '0');
  return params;
}

function absolutePublicUrl(value) {
  if (!value) return null;
  try {
    return new URL(String(value), `${config.sitePublicUrl}/`).toString();
  } catch {
    return null;
  }
}

function normalizeFlat(item) {
  return {
    ...item,
    photo: absolutePublicUrl(item.photo),
    photos: Array.isArray(item.photos) ? item.photos.map(absolutePublicUrl).filter(Boolean) : [],
  };
}

export function itemKey(kind, item) {
  if (kind === 'flats') return `${String(item.source || 'unknown').toLowerCase()}:${String(item.country || '').toUpperCase()}:${String(item.id || item.url || '')}`;
  if (kind === 'jobs') return String(item.id || item.url || item.applyUrl || '');
  return `${String(item.sourceKey || item.origin || item.source || 'unknown').toLowerCase()}:${String(item.country || '').toUpperCase()}:${String(item.id || item.url || '')}`;
}

export function itemCreatedAt(kind, item) {
  const raw = kind === 'jobs' ? item.postedAt : item.createdAt;
  const time = raw ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(time) ? time : null;
}

export async function fetchSubscriptionItems(subscription) {
  if (subscription.kind === 'flats') {
    const params = flatApiParams(subscription.filters);
    const data = await fetchJson(`${config.siteBaseUrl}/flats-feed?${params}`);
    return Array.isArray(data?.listings) ? data.listings.map(normalizeFlat) : [];
  }
  if (subscription.kind === 'jobs') {
    const params = await jobApiParams(subscription.filters);
    const data = await fetchJson(`${config.siteBaseUrl}/jobs-feed?${params}`);
    return Array.isArray(data?.jobs) ? data.jobs : [];
  }
  const params = candidateApiParams(subscription.filters);
  const data = await fetchJson(`${config.siteBaseUrl}/hiring-feed?${params}`);
  return Array.isArray(data?.profiles) ? data.profiles : [];
}

export async function flatAvailability(item) {
  if (String(item?.source || '').toLowerCase() !== 'olx') return { status: 'feed_active' };
  try {
    const data = await fetchJson(`${config.flatApiUrl}/api/listings/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ source: 'olx', country: item.country, id: String(item.id) }] }),
    });
    return data?.results?.[0] || { status: 'unchecked' };
  } catch (error) {
    console.warn('[subscription-bot] availability read failed:', error.message);
    return { status: 'unknown', reason: 'verify_api_error' };
  }
}

export function filterSummary(filters, max = 6) {
  const entries = Object.entries(filters || {}).filter(([, value]) => value != null && value !== '');
  if (!entries.length) return '—';
  const shown = entries.slice(0, max).map(([key, value]) => `${key}=${String(value)}`);
  if (entries.length > max) shown.push(`+${entries.length - max}`);
  return shown.join(', ');
}
