import { COUNTRIES } from './countries.js';
import { markMissingAfterCompleteCrawl, upsertListings } from './infrastructure/database/listingRepository.js';
import { deleteListingDocuments, indexListings } from './infrastructure/search/elasticsearch.js';
import { scrapeFacebook, scrapeThreads } from './scrapers/social.js';
import { buildThreadsHousingCoverage, rotatingCoverage } from './social-search-coverage.js';

const SOCIAL_REFRESH_MINUTES = Math.max(10, Number(process.env.SOCIAL_HOUSING_REFRESH_MINUTES) || 30);
const SOCIAL_REFRESH_MS = SOCIAL_REFRESH_MINUTES * 60 * 1000;
const START_DELAY_MS = Math.max(5_000, Number(process.env.SOCIAL_HOUSING_START_DELAY_MS) || 20_000);
const THREADS_QUERIES_PER_CYCLE = Math.max(
  4,
  Math.min(30, Number(process.env.SOCIAL_HOUSING_THREADS_QUERIES_PER_CYCLE) || 12),
);

let timer = null;
let running = false;

const DEFAULT_FACEBOOK_TARGETS = {
  UZ: [
    { target: 'https://www.facebook.com/groups/antimakler/', city: 'Tashkent' },
    { target: 'https://www.facebook.com/groups/741615396187925/', city: 'Tashkent' },
    { target: 'https://www.facebook.com/groups/281140502050492/', city: 'Tashkent' },
    { target: 'https://www.facebook.com/groups/kvartira/', city: 'Tashkent' },
    { target: 'https://www.facebook.com/groups/SvoyDomTashkent/', city: 'Tashkent' },
    { target: 'https://www.facebook.com/groups/1634005426616533/', city: 'Tashkent' },
    { target: 'https://www.facebook.com/groups/rent.let/', city: 'Tashkent' },
    { target: 'https://www.facebook.com/groups/Pro100Arenda/', city: 'Tashkent' },
    { target: 'https://www.facebook.com/groups/1116133552576343/', city: 'Tashkent' },
    { target: 'https://www.facebook.com/groups/1647978165496858/', city: 'Tashkent' },
    { target: 'https://www.facebook.com/groups/m2hubuzbekistan/', city: 'Tashkent' },
    { target: 'https://www.facebook.com/groups/238576114433292/', city: 'Tashkent' },
    { target: 'https://www.facebook.com/groups/973227684005877/' },
  ],
  UA: [
    { target: 'https://www.facebook.com/groups/rieltory.zlo/', city: 'Kyiv' },
    { target: 'https://www.facebook.com/groups/445199492349490/', city: 'Kyiv' },
    { target: 'https://www.facebook.com/groups/1500652316919278/', city: 'Kyiv' },
    { target: 'https://www.facebook.com/groups/RealEstateOfKyivSuburbanWithoutACommission/', city: 'Kyiv' },
    { target: 'https://www.facebook.com/groups/rentinKyiv/', city: 'Kyiv' },
  ],
  RO: [
    { target: 'https://www.facebook.com/groups/490489845820582/', city: 'Bucharest' },
    { target: 'https://www.facebook.com/groups/811213449802942/', city: 'Bucharest' },
    { target: 'https://www.facebook.com/groups/1263583490833503/', city: 'Bucharest' },
    { target: 'https://www.facebook.com/groups/658860528761062/', city: 'Bucharest' },
    { target: 'https://www.facebook.com/groups/661893508190887/', city: 'Brasov' },
  ],
  KZ: [
    { target: 'https://www.facebook.com/groups/1317985588227312/', city: 'Almaty' },
    { target: 'https://www.facebook.com/www.ARENDA.kz/' },
    { target: 'https://www.facebook.com/groups/991328870989902/', city: 'Almaty' },
  ],
};

function normalizedFacebookTarget(value) {
  if (typeof value === 'string') {
    const target = value.trim();
    return target ? {target} : null;
  }
  if (!value || typeof value !== 'object') return null;
  const target = String(value.target || value.url || '').trim();
  if (!target) return null;
  return {
    target,
    ...(value.city ? {city: String(value.city)} : {}),
    ...(value.dealType ? {dealType: String(value.dealType)} : {}),
  };
}

function configuredFacebookTargets() {
  const merged = Object.fromEntries(
    Object.entries(DEFAULT_FACEBOOK_TARGETS).map(([country, targets]) => [country, [...targets]]),
  );
  const raw = String(process.env.SOCIAL_HOUSING_FACEBOOK_TARGETS_JSON || '').trim();
  if (!raw) return merged;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(`[social-housing] invalid SOCIAL_HOUSING_FACEBOOK_TARGETS_JSON: ${error.message}`);
    return merged;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn('[social-housing] SOCIAL_HOUSING_FACEBOOK_TARGETS_JSON must be an object keyed by country code');
    return merged;
  }

  for (const [countryRaw, values] of Object.entries(parsed)) {
    const country = String(countryRaw).toUpperCase();
    if (!COUNTRIES[country] || !Array.isArray(values)) continue;
    const normalized = values.map(normalizedFacebookTarget).filter(Boolean);
    if (!normalized.length) continue;
    const existing = merged[country] || [];
    const seen = new Set(existing.map((item) => String(item.target).toLowerCase()));
    for (const item of normalized) {
      const key = item.target.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      existing.push(item);
    }
    merged[country] = existing;
  }

  return merged;
}

function countryConfig(code, { facebookHousingTargets = [], threadsHousingQueries = [] } = {}) {
  return {
    ...(COUNTRIES[code] || {}),
    code,
    facebookHousingTargets,
    threadsHousingQueries,
  };
}

function selectedThreadsByCountry() {
  const all = buildThreadsHousingCoverage();
  const selected = rotatingCoverage(all, {
    maxPerCycle: THREADS_QUERIES_PER_CYCLE,
    slotMinutes: SOCIAL_REFRESH_MINUTES,
  });
  const grouped = new Map();
  for (const target of selected) {
    const list = grouped.get(target.country) || [];
    list.push(target);
    grouped.set(target.country, list);
  }
  return { all, selected, grouped };
}

async function persist(source, countryCode, result, crawlStartedAt, allowMissingSweep) {
  const listings = Array.isArray(result?.listings) ? result.listings : [];
  let saved = 0;

  if (listings.length) {
    saved = await upsertListings(listings);
    try {
      await indexListings(listings);
    } catch (error) {
      console.warn(`[social-housing] ${source}/${countryCode} Elasticsearch failed: ${error?.message || error}`);
    }
  }

  if (allowMissingSweep && result?.complete === true) {
    try {
      const missing = await markMissingAfterCompleteCrawl({
        source,
        country: countryCode,
        crawlStartedAt,
      });
      if (missing.deactivated?.length) {
        await deleteListingDocuments(missing.deactivated).catch((error) => {
          console.warn(
            `[social-housing] ${source}/${countryCode} deactivation index sync failed: ${error?.message || error}`,
          );
        });
      }
    } catch (error) {
      console.warn(`[social-housing] ${source}/${countryCode} missing-row sweep failed: ${error?.message || error}`);
    }
  } else if (result?.complete !== true) {
    console.warn(
      `[social-housing] ${source}/${countryCode} crawl partial; keeping unseen rows active ` +
      `(errors=${Array.isArray(result?.errors) ? result.errors.length : 0})`,
    );
  }

  return saved;
}

async function refreshFacebook() {
  let total = 0;
  const targetsByCountry = configuredFacebookTargets();
  for (const [countryCode, targets] of Object.entries(targetsByCountry)) {
    if (!targets.length) continue;
    const startedAt = new Date().toISOString();
    try {
      const result = await scrapeFacebook(countryConfig(countryCode, { facebookHousingTargets: targets }));
      const saved = await persist('facebook', countryCode, result, startedAt, true);
      total += saved;
      console.log(
        `[social-housing] Facebook/${countryCode} targets=${targets.length} ` +
        `fetched=${result?.diagnostics?.fetched || 0} classified=${result?.diagnostics?.classified || 0} ` +
        `saved=${saved} errors=${Array.isArray(result?.errors) ? result.errors.length : 0}`,
      );
    } catch (error) {
      console.warn(`[social-housing] Facebook/${countryCode} failed: ${error?.message || error}`);
    }
  }
  return total;
}

async function refreshThreads() {
  const coverage = selectedThreadsByCountry();
  let total = 0;

  for (const [countryCode, targets] of coverage.grouped.entries()) {
    const startedAt = new Date().toISOString();
    try {
      const result = await scrapeThreads(countryConfig(countryCode, { threadsHousingQueries: targets }));
      // Coverage is intentionally rotated: a successful batch is not a complete
      // country crawl, so it must never deactivate listings from other batches.
      const saved = await persist('threads', countryCode, result, startedAt, false);
      total += saved;
      console.log(
        `[social-housing] Threads/${countryCode} queries=${targets.length} ` +
        `fetched=${result?.diagnostics?.fetched || 0} classified=${result?.diagnostics?.classified || 0} ` +
        `saved=${saved} errors=${Array.isArray(result?.errors) ? result.errors.length : 0}`,
      );
    } catch (error) {
      console.warn(`[social-housing] Threads/${countryCode} failed: ${error?.message || error}`);
    }
  }

  console.log(
    `[social-housing] Threads coverage: ${coverage.selected.length}/${coverage.all.length} queries this cycle`,
  );
  return total;
}

export async function refreshSocialHousing(reason = 'scheduled') {
  if (running) return null;
  if (process.env.SOCIAL_HOUSING_SOURCE === 'off') return null;
  running = true;

  try {
    const [facebook, threads] = await Promise.allSettled([
      refreshFacebook(),
      refreshThreads(),
    ]);

    const counts = {
      facebook: facebook.status === 'fulfilled' ? facebook.value : 0,
      threads: threads.status === 'fulfilled' ? threads.value : 0,
    };

    if (facebook.status === 'rejected') {
      console.warn(`[social-housing] Facebook failed: ${facebook.reason?.message || facebook.reason}`);
    }
    if (threads.status === 'rejected') {
      console.warn(`[social-housing] Threads failed: ${threads.reason?.message || threads.reason}`);
    }

    console.log(`[social-housing] ${reason}: facebook=${counts.facebook}, threads=${counts.threads}`);
    return counts;
  } finally {
    running = false;
  }
}

export function startSocialHousingScheduler() {
  if (process.env.SOCIAL_HOUSING_SOURCE === 'off') {
    console.log('[social-housing] disabled via SOCIAL_HOUSING_SOURCE=off');
    return;
  }

  const facebookTargets = configuredFacebookTargets();
  const facebookCountries = Object.entries(facebookTargets).filter(([, targets]) => targets.length).length;
  const facebookCount = Object.values(facebookTargets).reduce((sum, targets) => sum + targets.length, 0);

  const first = setTimeout(
    () => refreshSocialHousing('startup').catch((error) =>
      console.warn(`[social-housing] startup failed: ${error?.message || error}`),
    ),
    START_DELAY_MS,
  );
  first.unref?.();

  timer = setInterval(
    () => refreshSocialHousing('scheduled').catch((error) =>
      console.warn(`[social-housing] scheduled failed: ${error?.message || error}`),
    ),
    SOCIAL_REFRESH_MS,
  );
  timer.unref?.();

  console.log(
    `[social-housing] refresh every ${SOCIAL_REFRESH_MINUTES} min; ` +
    `Facebook targets=${facebookCount} countries=${facebookCountries}; ` +
    `Threads queries/cycle=${THREADS_QUERIES_PER_CYCLE}`,
  );
}
