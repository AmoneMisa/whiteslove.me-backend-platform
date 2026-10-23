import { canonicalCityName } from './countries.js';
import { geocodeBbox } from './geocode.js';

const DEFAULT_PADDING_DEG = 0.02;
const bboxPromises = new Map();

export function coordinateInsideBbox(lat, lng, bbox, padding = DEFAULT_PADDING_DEG) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return false;
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)) return true;

  const [south, west, north, east] = bbox;
  // The padding is stated in latitude degrees. A degree of longitude shrinks
  // toward the poles, so at Tashkent's latitude an unconverted padding is ~25%
  // tighter east-west than north-south and clips valid points off the city edge.
  const midLat = (((south + north) / 2) * Math.PI) / 180;
  const lngPadding = padding / Math.max(0.1, Math.cos(midLat));

  return Number(lat) >= south - padding
    && Number(lat) <= north + padding
    && Number(lng) >= west - lngPadding
    && Number(lng) <= east + lngPadding;
}

/**
 * Some sites publish latitude and longitude the wrong way round (lun.ua does
 * for part of its cards). Only a point that is outside the area as given and
 * inside it when swapped is treated as swapped; anything else is left alone.
 */
export function orientCoordinates(lat, lng, bbox, padding = DEFAULT_PADDING_DEG) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)) return { lat, lng, swapped: false };
  if (coordinateInsideBbox(lat, lng, bbox, padding)) return { lat, lng, swapped: false };
  if (coordinateInsideBbox(lng, lat, bbox, padding)) return { lat: Number(lng), lng: Number(lat), swapped: true };
  return { lat, lng, swapped: false };
}

async function bboxFor(country, area) {
  const query = [area, country?.name].filter(Boolean).join(', ');
  if (!query) return null;

  const key = `${country?.code || ''}:${String(area).toLowerCase()}`;
  if (!bboxPromises.has(key)) {
    bboxPromises.set(key, geocodeBbox(query, country?.code, area).catch(() => null));
  }
  return bboxPromises.get(key);
}

/**
 * OLX can expose deliberately rough or simply bad coordinates. Keep points
 * that are still inside a padded crawl-area bbox, but reject obvious outliers.
 */
export async function rejectOutOfAreaCoordinates(
  listings,
  country,
  { areaHint = null } = {},
) {
  if (!Array.isArray(listings) || !country) return [];

  const configured = Number(process.env.SOURCE_COORD_BBOX_PADDING_DEG);
  const padding = Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_PADDING_DEG;
  const rejected = [];

  for (const listing of listings) {
    if (listing?.sourceCoordinateRejected === true && (listing.lat == null || listing.lng == null)) {
      rejected.push(listing);
      continue;
    }

    if (!Number.isFinite(Number(listing?.lat)) || !Number.isFinite(Number(listing?.lng))) {
      continue;
    }

    const area = areaHint || canonicalCityName(country.code, listing.city || '');
    if (!area) continue;

    const bbox = await bboxFor(country, area);
    if (!bbox || coordinateInsideBbox(listing.lat, listing.lng, bbox, padding)) continue;

    listing.sourceCoordinateRejected = true;
    listing.lat = null;
    listing.lng = null;
    listing.district = null;
    listing.microdistrict = null;
    listing.locationSource = 'source-coordinate-rejected';
    listing.locationAccuracyM = null;
    rejected.push(listing);
  }

  return rejected;
}

/**
 * Repairs swapped lat/lng in place, against the listing's city bbox or, with no
 * city, the country's. Listings whose coordinates fit neither way are left for
 * the other validators.
 */
export async function repairSwappedCoordinates(listings, country, { areaHint = null } = {}) {
  if (!Array.isArray(listings) || !country) return 0;
  let repaired = 0;
  for (const listing of listings) {
    if (!Number.isFinite(Number(listing?.lat)) || !Number.isFinite(Number(listing?.lng))) continue;
    const area = areaHint || canonicalCityName(country.code, listing.city || '') || '';
    const bbox = await bboxFor(country, area);
    const next = orientCoordinates(Number(listing.lat), Number(listing.lng), bbox);
    if (!next.swapped) continue;
    listing.lat = next.lat;
    listing.lng = next.lng;
    repaired += 1;
  }
  return repaired;
}
