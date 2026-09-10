// Individual-site filtering for the curated "custom" source bucket.
//
// The three curated registries (external/owner/realtor-housing-sources.js)
// enumerate scraper catalogues, several of which share one domain (e.g. kn.kz
// has one catalogue per city). This module collapses that down to one entry
// per domain -- what the UI shows as a single toggle -- and maps a domain
// back to every catalogue URL it covers, since `customSourceUrl` on stored
// listings is the exact catalogue URL, not a bare domain.
import {externalHousingSources, EXTERNAL_HOUSING_SOURCES} from './external-housing-sources.js';
import {ownerHousingSources, OWNER_HOUSING_SOURCES} from './owner-housing-sources.js';
import {realtorHousingSources, REALTOR_HOUSING_SOURCES} from './realtor-housing-sources.js';

const REGISTRIES = [
  EXTERNAL_HOUSING_SOURCES,
  OWNER_HOUSING_SOURCES,
  REALTOR_HOUSING_SOURCES,
];

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

// domain -> {domain, urls: Set<string>, countries: Set<string>}
function buildDomainIndex() {
  const index = new Map();
  for (const registry of REGISTRIES) {
    for (const [countryCode, sources] of Object.entries(registry)) {
      for (const source of sources) {
        const domain = domainOf(source.url);
        if (!domain) continue;
        if (!index.has(domain)) {
          index.set(domain, {domain, urls: new Set(), countries: new Set()});
        }
        const entry = index.get(domain);
        entry.urls.add(source.url);
        entry.countries.add(countryCode);
      }
    }
  }
  return index;
}

const DOMAIN_INDEX = buildDomainIndex();

/** Every domain covered by the curated custom-source registries, sorted. */
export function listCustomSiteDomains() {
  return [...DOMAIN_INDEX.values()]
    .map(({domain, countries}) => ({domain, countries: [...countries].sort()}))
    .sort((a, b) => a.domain.localeCompare(b.domain));
}

/** Whether `domain` is a recognized curated custom site. */
export function isKnownCustomSiteDomain(domain) {
  return DOMAIN_INDEX.has(domain);
}

/**
 * The exact catalogue URLs behind the given domains, as stored in each
 * listing's `customSourceUrl`. Unknown domains contribute nothing.
 */
export function customSourceUrlsForDomains(domains) {
  const urls = new Set();
  for (const domain of domains) {
    const entry = DOMAIN_INDEX.get(domain);
    if (!entry) continue;
    for (const url of entry.urls) urls.add(url);
  }
  return [...urls];
}

// Exposed for tests that want to check every registry stayed reachable.
export {externalHousingSources, ownerHousingSources, realtorHousingSources};
