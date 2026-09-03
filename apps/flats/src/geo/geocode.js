// Best-effort geocoding for listings that arrive without GPS coordinates.
//
// Precision order (highest -> lowest):
//   source coordinates -> exact address -> primary residential complex -> street
//   -> primary POI -> primary metro -> constrained spatial anchors -> primary local
//   geography -> nearby/reference anchors -> district. City centres are never
//   apartment points.
//
// Coordinates come from Nominatim (OpenStreetMap). Requests are throttled and
// cached because geocoding runs during background refreshes, never on the
// request path.

import { canonicalCityName } from './countries.js'
import { assignNearestMetro } from './metro-nearest.js'
import { loadCityPlaces } from '../infrastructure/database/placesRepository.js'
import { annotateListings } from './nearby-places.js'
import { applyReverseGeo } from './reverse-geo.js'
import {
  cachedNominatimPoint,
  fetchNominatimPoint,
  geocodeBbox,
  geocodeQuery,
} from './nominatim-client.js'
import { solveSpatialPoint } from './geocode-spatial.js'

const MAX_LOOKUPS_PER_RUN = Number(process.env.GEOCODE_BUDGET) || 60
const MAX_LOOKUPS_PER_LISTING = Math.max(1, Number(process.env.GEOCODE_LISTING_BUDGET) || 3)

const POI_ALIASES = {
  Korzinka: 'korzinka|корзинк\\p{L}*',
  Makro: 'makro|макро',
  Havas: '[xh]avas|хавас',
  Carrefour: 'carrefour|карфур',
  Magnum: 'magnum|магнум',
  Clinic: 'clinic|поликлиник\\p{L}*|poliklinik\\p{L}*',
  Hospital: 'hospital|больниц\\p{L}*|shifoxon\\p{L}*',
  School: 'school|школ\\p{L}*|maktab\\p{L}*',
}

const EXACT_SOURCE_PRIORITY = Object.freeze({
  address: 10,
  residentialComplex: 20,
  street: 30,
  poi: 40,
  metro: 50,
})

const BROAD_SOURCES = new Set([
  'microdistrict', 'area', 'localArea', 'locality', 'developmentArea',
  'informalArea', 'suburb', 'settlement', 'searchCluster', 'district',
])

export { geocodeBbox, geocodeQuery }

function cityCenter(country) {
  const c = country?.center
  return c && typeof c.lat === 'number' && typeof c.lng === 'number' ? c : null
}

function finiteAccuracy(value, fallback = null) {
  if (value == null || value === '') return fallback
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

/**
 * Accuracy radius for a placed listing. The candidate carries the semantic
 * expectation (a complex anchor is worth ~300 m); `extentM` is the real size of
 * the OSM object that was matched. Reporting the larger of the two keeps the
 * radius honest when a name resolved to something bigger than expected, without
 * ever inventing precision the semantics do not support.
 */
export function resolveAccuracyM(candidateAccuracyM, coords) {
  const baseline = finiteAccuracy(coords?.accuracyM, finiteAccuracy(candidateAccuracyM))
  const extentM = finiteAccuracy(coords?.extentM)
  if (baseline == null) return extentM
  return extentM == null ? baseline : Math.max(baseline, extentM)
}

function uniq(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))]
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function distanceToMeters(value, unit) {
  const amount = Number(String(value).replace(',', '.'))
  if (!Number.isFinite(amount) || amount <= 0) return null
  return /км|km/i.test(unit) ? Math.round(amount * 1000) : Math.round(amount)
}

function listingText(listing) {
  return `${listing?.title || ''}\n${listing?.description || ''}`
}

function detectedPoiNames(listing) {
  const text = listingText(listing)
  if (!text.trim()) return []
  const names = []
  for (const [name, alias] of Object.entries(POI_ALIASES)) {
    if (new RegExp(`(?:${alias})`, 'iu').test(text)) names.push(name)
  }
  return names
}

function sameName(a, b) {
  return String(a || '').trim().toLocaleLowerCase() === String(b || '').trim().toLocaleLowerCase()
}

function normalizeEntityType(type) {
  if (type === 'residentialComplex') return 'residential_complex'
  if (type === 'localArea') return 'local_area'
  return type
}

function locationRole(listing, types, name) {
  if (!name) return 'mentioned'
  const accepted = new Set((Array.isArray(types) ? types : [types]).map(normalizeEntityType))
  const match = (listing.locationEntities || []).find((entity) =>
    accepted.has(normalizeEntityType(entity?.type)) && sameName(entity?.name, name),
  )
  return match?.role === 'nearby' || match?.role === 'primary' ? match.role : 'mentioned'
}

export function poiDistanceM(listing, name) {
  const text = listingText(listing)
  if (!text.trim() || !name) return null
  const poi = POI_ALIASES[name] || escapeRegExp(name)
  const unit = '(км|km|м|m|метр\\p{L}*)'
  const number = '(\\d+(?:[.,]\\d+)?)'
  const patterns = [
    new RegExp(`${number}\\s*${unit}\\s*(?:от|до|from|to)?\\s*(?:${poi})`, 'iu'),
    new RegExp(`(?:${poi})[^\\r\\n]{0,35}?${number}\\s*${unit}`, 'iu'),
  ]
  for (const re of patterns) {
    const match = text.match(re)
    if (match) return distanceToMeters(match[1], match[2])
  }
  return null
}

function contextParts(listing, country) {
  const city = canonicalCityName(
    country?.code,
    listing.city || country?.cities?.[0] || '',
  )
  const countryName = country?.name || ''
  return { city, countryName }
}

function poiCandidates(listing, city, countryName) {
  const names = uniq([
    ...(listing.nearbyShops || []),
    ...(listing.nearby || []),
    ...detectedPoiNames(listing),
  ])
  const area = listing.area || listing.kvartal || listing.microdistrict
  return names.map((name) => {
    const distanceM = poiDistanceM(listing, name)
    return {
      q: [name, area, listing.district, city, countryName].filter(Boolean).join(', '),
      source: 'nearby',
      role: 'nearby',
      name,
      distanceM,
      accuracyM: distanceM || 700,
      precision: 'reference',
      approximate: true,
      nominatim: { kind: 'entity', name, city },
    }
  })
}

function listCandidates(listing, values, source, context, accuracyM, types = [], city = null, precision = null) {
  return uniq(values || []).map((value) => ({
    q: [value, ...context].filter(Boolean).join(', '),
    source,
    role: locationRole(listing, types, value),
    name: value,
    accuracyM,
    precision,
    approximate: true,
    nominatim: { kind: 'entity', name: value, city },
  }))
}

function locationEntityCandidates(listing, city, countryName) {
  const entities = Array.isArray(listing.locationEntities) ? listing.locationEntities : []
  const supported = new Map([
    ['residential_complex', { source: 'residentialComplex', accuracyM: 300, precision: 'complex' }],
    ['metro', { source: 'metro', accuracyM: 350, precision: 'station' }],
    ['poi', { source: 'poi', accuracyM: 700, precision: 'reference' }],
    ['mahalla', { source: 'localArea', accuracyM: 700, precision: 'neighborhood' }],
    ['local_area', { source: 'localArea', accuracyM: 800, precision: 'neighborhood' }],
    ['suburb', { source: 'suburb', accuracyM: 1400, precision: 'locality' }],
    ['settlement', { source: 'settlement', accuracyM: 1400, precision: 'locality' }],
    ['informal_area', { source: 'informalArea', accuracyM: 1300, precision: 'neighborhood' }],
    ['development_area', { source: 'developmentArea', accuracyM: 1200, precision: 'neighborhood' }],
    ['microdistrict', { source: 'microdistrict', accuracyM: 600, precision: 'neighborhood' }],
    ['street', { source: 'street', accuracyM: 300, precision: 'street' }],
  ])
  const out = []
  for (const entity of entities) {
    const type = normalizeEntityType(entity?.type)
    const config = supported.get(type)
    if (!config || !entity?.name) continue
    out.push({
      q: [entity.name, entity.parent, listing.district, city, countryName].filter(Boolean).join(', '),
      source: config.source,
      role: entity.role === 'nearby' || entity.role === 'primary' ? entity.role : 'mentioned',
      name: entity.name,
      accuracyM: config.accuracyM,
      precision: config.precision,
      approximate: true,
      nominatim: config.source === 'street'
        ? { kind: 'street', street: entity.name, city }
        : { kind: 'entity', name: entity.name, city },
    })
  }
  return out
}

function dedupeCandidates(candidates) {
  const seen = new Set()
  return candidates.filter((candidate) => {
    if (!candidate?.q) return false
    const key = candidate.q.toLowerCase().replace(/\s+/g, ' ').trim()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).map((candidate) => (
    // The geocoder needs the expected semantic level to tell a metro station
    // from the district that shares its name, and to size the accuracy radius.
    candidate.nominatim && candidate.precision
      ? { ...candidate, nominatim: { ...candidate.nominatim, level: candidate.precision } }
      : candidate
  ))
}

export function geocodeCandidates(listing, country) {
  const { city, countryName } = contextParts(listing, country)
  const area = listing.area || listing.kvartal
  const localContext = [listing.district, city, countryName]
  const candidates = [
    listing.address && {
      q: [listing.address, listing.district, city, countryName].filter(Boolean).join(', '),
      source: 'address',
      role: 'primary',
      name: listing.address,
      accuracyM: listing.houseNumber ? null : 180,
      precision: listing.houseNumber ? 'building' : 'street',
      approximate: !listing.houseNumber,
      nominatim: {
        kind: 'address',
        houseNumber: listing.houseNumber || null,
        street: listing.street || null,
        city,
      },
    },
    listing.residenceComplex && {
      q: [listing.residenceComplex, listing.district, city, countryName].filter(Boolean).join(', '),
      source: 'residentialComplex',
      role: locationRole(listing, 'residential_complex', listing.residenceComplex),
      name: listing.residenceComplex,
      accuracyM: 300,
      precision: 'complex',
      approximate: true,
      nominatim: { kind: 'entity', name: listing.residenceComplex, city },
    },
    listing.street && {
      q: [listing.street, listing.district, city, countryName].filter(Boolean).join(', '),
      source: 'street',
      role: locationRole(listing, 'street', listing.street),
      name: listing.street,
      accuracyM: 300,
      precision: 'street',
      approximate: true,
      nominatim: { kind: 'street', street: listing.street, city },
    },
    listing.metro && {
      q: [`${listing.metro} metro station`, city, countryName].filter(Boolean).join(', '),
      source: 'metro',
      role: locationRole(listing, 'metro', listing.metro),
      name: listing.metro,
      accuracyM: 500,
      precision: 'station',
      approximate: true,
      nominatim: { kind: 'entity', name: listing.metro, city },
    },
    ...poiCandidates(listing, city, countryName),
    listing.microdistrict && {
      q: [listing.microdistrict, ...localContext].filter(Boolean).join(', '),
      source: 'microdistrict',
      role: locationRole(listing, ['microdistrict', 'mahalla'], listing.microdistrict),
      name: listing.microdistrict,
      accuracyM: 600,
      precision: 'neighborhood',
      approximate: true,
      nominatim: { kind: 'entity', name: listing.microdistrict, city },
    },
    area && {
      q: [area, ...localContext].filter(Boolean).join(', '),
      source: 'area',
      role: locationRole(listing, ['local_area', 'microdistrict'], area),
      name: area,
      accuracyM: 700,
      precision: 'neighborhood',
      approximate: true,
      nominatim: { kind: 'entity', name: area, city },
    },
    ...listCandidates(listing, listing.localAreas, 'localArea', localContext, 800, ['local_area', 'mahalla'], city, 'neighborhood'),
    listing.locality && {
      q: [listing.locality, city, countryName].filter(Boolean).join(', '),
      source: 'locality',
      role: locationRole(listing, ['suburb', 'settlement', 'local_area'], listing.locality),
      name: listing.locality,
      accuracyM: 1000,
      precision: 'locality',
      approximate: true,
      nominatim: { kind: 'entity', name: listing.locality, city },
    },
    ...listCandidates(listing, listing.developmentAreas, 'developmentArea', [city, countryName], 1200, 'development_area', city, 'neighborhood'),
    ...listCandidates(listing, listing.informalAreas, 'informalArea', [city, countryName], 1300, 'informal_area', city, 'neighborhood'),
    ...listCandidates(listing, listing.suburbs, 'suburb', [city, countryName], 1400, 'suburb', city, 'locality'),
    ...listCandidates(listing, listing.settlements, 'settlement', [city, countryName], 1400, 'settlement', city, 'locality'),
    ...listCandidates(listing, listing.searchClusters, 'searchCluster', [city, countryName], 1600, 'search_cluster', city, 'locality'),
    ...locationEntityCandidates(listing, city, countryName),
    listing.district && {
      q: [listing.district, city, countryName].filter(Boolean).join(', '),
      source: 'district',
      role: locationRole(listing, 'district', listing.district),
      name: listing.district,
      accuracyM: 2500,
      precision: 'district',
      approximate: true,
      nominatim: { kind: 'entity', name: listing.district, city },
    },
    city && {
      q: [city, countryName].filter(Boolean).join(', '),
      source: 'city',
      role: 'mentioned',
      name: city,
      accuracyM: 8000,
      precision: 'city',
      approximate: true,
      nominatim: { kind: 'entity', name: city, city },
    },
  ]
  return dedupeCandidates(candidates)
}

export { solveSpatialPoint }

export async function geocodeListings(listings, country) {
  if (!Array.isArray(listings) || !country) return listings
  const center = cityCenter(country)
  let budget = MAX_LOOKUPS_PER_RUN
  let listingBudget = MAX_LOOKUPS_PER_LISTING

  async function lookup(candidate) {
    if (!candidate?.q) return null
    const expectation = candidate.nominatim || {}
    let coords = await cachedNominatimPoint(candidate.q, country.code, expectation)
    if (coords === undefined) {
      if (budget <= 0 || listingBudget <= 0) return null
      coords = await fetchNominatimPoint(candidate.q, country.code, expectation)
      budget--
      listingBudget--
    }
    return coords || null
  }

  function applyCandidate(listing, candidate, coords) {
    listing.lat = Number(coords.lat)
    listing.lng = Number(coords.lng)
    listing.locationSource = candidate.source
    listing.locationAccuracyM = resolveAccuracyM(candidate.accuracyM, coords)
    listing.locationExtentM = finiteAccuracy(coords.extentM)
    listing.locationPrecision = coords.precision || candidate.precision || null
    listing.locationApproximate = candidate.approximate ?? candidate.source !== 'address'
    if (candidate.source === 'address' && listing.locationPrecision === 'building') {
      listing.locationApproximate = false
    }
    listing.locationCanonical = candidate.name || null
    listing.locationRole = candidate.role || 'mentioned'
    listing.locationProvider = coords.provider || 'nominatim'
    listing.locationProviderId = coords.providerId || null
    listing.locationProviderType = coords.providerType || null
  }

  for (const listing of listings) {
    listingBudget = MAX_LOOKUPS_PER_LISTING
    const canonicalCity = canonicalCityName(country?.code, listing.city || '')
    if (canonicalCity) listing.city = canonicalCity

    if (listing.lat != null && listing.lng != null) {
      listing.locationSource ??= 'coordinates'
      listing.locationAccuracyM = finiteAccuracy(listing.locationAccuracyM)
      listing.locationPrecision ??= 'broad'
      listing.locationApproximate ??= true
      continue
    }

    const candidates = geocodeCandidates(listing, country)
    const exactCandidates = candidates.filter((candidate) =>
      Object.hasOwn(EXACT_SOURCE_PRIORITY, candidate.source)
      && candidate.role !== 'nearby',
    ).sort((a, b) => EXACT_SOURCE_PRIORITY[a.source] - EXACT_SOURCE_PRIORITY[b.source])
    const nearbyCandidates = candidates.filter((candidate) =>
      candidate.source === 'nearby' || candidate.role === 'nearby',
    )
    const broadCandidates = candidates.filter((candidate) =>
      BROAD_SOURCES.has(candidate.source) && candidate.role !== 'nearby',
    )

    let placed = false

    for (const candidate of exactCandidates) {
      const coords = await lookup(candidate)
      if (!coords) continue
      applyCandidate(listing, candidate, coords)
      placed = true
      break
    }
    if (placed) continue

    const constrainedPoi = nearbyCandidates.filter((candidate) => candidate.distanceM != null)
    if (constrainedPoi.length >= 2) {
      const anchors = []
      for (const candidate of constrainedPoi) {
        const coords = await lookup(candidate)
        if (coords) anchors.push({ ...coords, distanceM: candidate.distanceM, name: candidate.name })
      }

      if (anchors.length >= 2) {
        const priorCandidate = broadCandidates[0]
        const prior = priorCandidate ? await lookup(priorCandidate) : center
        const spatial = solveSpatialPoint(anchors, prior)
        if (spatial) {
          listing.lat = spatial.lat
          listing.lng = spatial.lng
          listing.locationSource = 'spatial'
          listing.locationAccuracyM = Math.max(100, Math.round(spatial.residualM + 100))
          listing.locationAnchorCount = spatial.anchorCount
          listing.locationPrecision = 'spatial'
          listing.locationApproximate = true
          listing.locationRole = 'inferred'
          placed = true
        }
      }
    }
    if (placed) continue

    for (const candidate of broadCandidates) {
      const coords = await lookup(candidate)
      if (!coords) continue
      applyCandidate(listing, candidate, coords)
      placed = true
      break
    }
    if (placed) continue

    for (const candidate of nearbyCandidates) {
      const coords = await lookup(candidate)
      if (!coords) continue
      candidate.accuracyM = Math.max(candidate.accuracyM || 0, candidate.distanceM || 900)
      candidate.approximate = true
      applyCandidate(listing, candidate, coords)
      placed = true
      break
    }
  }

  await applyReverseGeo(listings, country)
  const placed = await annotateFromPlaces(listings, country)
  if (!placed) {
    await assignNearestMetro(listings, country, (query) => lookup({ q: query }))
  }

  return listings
}

async function annotateFromPlaces(listings, country) {
  const cities = new Set(
    listings
      .filter((listing) => Number.isFinite(listing.lat) && Number.isFinite(listing.lng))
      .map((listing) => listing.city || country?.cities?.[0] || ''),
  )
  let annotated = 0

  for (const city of cities) {
    if (!city) continue
    try {
      const rows = await loadCityPlaces(country?.code, city)
      if (!rows.length) continue
      const batch = listings.filter((listing) => (listing.city || country?.cities?.[0]) === city)
      annotated += annotateListings(batch, rows)
    } catch (error) {
      console.warn(`[places] lookup for ${city} failed:`, error?.message || error)
    }
  }

  if (annotated) console.log(`[places] annotated ${annotated} listings from the places table`)
  return annotated > 0
}
