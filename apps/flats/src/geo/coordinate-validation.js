import { canonicalCityName } from './countries.js';
import { geocodeBbox } from './geocode.js';

const DEFAULT_PADDING_DEG = 0.02;
const bboxPromises = new Map();

export function coordinateInsideBbox(lat, lng, bbox, padding = DEFAULT_PADDING_DEG) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return false;
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)) return true;

  const [south, west, north, east] = bbox;
  return Number(lat) >= south - padding
    && Number(lat) <= north + padding
    && Number(lng) >= west - padding
    && Number(lng) <= east + padding;
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
