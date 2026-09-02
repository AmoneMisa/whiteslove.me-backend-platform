import { resolveHousingIntent } from '@whiteslove/parsing-lexicon/housing-intent';
import { parseHousingSeller } from '@whiteslove/parsing-lexicon/housing-structured';
import { resolveHousingPropertyType } from '@whiteslove/parsing-lexicon/housing';
import { makeListing } from '../normalize.js';
import { MAX_AGE_MS } from '../listing-policy.js';
import {
  parsePriceFromText,
  parseRoomsFromText,
  parseAreaFromText,
} from '../textparse.js';

const SOCIAL_FETCHER_URL = String(process.env.SOCIAL_FETCHER_URL || '').replace(/\/$/, '');
const SOCIAL_TIMEOUT_MS = Math.max(30_000, Math.min(170_000, Number(process.env.SOCIAL_HOUSING_TIMEOUT_MS) || 150_000));
const SOCIAL_LIMIT = Math.max(5, Math.min(100, Number(process.env.SOCIAL_HOUSING_LIMIT) || 40));

// Social captions are less structured than portal listings. Keep this fallback
// deliberately narrow: a short-stay marker must appear with a housing noun.
// The package intent resolver remains the primary classifier and wanted posts are
// rejected before this fallback is considered.
const SHORT_RENT_MARKER_RE = /(?:посуточ|погодин|подобов|на\s+сутк|за\s+добу|за\s+сутк|kunlik|sutkalik|кунлик|суткалик|тәулік|тәуліктік|regim\s+hotelier|pe\s+noapte|termen\s+scurt)/iu;
const HOUSING_CONTEXT_RE = /(?:квартир|апартамент|apartament|garsonier|studio|kvartira|пәтер|\buy\b|\bуй\b|xona|хона|житл|жиль)/iu;

function housingIntent(value) {
  return resolveHousingIntent(String(value || '').replace(/[ \t]+/g, ' ').trim());
}

function isHousingWanted(intent) {
  return intent?.listingKind === 'propertyWanted';
}

function looksShortRentOffer(value) {
  return SHORT_RENT_MARKER_RE.test(value) && HOUSING_CONTEXT_RE.test(value);
}

function socialTarget(value) {
  if (typeof value === 'string') return { target: value, city: null, dealType: null };
  if (value && typeof value === 'object') {
    return {
      target: String(value.target || value.url || value.query || '').trim(),
      city: value.city ? String(value.city) : null,
      dealType: value.dealType ? String(value.dealType) : null,
    };
  }
  return null;
}

export function classifyHousingOffer(text, forced = null) {
  const value = String(text || '').replace(/[ \t]+/g, ' ').trim();
  if (value.length < 12) return null;

  const intent = housingIntent(value);
  if (isHousingWanted(intent)) return null;
  if (intent?.dealType === 'shortRent' || looksShortRentOffer(value)) return forced || 'shortRent';
  if (!intent?.dealType) return null;
  return forced || intent.dealType;
}

function itemToListing(item, source, targetConfig, country) {
  const text = String(item?.text || '').replace(/[ \t]+/g, ' ').trim();
  const dealType = classifyHousingOffer(text, targetConfig.dealType);
  if (!dealType) return null;

  const createdAt = item?.createdAt || null;
  if (createdAt) {
    const ts = Date.parse(createdAt);
    if (Number.isFinite(ts) && Date.now() - ts > MAX_AGE_MS) return null;
  }

  const { amount: price, currency } = parsePriceFromText(text, country.currency);
  const id = String(item?.id || item?.url || '').trim();
  if (!id) return null;

  return makeListing({
    id: `${source}-${id}`,
    source,
    country: country.code,
    title: text.split('\n')[0].slice(0, 90),
    description: text,
    propertyType: resolveHousingPropertyType(text),
    byAgency: parseHousingSeller(text).type === 'agency',
    price,
    currency,
    rooms: parseRoomsFromText(text),
    areaSqm: parseAreaFromText(text),
    city: targetConfig.city,
    lat: null,
    lng: null,
    photos: Array.isArray(item?.images) ? item.images.filter(Boolean) : [],
    dealType,
    url: item?.url || targetConfig.target,
    createdAt,
  });
}

async function fetchSocial(path, body) {
  if (!SOCIAL_FETCHER_URL) throw new Error('SOCIAL_FETCHER_URL is not configured');
  const response = await fetch(`${SOCIAL_FETCHER_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SOCIAL_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `social-fetcher HTTP ${response.status}`);
  }
  return Array.isArray(payload?.items) ? payload.items : [];
}

async function scrapeTargets(country, source, values) {
  const configs = (values || []).map(socialTarget).filter((value) => value?.target);
  const listings = [];
  const errors = [];
  let rawItems = 0;
  let recentItems = 0;
  let rejectedDemand = 0;

  for (const config of configs) {
    try {
      const items = source === 'threads'
        ? await fetchSocial('/threads/search', { query: config.target, limit: SOCIAL_LIMIT })
        : await fetchSocial('/fetch', { source: 'facebook', target: config.target, limit: SOCIAL_LIMIT });

      rawItems += items.length;
      for (const item of items) {
        const text = String(item?.text || '');
        if (isHousingWanted(housingIntent(text))) rejectedDemand += 1;
        const ts = item?.createdAt ? Date.parse(item.createdAt) : NaN;
        if (!Number.isFinite(ts) || Date.now() - ts <= MAX_AGE_MS) recentItems += 1;
        const listing = itemToListing(item, source, config, country);
        if (listing) listings.push(listing);
      }
    } catch (error) {
      const message = error?.message || String(error);
      errors.push({ target: config.target, error: message });
      console.warn(`[${source}:housing] ${config.target}: ${message}`);
    }
  }

  const complete = errors.length === 0 && (configs.length === 0 || rawItems > 0);

  return {
    listings,
    complete,
    partialExpected: !complete,
    errors,
    rawItems,
    diagnostics: {
      fetched: rawItems,
      recent: recentItems,
      classified: listings.length,
      rejectedDemand,
    },
    processedTargets: configs.map((config) => config.target),
  };
}

export async function scrapeFacebook(country) {
  return scrapeTargets(country, 'facebook', country.facebookHousingTargets);
}

export async function scrapeThreads(country) {
  return scrapeTargets(country, 'threads', country.threadsHousingQueries);
}
