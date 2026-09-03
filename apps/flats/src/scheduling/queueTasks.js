import { COUNTRIES } from '../geo/countries.js';
import { makeListing } from '../listing/normalize.js';
import { resolveHousingIntent } from '@whiteslove/parsing-lexicon/housing-intent';
import { parseHousingSeller } from '@whiteslove/parsing-lexicon/housing-structured';
import { resolveHousingPropertyType } from '@whiteslove/parsing-lexicon/housing';
import { isDirectOwner } from '@whiteslove/parsing-lexicon/housing-commercial';
import { fetchChannel } from '../scrapers/telegram.js';
import { scrapeCustomUrl } from '../scrapers/custom.js';
import { telegramHousingChannels } from '../sources/telegram-housing-sources.js';
import { throttle } from '../support/ratelimit.js';
import { upsertListings } from '../infrastructure/database/listingRepository.js';
import { indexListings } from '../infrastructure/search/elasticsearch.js';
import { executeQueueTaskOnce } from '../infrastructure/queue/queueTaskDedup.js';
import { geocodeListingsPersistent } from '../geo/geocode-persistent.js';
import { rejectOutOfAreaCoordinates } from '../geo/coordinate-validation.js';
import { reconcileAuthoritativeOlxSegment } from '../sources/crawl-reconciliation.js';
import { olxSegmentDealType } from '../geo/olx-segment.js';
import { deactivateMissingCustomSourceListings } from '../infrastructure/database/customSourceRepository.js';
import { scheduleListingsVision } from '../listing/vision-enrichment.js';
import { scheduleListingsAi } from '../listing/ai-enrichment.js';

const OLX_FETCHER_URL = String(process.env.OLX_FETCHER_URL || '').replace(/\/$/, '');
const OLX_FETCHER_URLS = [
  String(process.env.OLX_FETCHER_URL_0 || '').replace(/\/$/, ''),
  String(process.env.OLX_FETCHER_URL_1 || '').replace(/\/$/, ''),
];
const OLX_MIN_INTERVAL_MS = Number(process.env.OLX_MIN_INTERVAL_MS) || 900;
const OLX_JITTER_MS = Number(process.env.OLX_JITTER_MS) || 500;
const OLX_QUEUE_MAX_PAGES = Math.max(
  1,
  Number(process.env.OLX_QUEUE_MAX_PAGES) || 1000,
);

function stateParam(item, keyRe, nameRe) {
  for (const param of item.params ?? []) {
    if (
      (param.key && keyRe.test(param.key)) ||
      (param.name && nameRe.test(param.name))
    ) {
      return param.value;
    }
  }
  return null;
}

function stateRooms(item) {
  const raw = stateParam(
    item,
    /room|komnat|kimnat|xonali|kolichestvo/i,
    /комнат|кімнат|room|xonali|спал/i,
  );

  let rooms = raw != null
    ? Number(String(raw).match(/\d+/)?.[0])
    : null;

  if (!rooms) {
    const match = (item.title || '').match(
      /(\d+)\s*[-хx]?\s*(?:camer|комнатн|комн|кімнат|кімн|room|bedroom|xonali|xona)/i,
    );
    rooms = match ? Number(match[1]) : null;
  }

  if (rooms != null && (rooms < 1 || rooms > 10)) {
    return null;
  }

  return rooms || null;
}

function stateArea(item) {
  const raw = stateParam(
    item,
    /area|m2|total_area|ploshch|maydon|kvadrat/i,
    /площад|area|m²|кв\.?\s*м|maydon|майдон/i,
  );

  const value = raw != null
    ? Number(String(raw).replace(',', '.').match(/\d+(?:\.\d+)?/)?.[0])
    : null;

  return value || null;
}

function normalizeCurrency(code) {
  if (!code) return null;
  const normalized = String(code).toUpperCase();
  return ['UYE', 'У.Е.', 'УЕ'].includes(normalized)
    ? 'USD'
    : code;
}

function mapOlxStateItem(item, country, forcedCity = null, forcedDealType = null) {
  const regularPrice = item.price?.regularPrice ?? {};
  const paramText = (item.params ?? [])
    .map((param) => `${param.name ?? ''} ${Array.isArray(param.value) ? param.value.join(' ') : param.value ?? ''}`)
    .join(' ');

  const listing = makeListing({
    id: item.id,
    source: 'olx',
    country: country.code,
    title: item.title,
    description: item.description ?? '',
    propertyType: resolveHousingPropertyType(`${item.title || ''} ${paramText}`),
    byAgency: Boolean(item.isBusiness),
    price: regularPrice.value ?? null,
    currency: normalizeCurrency(regularPrice.currencyCode) ?? country.currency,
    rooms: stateRooms(item),
    areaSqm: stateArea(item),
    city: item.location?.cityName ?? item.location?.regionName ?? '',
    district: item.location?.districtName ?? null,
    lat: item.map?.lat ?? null,
    lng: item.map?.lon ?? null,
    photos: Array.isArray(item.photos) ? item.photos.filter(Boolean) : [],
    dealType: forcedDealType,
    url: item.url ?? country.olxHost,
    createdAt: item.createdTime ?? null,
  });

  if (forcedCity) {
    listing.city = forcedCity;
  }

  return listing;
}

function olxFetcherUrl(crawlerShard) {
  const shard = Math.max(0, Math.trunc(Number(crawlerShard) || 0));
  return OLX_FETCHER_URLS[shard] || OLX_FETCHER_URL;
}

async function fetchOlxPage({ country, segment, page, citySlug, city, crawlerShard }) {
  const fetcherUrl = olxFetcherUrl(crawlerShard);
  if (!fetcherUrl) {
    throw new Error('OLX_FETCHER_URL is not configured');
  }

  const config = COUNTRIES[country];
  if (!config) {
    throw new Error(`Unknown country ${country}`);
  }

  await throttle(
    `queue:olx:${config.olxHost}:shard:${crawlerShard ?? 0}`,
    OLX_MIN_INTERVAL_MS,
    OLX_JITTER_MS,
  );

  const params = new URLSearchParams({
    country,
    segment,
    page: String(page),
  });

  if (citySlug) {
    params.set('city', citySlug);
  }

  const response = await fetch(
    `${fetcherUrl}/olx/listings?${params}`,
    { signal: AbortSignal.timeout(60_000) },
  );

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      detail = (await response.json())?.error || detail;
    } catch {}
    throw new Error(
      `OLX shard=${crawlerShard ?? 0} ${country}/${segment}/${citySlug || 'all'}/page-${page}: ${detail}`,
    );
  }

  const body = await response.json();
  const ads = Array.isArray(body?.ads) ? body.ads : [];
  const forcedDealType = olxSegmentDealType(segment);

  return {
    listings: ads
      .filter((item) => item?.id != null)
      .map((item) => mapOlxStateItem(item, config, city || null, forcedDealType)),
    rawCount: Number.isFinite(Number(body?.rawCount))
      ? Number(body.rawCount)
      : ads.length,
    pastCutoff: body?.pastCutoff === true,
    lookbackDays: Number(body?.lookbackDays) || null,
    cutoffAt: body?.cutoffAt || null,
    oldestKnownAt: body?.oldestKnownAt || null,
    newestKnownAt: body?.newestKnownAt || null,
    unknownDateCount: Number(body?.unknownDateCount) || 0,
  };
}

function findTelegramChannel(country, name) {
  const config = COUNTRIES[country];
  if (!config) return null;

  for (const value of telegramHousingChannels(country, config.telegramChannels ?? [])) {
    const channel = typeof value === 'string'
      ? { name: value, city: null, dealType: null }
      : value;

    if (String(channel?.name || '').toLowerCase() === name.toLowerCase()) {
      return channel;
    }
  }

  return null;
}

function hasMarker(text, markers) {
  if (!Array.isArray(markers) || !markers.length) return false;
  const haystack = String(text || '').toLocaleLowerCase();
  return markers.some((marker) => haystack.includes(String(marker || '').toLocaleLowerCase()));
}

export function enforceOwnerOnlyListings(listings, policy = {}) {
  if (!Array.isArray(listings)) return [];
  if (policy.ownerOnly !== true) return listings;

  return listings
    .filter((listing) => {
      const text = `${listing?.title || ''}\n${listing?.description || ''}`.trim();
      if (!text || resolveHousingIntent(text)?.listingKind === 'propertyWanted') return false;
      if (hasMarker(text, policy.ownerRejectMarkers)) return false;

      const ownerMarker = hasMarker(text, policy.ownerMarkers);
      const directOwner = ownerMarker || isDirectOwner(text);
      if (listing?.byAgency === true && !directOwner) return false;
      if (parseHousingSeller(text).type === 'agency' && !directOwner) return false;

      if (Array.isArray(policy.ownerMarkers) && policy.ownerMarkers.length) {
        return directOwner;
      }

      return true;
    })
    .map((listing) => ({
      ...listing,
      byAgency: false,
      commission: false,
      commissionPercent: 0,
      dealType: listing.dealType || policy.dealType || null,
    }));
}

async function persist(listings, task) {
  if (!Array.isArray(listings) || !listings.length) {
    return { saved: 0, indexed: 0 };
  }

  const country = String(task?.country || listings[0]?.country || '').toUpperCase();
  const config = COUNTRIES[country];
  if (config) {
    await geocodeListingsPersistent(listings, config);
  }

  const saved = await upsertListings(listings);
  let indexed = 0;

  try {
    indexed = await indexListings(listings);
  } catch (error) {
    console.warn(
      `[queue:${task.type}] Elasticsearch indexing failed: ${error?.message ?? error}`,
    );
  }

  scheduleListingsVision(listings);
  if (config) scheduleListingsAi(listings, config, (merged) => persistAiMerged(merged, config, task));

  return { saved, indexed };
}

/**
 * Stores one listing enriched by the text model. Geocoding has already run by
 * the time an answer arrives, so a district/kvartal the model recovered is only
 * useful if the listing is placed again — and only when it still has no point,
 * so a resolved coordinate is never re-derived from weaker evidence.
 */
async function persistAiMerged(merged, config, task) {
  try {
    const filledGeography = (merged?.ai?.derivedFields || []).some(
      (field) => field === 'district' || field === 'kvartal',
    );
    const unplaced = merged?.lat == null || merged?.lng == null;
    if (filledGeography && unplaced) {
      await geocodeListingsPersistent([merged], config);
    }

    await upsertListings([merged]);
    await indexListings([merged]);
  } catch (error) {
    console.warn(
      `[queue:${task?.type}] AI enrichment persistence failed: ${error?.message ?? error}`,
    );
  }
}

function nextOlxTask(task, pageResult, page) {
  if (
    pageResult.pastCutoff ||
    pageResult.rawCount <= 0 ||
    page >= OLX_QUEUE_MAX_PAGES
  ) {
    return null;
  }

  const nextPage = page + 1;
  return {
    type: 'flat.olx.page',
    country: String(task.country || '').toUpperCase(),
    city: task.city || null,
    citySlug: task.citySlug || null,
    segment: String(task.segment || ''),
    page: nextPage,
    priority: Math.max(1, 7 - nextPage),
    ownerOnly: task.ownerOnly === true,
    queueProtocol: task.queueProtocol,
    crawlGeneration: task.crawlGeneration,
    crawlerShard: task.crawlerShard,
  };
}

async function processQueueTaskInner(task) {
  const type = String(task?.type || '');
  const country = String(task?.country || '').toUpperCase();

  if (!COUNTRIES[country]) {
    throw new Error(`Unsupported country ${country || '<empty>'}`);
  }

  if (type === 'flat.olx.page') {
    const segment = String(task.segment || '');
    if (!['flat:longRent', 'flat:shortRent', 'flat:sale'].includes(segment)) {
      throw new Error(`Unsupported OLX segment ${segment}`);
    }

    const page = Math.max(1, Math.trunc(Number(task.page) || 1));
    const pageResult = await fetchOlxPage({
      country,
      segment,
      page,
      citySlug: task.citySlug ? String(task.citySlug) : null,
      city: task.city ? String(task.city) : null,
      crawlerShard: task.crawlerShard,
    });

    if (task.ownerOnly === true) {
      pageResult.listings = enforceOwnerOnlyListings(pageResult.listings, {
        ownerOnly: true,
        ownerMarkers: ['proprietar', 'direct proprietar', 'fără comision', 'fara comision'],
        dealType: olxSegmentDealType(segment),
      });
    }

    const rejected = await rejectOutOfAreaCoordinates(
      pageResult.listings,
      COUNTRIES[country],
      { areaHint: task.citySlug ? String(task.citySlug) : null },
    );

    const nextTask = nextOlxTask(task, pageResult, page);
    const persisted = await persist(pageResult.listings, task);

    let reconciliation = null;
    if (!nextTask && !task.citySlug && task.crawlGeneration) {
      reconciliation = await reconcileAuthoritativeOlxSegment({
        country,
        segment,
        crawlGeneration: task.crawlGeneration,
      });
    }

    return {
      ok: true,
      type,
      country,
      city: task.city || null,
      segment,
      page,
      crawlerShard: task.crawlerShard,
      crawlGeneration: task.crawlGeneration,
      fetched: pageResult.listings.length,
      rawCount: pageResult.rawCount,
      pastCutoff: pageResult.pastCutoff,
      lookbackDays: pageResult.lookbackDays,
      cutoffAt: pageResult.cutoffAt,
      oldestKnownAt: pageResult.oldestKnownAt,
      newestKnownAt: pageResult.newestKnownAt,
      unknownDateCount: pageResult.unknownDateCount,
      repairedCoordinates: rejected.length,
      nextTasks: nextTask ? [nextTask] : [],
      reconciliation: reconciliation
        ? {
            reconciled: reconciliation.reconciled,
            dealType: reconciliation.dealType || null,
            startedAt: reconciliation.startedAt || null,
            deactivated: reconciliation.deactivated?.length || 0,
            reason: reconciliation.reason || null,
          }
        : null,
      ...persisted,
    };
  }

  if (type === 'flat.telegram.channel') {
    const channelName = String(task.channel || '');
    const channel = findTelegramChannel(country, channelName);
    if (!channel) {
      throw new Error(`Unknown Telegram channel ${country}/@${channelName}`);
    }

    const fetchedListings = await fetchChannel(
      channel,
      COUNTRIES[country],
      {},
      Date.now() + 120_000,
    );
    const listings = enforceOwnerOnlyListings(fetchedListings, channel);

    return {
      ok: true,
      type,
      country,
      channel: channelName,
      crawlerShard: task.crawlerShard,
      crawlGeneration: task.crawlGeneration,
      fetched: listings.length,
      nextTasks: [],
      ...(await persist(listings, task)),
    };
  }

  if (type === 'flat.custom.url') {
    const sourceUrl = String(task.url || '').trim();
    if (!sourceUrl) {
      throw new Error('Missing custom source URL');
    }

    const crawlStartedAt = new Date().toISOString();
    const fetchedListings = await scrapeCustomUrl(sourceUrl, COUNTRIES[country]);
    const ownerFiltered = enforceOwnerOnlyListings(fetchedListings, task);
    const listings = ownerFiltered.map((listing) => ({
      ...listing,
      source: 'custom',
      country,
      city: listing.city || task.city || '',
      customSourceUrl: sourceUrl,
      curatedSource: task.curated === true,
      dealType: listing.dealType || task.dealType || null,
    }));
    const persisted = await persist(listings, task);
    const deactivated = await deactivateMissingCustomSourceListings({
      country,
      sourceUrl,
      crawlStartedAt,
    });

    return {
      ok: true,
      type,
      country,
      url: sourceUrl,
      crawlGeneration: task.crawlGeneration,
      fetched: listings.length,
      deactivated,
      nextTasks: [],
      ...persisted,
    };
  }

  throw new Error(`Unsupported queue task type ${type || '<empty>'}`);
}

export async function processQueueTask(task) {
  return executeQueueTaskOnce(
    task,
    () => processQueueTaskInner(task),
  );
}
