import { cacheGet, cacheSet } from '../support/cache.js';
import { upsertListings } from '../infrastructure/database/listingRepository.js';
import { indexListings } from '../infrastructure/search/elasticsearch.js';
import { detectExactDuplicatePhotos } from './photo-antifake.js';
import {
  aiWorkerEnabled,
  scheduleVisionAnalysis,
  visionFingerprint,
} from '../support/ai-worker.js';
import { newestFirst } from './enrichment-priority.js';

const STALE_TTL_MS = 60 * 60 * 1000;
const FULL_FEED_VERSION = 'full-feed-v8';
const MAX_VISION_PHOTOS = 10;
const antiFakeRunning = new Set();

function defaultCacheKey(countryCode) {
  return `${FULL_FEED_VERSION}|${countryCode}|all-sources|`;
}

function listingKey(listing) {
  return `${listing.source}:${listing.id}`;
}

const PHOTO_BASE_URL = (process.env.VISION_PHOTO_BASE_URL || 'http://flat-finder-backend:4000').replace(/\/$/, '');

function absolutePhotoUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/api/tg-photo/')) return `${PHOTO_BASE_URL}${url}`;
  return null;
}

function listingImages(listing) {
  const source = Array.isArray(listing.photos) && listing.photos.length
    ? listing.photos
    : listing.photo
      ? [listing.photo]
      : [];
  return [...new Set(source.map(absolutePhotoUrl).filter(Boolean))]
    .slice(0, MAX_VISION_PHOTOS)
    .map((url, index) => ({ id: `photo_${index + 1}`, url }));
}

// Fields that can be established from listing photos. Contractual/policy fields
// such as commission, pets, lease term and utilities intentionally remain in the
// text parser: vision must not infer them from how a property looks.
const VISION_LISTING_FIELDS = [
  'rooms',
  'bedrooms',
  'bathrooms',
  'bathroomLayout',
  'airConditioner',
  'balcony',
  'terrace',
  'privateYard',
  'furnished',
  'parking',
  'elevator',
  'dishwasher',
  'tv',
  'microwave',
  'oven',
  'bidet',
  'walkInCloset',
  'bathtub',
  'shower',
  'gas',
  'heating',
  'hotWater',
  'internet',
  'euroLayout',
  'newBuilding',
  'condition',
];

function needsVision(listing) {
  if (!listing || String(listing.source || '').startsWith('mock')) return false;
  if (!listingImages(listing).length) return false;
  return VISION_LISTING_FIELDS.some((field) => listing[field] == null || listing[field] === '');
}

function accepted(item, minConfidence = 0.75) {
  return item && item.value != null && Number(item.confidence) >= minConfidence;
}

export function mergeVision(listing, result) {
  const data = result?.data || {};
  const merged = { ...listing };
  const derivedFields = new Set(
    Array.isArray(listing?.vision?.derivedFields) ? listing.vision.derivedFields.map(String) : [],
  );
  const fill = (field, item, provenanceField = field, minConfidence = 0.75) => {
    if ((merged[field] == null || merged[field] === '') && accepted(item, minConfidence)) {
      merged[field] = item.value;
      derivedFields.add(provenanceField);
    }
  };

  fill('rooms', data.roomsVisible);
  fill('bedrooms', data.bedroomsVisible);
  fill('bathrooms', data.bathroomsVisible);
  fill('bathroomLayout', data.bathroomLayoutVisible);
  fill('airConditioner', data.airConditioner);
  fill('balcony', data.balcony);
  fill('terrace', data.terrace);
  fill('privateYard', data.privateYard);
  fill('furnished', data.furnished);
  fill('parking', data.parkingVisible);
  fill('elevator', data.elevatorVisible);
  fill('dishwasher', data.dishwasherVisible);
  fill('tv', data.tvVisible);
  fill('microwave', data.microwaveVisible);
  fill('oven', data.ovenVisible);
  fill('bidet', data.bidetVisible);
  fill('walkInCloset', data.walkInClosetVisible);
  fill('bathtub', data.bathtubVisible);
  fill('shower', data.showerVisible);
  fill('gas', data.gasVisible);
  if (merged.gas == null || merged.gas === '') fill('gas', data.gasWaterHeaterVisible);
  fill('heating', data.heatingVisible);
  fill('hotWater', data.hotWaterVisible);
  if (merged.hotWater == null || merged.hotWater === '') fill('hotWater', data.gasWaterHeaterVisible);
  if (merged.hotWater == null || merged.hotWater === '') fill('hotWater', data.waterBoilerVisible);
  // Visible network equipment is good supporting evidence, but weaker than an
  // explicit service statement, so require a higher threshold before filling.
  fill('internet', data.internetEquipmentVisible, 'internet', 0.9);
  fill('euroLayout', data.euroLayoutVisible, 'euroLayout', 0.85);
  fill('newBuilding', data.newBuildingVisible, 'newBuilding', 0.9);
  fill('condition', data.renovationLevel);

  const amenityMap = {
    closedYard: { amenity: 'closed_yard', field: 'closedYard' },
    kitchenVisible: { amenity: 'kitchen', field: 'kitchen' },
    washingMachineVisible: { amenity: 'washing_machine', field: 'washingMachine' },
    dishwasherVisible: { amenity: 'dishwasher', field: 'dishwasher' },
    tvVisible: { amenity: 'tv', field: 'tv' },
    microwaveVisible: { amenity: 'microwave', field: 'microwave' },
    ovenVisible: { amenity: 'oven', field: 'oven' },
    bidetVisible: { amenity: 'bidet', field: 'bidet' },
    walkInClosetVisible: { amenity: 'walk_in_closet', field: 'walkInCloset' },
    bathtubVisible: { amenity: 'bathtub', field: 'bathtub' },
    showerVisible: { amenity: 'shower', field: 'shower' },
    gasWaterHeaterVisible: { amenity: 'gas_water_heater', field: 'gasWaterHeater' },
    waterBoilerVisible: { amenity: 'water_boiler', field: 'waterBoiler' },
  };
  const amenities = new Set(merged.amenities || []);
  for (const [visionField, { amenity, field }] of Object.entries(amenityMap)) {
    const item = data[visionField];
    if (accepted(item) && item.value === true && !amenities.has(amenity)) {
      amenities.add(amenity);
      derivedFields.add(field);
    }
  }
  merged.amenities = [...amenities];

  fill('gasWaterHeater', data.gasWaterHeaterVisible);
  fill('waterBoiler', data.waterBoilerVisible);

  merged.vision = {
    provider: result.provider || null,
    analyzedAt: result.analyzedAt || new Date().toISOString(),
    derivedFields: [...derivedFields].sort(),
    data,
  };
  return merged;
}

async function persistMerged(listing) {
  try {
    const saved = await upsertListings([listing]);
    if (saved) await indexListings([listing]);
  } catch (error) {
    console.warn(`[flats:vision] persistence failed for ${listingKey(listing)}: ${error.message}`);
  }
}

async function applyResult(countryCode, id, fingerprint, result) {
  const key = defaultCacheKey(countryCode);
  const entry = await cacheGet(key);
  if (!entry?.complete || !Array.isArray(entry.listings)) return;

  const index = entry.listings.findIndex((listing) => listingKey(listing) === id);
  if (index < 0) return;
  const current = entry.listings[index];
  const images = listingImages(current);
  if (visionFingerprint(images) !== fingerprint) return;

  const merged = mergeVision(current, result);
  entry.listings[index] = merged;
  entry.vision = entry.vision || {};
  entry.vision[id] = {
    fingerprint,
    status: 'completed',
    provider: result.provider || null,
    analyzedAt: result.analyzedAt || new Date().toISOString(),
  };
  await cacheSet(key, entry, STALE_TTL_MS);
  await persistMerged(merged);
}

async function applyAntiFake(countryCode, id, fingerprint, result) {
  const key = defaultCacheKey(countryCode);
  const entry = await cacheGet(key);
  if (!entry?.complete || !Array.isArray(entry.listings)) return;
  const index = entry.listings.findIndex((listing) => listingKey(listing) === id);
  if (index < 0) return;

  const current = entry.listings[index];
  if (visionFingerprint(listingImages(current)) !== fingerprint) return;

  const merged = {
    ...current,
    antiFake: result,
    duplicatePhotoRisk: result.risk,
    exactDuplicatePhoto: result.exactDuplicatePhoto,
  };
  entry.listings[index] = merged;
  entry.antiFake = entry.antiFake || {};
  entry.antiFake[id] = {
    fingerprint,
    status: 'completed',
    risk: result.risk,
    matches: result.matches.length,
    checkedAt: result.checkedAt,
  };
  await cacheSet(key, entry, STALE_TTL_MS);
  await persistMerged(merged);
}

function scheduleAntiFake(countryCode, listing, images, fingerprint) {
  const id = listingKey(listing);
  const runKey = `${countryCode}:${id}:${fingerprint}`;
  if (antiFakeRunning.has(runKey)) return false;
  antiFakeRunning.add(runKey);

  void detectExactDuplicatePhotos(listing, images)
    .then((result) => applyAntiFake(countryCode, id, fingerprint, result))
    .catch((error) => console.warn(`[flats:antifake] ${id} failed: ${error.message}`))
    .finally(() => antiFakeRunning.delete(runKey));
  return true;
}

export function scheduleListingsVision(listings) {
  if (!aiWorkerEnabled() || !Array.isArray(listings) || !listings.length) return 0;

  const batchSize = Math.max(1, Number(process.env.AI_WORKER_VISION_BATCH) || 3);
  let queued = 0;

  // Capacity is the scarce resource, so spend it on the freshest adverts
  // in the batch rather than whatever order the source page returned.
  for (const listing of newestFirst(listings)) {
    if (queued >= batchSize) break;
    if (!needsVision(listing)) continue;

    const images = listingImages(listing);
    if (!images.length) continue;
    const fingerprint = visionFingerprint(images);
    const id = listingKey(listing);

    const acceptedQueue = scheduleVisionAnalysis({
      id,
      images,
      fingerprint,
      onResult: async (result) => {
        const merged = mergeVision(listing, result);
        if (visionFingerprint(listingImages(merged)) !== fingerprint) return;
        await persistMerged(merged);
      },
      onFailed: (status) => {
        console.warn(`[flats:vision] ${id} failed status=${status}`);
      },
    });

    if (acceptedQueue) queued += 1;
  }

  if (queued) console.log(`[flats:vision] queued persisted-listing vision=${queued}`);
  return queued;
}

export function scheduleCountryVision(countryCode, entry) {
  if (!entry?.complete || !Array.isArray(entry.listings)) return 0;

  const batchSize = Math.max(1, Number(process.env.AI_WORKER_VISION_BATCH) || 3);
  entry.vision = entry.vision || {};
  entry.antiFake = entry.antiFake || {};
  let queued = 0;
  let antiFakeQueued = 0;

  for (const listing of entry.listings) {
    if (queued >= batchSize && antiFakeQueued >= batchSize) break;
    if (!listing || String(listing.source || '').startsWith('mock')) continue;

    const images = listingImages(listing);
    if (!images.length) continue;
    const fingerprint = visionFingerprint(images);
    const id = listingKey(listing);

    const priorAntiFake = entry.antiFake[id];
    if (
      antiFakeQueued < batchSize &&
      !(priorAntiFake?.fingerprint === fingerprint && priorAntiFake.status === 'completed') &&
      scheduleAntiFake(countryCode, listing, images, fingerprint)
    ) {
      entry.antiFake[id] = { fingerprint, status: 'pending', updatedAt: new Date().toISOString() };
      antiFakeQueued += 1;
    }

    if (!aiWorkerEnabled() || queued >= batchSize || !needsVision(listing)) continue;
    const prior = entry.vision[id];
    if (prior?.fingerprint === fingerprint && prior.status === 'completed') continue;

    const acceptedQueue = scheduleVisionAnalysis({
      id,
      images,
      fingerprint,
      onResult: (result) => applyResult(countryCode, id, fingerprint, result),
      onFailed: async (status) => {
        const key = defaultCacheKey(countryCode);
        const current = await cacheGet(key);
        if (!current?.complete) return;
        current.vision = current.vision || {};
        current.vision[id] = {
          fingerprint,
          status,
          updatedAt: new Date().toISOString(),
        };
        await cacheSet(key, current, STALE_TTL_MS);
      },
    });

    if (acceptedQueue) {
      entry.vision[id] = {
        fingerprint,
        status: 'pending',
        updatedAt: new Date().toISOString(),
      };
      queued += 1;
    }
  }

  if (queued || antiFakeQueued) {
    console.log(`[flats:vision] queued vision=${queued}, antifake=${antiFakeQueued} for ${countryCode}`);
  }
  return queued + antiFakeQueued;
}
