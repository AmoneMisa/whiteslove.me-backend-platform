// Semantic text enrichment for listings, via the shared ai-worker.
//
// The deterministic lexicon parser stays authoritative. This layer only fills
// fields the parser left empty, because free-text posts routinely state things
// in phrasings no regex covers. If inference is unavailable, slow or
// low-confidence, listings keep exactly what the parser produced.
//
// Geography is the one place where a plausible guess is worse than nothing, so
// an AI district/kvartal is accepted only when it canonicalizes through the
// same location dictionary the deterministic path uses. A free-text place name
// is never written to a listing.

import {
  aiFingerprint,
  aiWorkerEnabled,
  scheduleAiExtraction,
} from '../support/ai-worker.js';
import {
  canonicalDictionaryDistrict,
  dictionaryLocationLists,
} from '../geo/location-dictionary-resolver.js';
import { newestFirst } from './enrichment-priority.js';

// Bump when prompts, schema or the merge rules change, so already-enriched
// listings are re-evaluated instead of keeping an answer from the old contract.
export const APARTMENT_PARSER_VERSION = 'apartment-semantic-v2';

const MIN_CONFIDENCE = Number(process.env.AI_WORKER_APARTMENT_MIN_CONFIDENCE) || 0.6;

// Fields the model may fill, mapped onto the listing shape. Anything absent
// here is owned by the deterministic parser and is never touched.
const SCALAR_FIELDS = Object.freeze({
  rooms: 'rooms',
  bedrooms: 'bedrooms',
  bathrooms: 'bathrooms',
  areaM2: 'areaSqm',
  floor: 'floor',
  floorsTotal: 'totalFloors',
  newBuilding: 'newBuilding',
  balcony: 'balcony',
  airConditioner: 'airConditioner',
  gas: 'gas',
  furnished: 'furnished',
  petsAllowed: 'petsAllowed',
  childrenAllowed: 'childrenAllowed',
  communalSeparated: 'communalSeparated',
  depositRequired: 'deposit',
  depositAmount: 'depositAmount',
  commissionRequired: 'commission',
  commissionPercent: 'commissionPercent',
  negotiable: 'negotiable',
  parking: 'parking',
  elevator: 'elevator',
  heating: 'heating',
  hotWater: 'hotWater',
  internet: 'internet',
  smokingAllowed: 'smokingAllowed',
  condition: 'condition',
});

// Deterministic facts handed to the model so it corroborates rather than
// contradicts, and so a changed parse invalidates the cached answer.
const KNOWN_FACT_FIELDS = Object.freeze([
  'dealType', 'propertyType', 'rooms', 'areaSqm', 'floor', 'totalFloors',
  'price', 'currency', 'city', 'district', 'kvartal', 'address', 'residenceComplex',
]);

function blank(value) {
  return value == null || value === '';
}

function listingKey(listing) {
  return `${listing?.source}:${listing?.id}`;
}

export function listingAiText(listing) {
  return `${listing?.title || ''}\n${listing?.description || ''}`.trim();
}

export function apartmentAiInput(listing) {
  const rawText = listingAiText(listing);
  const knownFacts = {};
  for (const field of KNOWN_FACT_FIELDS) {
    knownFacts[field] = blank(listing?.[field]) ? null : listing[field];
  }
  return {
    rawText,
    knownFacts,
    fingerprint: aiFingerprint('apartment', rawText, {
      parserVersion: APARTMENT_PARSER_VERSION,
      ...knownFacts,
    }),
  };
}

export function needsApartmentAi(listing) {
  if (!listing || String(listing.source || '').startsWith('mock')) return false;
  if (!listingAiText(listing)) return false;
  return Object.values(SCALAR_FIELDS).some((field) => blank(listing[field]));
}

/** A dictionary-backed district, or null. Never a free-text place name. */
function acceptedDistrict(value, listing, countryCode) {
  if (blank(value) || !countryCode) return null;
  const canonical = canonicalDictionaryDistrict(String(value), countryCode);
  if (!canonical) return null;
  // A district belonging to another city is a contradiction, not enrichment.
  const known = dictionaryLocationLists(countryCode)?.[listing?.city];
  if (known && !known.districts.includes(canonical)) return null;
  return canonical;
}

/**
 * A complex the location dictionary actually knows, for this listing's city.
 *
 * Free text names complexes loosely ("ЖК Нест", "Nest One Tashkent"), and a
 * complex is second only to a street+house in the geocoder's precedence, so an
 * unrecognised name would move the pin somewhere confident and wrong. Matching
 * the catalog is what makes the value safe to keep; anything else is dropped,
 * exactly as districts already are.
 */
function acceptedResidenceComplex(value, listing, countryCode) {
  if (blank(value) || !countryCode) return null;
  const known = dictionaryLocationLists(countryCode)?.[listing?.city];
  if (!known) return null;
  const wanted = String(value)
    .trim()
    .replace(/^(жк|ждк|residential complex|turar-joy majmuasi)\s+/iu, '')
    .toLocaleLowerCase();
  if (!wanted) return null;
  return (known.residentialComplexes || [])
    .find((name) => String(name).toLocaleLowerCase() === wanted) || null;
}

// Wording that makes a place a landmark rather than the property's own
// address. The prompt already tells the model to leave these out; this is the
// backstop for when it does not, since a "5 минут от Novza" address geocodes
// to a real point that simply is not this flat.
const PROXIMITY_PHRASING =
  /(рядом|около|недалеко|напротив|через дорог|за угл|близко|в\s*\d+\s*минут|\d+\s*мин(ут)?\s*(от|до|пешк)|yaqin|yonida|near\b|next to|opposite|across from|walking distance|close to|\bfrom the\b)/iu;

// Words that make a phrase a street reference rather than an arbitrary place
// name. Listings state a street with no number often enough that requiring a
// house number would throw away most of them ("Metrostroiteley street",
// "Amir Temur ko'chasi"), but something has to separate a street from a
// district or a landmark, and this is it.
// Thoroughfare wording, across every language these listings arrive in:
// Russian, Ukrainian, Uzbek (both Cyrillic and Latin), Kazakh, Kyrgyz,
// English and Romanian. A street is only one kind -- avenues, boulevards,
// highways, lanes, embankments and squares all name an address just as well.
//
// Built with String.raw so a backslash survives into the pattern: written as
// ordinary strings, "\b" is the backspace character and the whole thing
// silently matches nothing.
//
// The Cyrillic stems carry no \b on purpose. That boundary is defined
// against ASCII \w, so /\bулиц/ can never match; the stems are distinctive
// enough on their own. They are also cut short of their case endings
// (проспект-, бульвар-, көшес-) so "проспекти", "бульвары", "көшесі" and
// friends all match one entry.
const STREET_WORDING = new RegExp(
  [
    // Russian / Ukrainian
    String.raw`улиц|ул\.|вулиц|вул\.|проспект|пр-?к?т\b|бульвар|шоссе|шосе`,
    String.raw`|переул|пер\.|провул|проулок|проезд|проїзд|набережн|тупик`,
    String.raw`|аллея|алея|магистрал|тракт|узвіз|площад|площа|майдан`,
    // Uzbek (Cyrillic) -- кўчаси, хиёбони, йўли, бульвари, майдони
    String.raw`|кўча|куча|хиёбон|йўл[иы]|йули`,
    // Kazakh -- көшесі, даңғылы, тас жолы, алаңы
    String.raw`|көшес|көше\b|даңғыл|тас жол|жолы|алаң`,
    // Kyrgyz -- көчөсү, проспектиси, жолу, аянты
    String.raw`|көчө|жолу|аянт`,
    // Uzbek (Latin)
    String.raw`|ko['’‘]?chasi|ko['’‘]?cha\b|ko'?cha\b|prospekt|xiyobon`,
    String.raw`|bulvar|yo['’‘]?l[iy]\b|maydon|shoh ko`,
    // English
    String.raw`|\bstreet\b|\bst\.|\bavenue\b|\bave\.|\broad\b|\brd\.`,
    String.raw`|\blane\b|\bln\.|\bboulevard\b|\bblvd\b|\bdrive\b|\bdr\.`,
    String.raw`|\bhighway\b|\bhwy\b|\balley\b|\bterrace\b|\bsquare\b`,
    String.raw`|\bsq\.|\bcrescent\b|\bparkway\b|\bquay\b|\bembankment\b`,
    String.raw`|\bpassage\b|\besplanade\b`,
    // Romanian
    String.raw`|\bstrada\b|\bstr\.|\bbulevard|\bbd\.|\bcalea\b|\bș?soseaua\b`,
    String.raw`|\baleea\b|\bsplaiul\b|\bpia[țt]a\b|\bdrumul\b|\bintrarea\b`,
  ].join(''),
  'iu',
);

/**
 * A street address worth keeping, and how precise it actually is.
 *
 * Returns null to refuse, otherwise { address, precision } where precision is
 * 'building' when a house number is present and 'street' when the listing
 * only names the street. Street-only is a real, common answer -- the geocoder
 * already models it as approximate (see GEO_ACCURACY_AUDIT precedence rule 5)
 * -- so it is kept and labelled rather than dropped, and it is never allowed
 * to pass as building-precise.
 *
 * Refused: proximity phrasing (a landmark, not this address), anything that
 * is neither numbered nor worded like a street, and a bare echo of geography
 * we already hold.
 */
function acceptedAddress(value, listing) {
  if (blank(value)) return null;
  const address = String(value).trim().replace(/\s+/gu, ' ');
  if (address.length < 5 || address.length > 160) return null;
  if (PROXIMITY_PHRASING.test(address)) return null;

  const hasHouseNumber = /\d/u.test(address);
  if (!hasHouseNumber && !STREET_WORDING.test(address)) return null;

  const normalized = address.toLocaleLowerCase();
  const echoes = [listing?.city, listing?.district, listing?.kvartal, listing?.residenceComplex]
    .filter(Boolean)
    .map((name) => String(name).trim().toLocaleLowerCase());
  if (echoes.includes(normalized)) return null;

  return { address, precision: hasHouseNumber ? 'building' : 'street' };
}

function acceptedKvartal(value, listing, countryCode) {
  if (blank(value) || !countryCode) return null;
  const known = dictionaryLocationLists(countryCode)?.[listing?.city];
  if (!known) return null;
  const wanted = String(value).trim().toLocaleLowerCase();
  return [...known.microdistricts, ...known.localAreas, ...known.mahallas]
    .find((name) => String(name).toLocaleLowerCase() === wanted) || null;
}

/**
 * Fills empty listing fields from a validated model answer. Existing values are
 * never overwritten, and every field the model actually supplied is recorded in
 * `listing.ai.derivedFields` so the API can tell parsed from inferred.
 */
export function mergeApartmentAi(listing, result, countryCode = null) {
  const data = result?.data || {};
  const merged = { ...listing };
  const derivedFields = new Set(
    Array.isArray(listing?.ai?.derivedFields) ? listing.ai.derivedFields.map(String) : [],
  );

  for (const [aiField, listingField] of Object.entries(SCALAR_FIELDS)) {
    if (!blank(merged[listingField]) || blank(data[aiField])) continue;
    merged[listingField] = data[aiField];
    derivedFields.add(listingField);
  }

  const district = blank(merged.district)
    ? acceptedDistrict(data.district, merged, countryCode)
    : null;
  if (district) {
    merged.district = district;
    derivedFields.add('district');
  }

  const kvartal = blank(merged.kvartal)
    ? acceptedKvartal(data.kvartal, merged, countryCode)
    : null;
  if (kvartal) {
    merged.kvartal = kvartal;
    derivedFields.add('kvartal');
  }

  const residenceComplex = blank(merged.residenceComplex)
    ? acceptedResidenceComplex(data.residenceComplex, merged, countryCode)
    : null;
  if (residenceComplex) {
    merged.residenceComplex = residenceComplex;
    derivedFields.add('residenceComplex');
  }

  // Last, so it can be checked against whatever geography this merge just
  // established rather than only what the parser had.
  const address = blank(merged.address) ? acceptedAddress(data.address, merged) : null;
  if (address) {
    merged.address = address.address;
    // Provenance the geocoder and the API already understand: a street with
    // no house number stays flagged approximate instead of being ranked as a
    // precise source address.
    merged.addressPrecision ??= address.precision;
    merged.addressApproximate ??= address.precision !== 'building';
    derivedFields.add('address');
  }

  if (Array.isArray(data.amenities) && data.amenities.length) {
    const amenities = new Set(merged.amenities || []);
    const before = amenities.size;
    for (const amenity of data.amenities) {
      const value = String(amenity || '').trim();
      if (value) amenities.add(value);
    }
    if (amenities.size > before) {
      merged.amenities = [...amenities];
      derivedFields.add('amenities');
    }
  }

  merged.ai = {
    parserVersion: APARTMENT_PARSER_VERSION,
    fingerprint: listing?.ai?.fingerprint ?? null,
    status: 'completed',
    confidence: Number(result?.confidence) || 0,
    derivedFields: [...derivedFields].sort(),
    updatedAt: new Date().toISOString(),
  };
  return merged;
}

/**
 * Queues apartment extraction for listings the parser left incomplete.
 * `persist` receives the merged listing; callers own storage.
 */
export function scheduleListingsAi(listings, country, persist) {
  if (!aiWorkerEnabled() || !Array.isArray(listings) || !listings.length) return 0;

  const countryCode = String(country?.code || '').toUpperCase() || null;
  const batchSize = Math.max(1, Number(process.env.AI_WORKER_APARTMENT_BATCH) || 8);
  let queued = 0;

  // Capacity is the scarce resource, so spend it on the freshest adverts
  // in the batch rather than whatever order the source page returned.
  for (const listing of newestFirst(listings)) {
    if (queued >= batchSize) break;
    if (!needsApartmentAi(listing)) continue;

    const input = apartmentAiInput(listing);
    // Same text and same deterministic facts as last time: nothing to re-ask.
    if (listing.ai?.fingerprint === input.fingerprint) continue;

    const id = listingKey(listing);
    const accepted = scheduleAiExtraction({
      id,
      kind: 'apartment',
      rawText: input.rawText,
      knownFacts: input.knownFacts,
      fingerprint: input.fingerprint,
      meta: { source: listing.source, id: listing.id, country: countryCode, city: listing.city },
      onResult: async (result) => {
        if (result?.lowConfidence || (Number(result?.confidence) || 0) < MIN_CONFIDENCE) {
          listing.ai = {
            parserVersion: APARTMENT_PARSER_VERSION,
            fingerprint: input.fingerprint,
            status: 'low_confidence',
            confidence: Number(result?.confidence) || 0,
            updatedAt: new Date().toISOString(),
          };
          return;
        }
        const merged = mergeApartmentAi(listing, result, countryCode);
        merged.ai.fingerprint = input.fingerprint;
        await persist?.(merged);
      },
      onFailed: (status) => {
        listing.ai = {
          parserVersion: APARTMENT_PARSER_VERSION,
          fingerprint: input.fingerprint,
          status: status === 'failed' ? 'failed' : 'unavailable',
          updatedAt: new Date().toISOString(),
        };
      },
    });

    if (accepted) {
      listing.ai = {
        parserVersion: APARTMENT_PARSER_VERSION,
        fingerprint: input.fingerprint,
        status: 'pending',
        updatedAt: new Date().toISOString(),
      };
      queued += 1;
    }
  }

  if (queued) console.log(`[flats:ai] queued apartment extraction=${queued}`);
  return queued;
}
