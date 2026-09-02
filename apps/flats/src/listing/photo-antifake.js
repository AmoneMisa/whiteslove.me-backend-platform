import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {pool} from '../infrastructure/database/pool.js';

const MAX_IMAGE_BYTES = Math.max(256_000, Number(process.env.ANTIFAKE_MAX_IMAGE_BYTES) || 8 * 1024 * 1024);
const FETCH_TIMEOUT_MS = Math.max(2000, Number(process.env.ANTIFAKE_IMAGE_TIMEOUT_MS) || 8000);
const PRICE_CONFLICT_PCT = Math.max(5, Number(process.env.ANTIFAKE_PRICE_CONFLICT_PCT) || 15);
const CHRONOLOGY_GAP_MS = Math.max(60_000, (Number(process.env.ANTIFAKE_CHRONOLOGY_GAP_MINUTES) || 15) * 60_000);
const PERCEPTUAL_MAX_DISTANCE = Math.max(0, Math.min(7, Number(process.env.ANTIFAKE_PERCEPTUAL_MAX_DISTANCE) || 7));
const PERCEPTUAL_HASH_SCRIPT = fileURLToPath(new URL('./perceptual-hash.py', import.meta.url));

function runPerceptualHash(bytes) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.ANTIFAKE_PYTHON || 'python3', [PERCEPTUAL_HASH_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      const hash = stdout.trim().toLowerCase();
      if (code === 0 && /^[0-9a-f]{16}$/.test(hash)) resolve(hash);
      else reject(new Error(stderr.trim() || `perceptual hash exited ${code}`));
    });
    child.stdin.end(bytes);
  });
}

async function hashRemoteImage(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'image/*' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const declared = Number(response.headers.get('content-length')) || 0;
  if (declared > MAX_IMAGE_BYTES) throw new Error('image too large');
  const type = String(response.headers.get('content-type') || '').toLowerCase();
  if (type && !type.startsWith('image/')) throw new Error(`not an image: ${type}`);

  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('invalid image size');
  const exactHash = createHash('sha256').update(bytes).digest('hex');
  let perceptualHash = null;
  try {
    perceptualHash = await runPerceptualHash(bytes);
  } catch (error) {
    console.warn(`[flats:antifake] perceptual hash unavailable: ${error.message}`);
  }
  return { exactHash, perceptualHash };
}

function listingIdentity(listing) {
  return {
    source: String(listing.source || '').toLowerCase(),
    country: String(listing.country || '').toUpperCase(),
    sourceId: String(listing.id),
    city: String(listing.city || ''),
  };
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parsedTime(value) {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function normalizeLocationValue(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textTokens(value) {
  return new Set(
    String(value || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 3),
  );
}

function titleSimilarity(a, b) {
  const left = textTokens(a);
  const right = textTokens(b);
  if (!left.size || !right.size) return null;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  const union = new Set([...left, ...right]).size;
  return union ? overlap / union : null;
}

export function hammingDistanceHex(a, b) {
  const left = String(a || '').toLowerCase();
  const right = String(b || '').toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(left) || !/^[0-9a-f]{16}$/.test(right)) return null;
  let bits = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let distance = 0;
  while (bits) {
    distance += Number(bits & 1n);
    bits >>= 1n;
  }
  return distance;
}

export function compareListingLocations(current, matched) {
  const currentCountry = String(current?.country || '').toUpperCase();
  const matchedCountry = String(matched?.country || matched?.matchedCountry || '').toUpperCase();
  const countryConflict = Boolean(currentCountry && matchedCountry && currentCountry !== matchedCountry);

  const fields = [
    ['city', current?.city, matched?.city ?? matched?.matchedCity],
    ['district', current?.district, matched?.district ?? matched?.matchedDistrict],
    ['metro', current?.metro, matched?.metro ?? matched?.matchedMetro],
    ['residence_complex', current?.residenceComplex, matched?.residence_complex ?? matched?.residenceComplex],
  ];
  const conflicts = [];
  const agreements = [];
  for (const [field, leftRaw, rightRaw] of fields) {
    const left = normalizeLocationValue(leftRaw);
    const right = normalizeLocationValue(rightRaw);
    if (!left || !right) continue;
    if (left === right) agreements.push(field);
    else conflicts.push(field);
  }

  let level = 'none';
  if (countryConflict || conflicts.includes('city')) level = 'very_high';
  else if (conflicts.includes('district') && conflicts.includes('metro')) level = 'high';
  else if (conflicts.includes('district') || conflicts.includes('metro')) level = 'medium';
  else if (conflicts.includes('residence_complex')) level = 'low';

  return {
    level,
    countryConflict,
    conflicts,
    agreements,
    reasonCodes: [
      ...(countryConflict ? ['location_country_conflict'] : []),
      ...conflicts.map((field) => `location_${field}_conflict`),
    ],
  };
}

/**
 * Score the relationship between two listings that share an exact or perceptual
 * photo match. Cheaper is not synonymous with fraud: a broker can copy an owner
 * and mark the price up, while a scammer can undercut it. Chronology, seller
 * type, price direction, property facts and location contradictions stay as
 * independent evidence.
 */
export function scoreCloneRelationship(current, matched, evidence = {}) {
  const currentCreated = parsedTime(current?.createdAt);
  const matchedCreated = parsedTime(matched?.created_at ?? matched?.createdAt);
  const chronology = currentCreated != null && matchedCreated != null
    ? currentCreated - matchedCreated > CHRONOLOGY_GAP_MS
      ? 'later_copy_candidate'
      : matchedCreated - currentCreated > CHRONOLOGY_GAP_MS
        ? 'earlier_source_candidate'
        : 'ambiguous'
    : 'unknown';

  const currentAgency = current?.byAgency == null ? null : Boolean(current.byAgency);
  const matchedAgencyRaw = matched?.by_agency ?? matched?.byAgency;
  const matchedAgency = matchedAgencyRaw == null ? null : Boolean(matchedAgencyRaw);
  const sellerRelation = currentAgency == null || matchedAgency == null
    ? 'unknown'
    : currentAgency === matchedAgency
      ? 'same'
      : !matchedAgency && currentAgency
        ? 'owner_to_agency'
        : 'agency_to_owner';

  const currentPrice = finiteNumber(current?.price);
  const matchedPrice = finiteNumber(matched?.price);
  const currentCurrency = String(current?.currency || '').toUpperCase();
  const matchedCurrency = String(matched?.currency || '').toUpperCase();
  const comparablePrice = currentPrice != null && currentPrice > 0 && matchedPrice != null && matchedPrice > 0
    && currentCurrency && currentCurrency === matchedCurrency;
  const priceDeltaPct = comparablePrice ? ((currentPrice - matchedPrice) / matchedPrice) * 100 : null;
  const priceDirection = priceDeltaPct == null
    ? 'unknown'
    : Math.abs(priceDeltaPct) < 8
      ? 'similar'
      : priceDeltaPct > 0
        ? 'higher'
        : 'lower';

  const currentRooms = finiteNumber(current?.rooms);
  const matchedRooms = finiteNumber(matched?.rooms);
  const roomsAgree = currentRooms == null || matchedRooms == null ? null : currentRooms === matchedRooms;
  const currentArea = finiteNumber(current?.areaSqm);
  const matchedArea = finiteNumber(matched?.area_sqm ?? matched?.areaSqm);
  const areaAgree = currentArea == null || matchedArea == null
    ? null
    : Math.abs(currentArea - matchedArea) <= Math.max(2, matchedArea * 0.05);
  const titleScore = titleSimilarity(current?.title, matched?.title);
  const factsAgree = [roomsAgree, areaAgree, titleScore == null ? null : titleScore >= 0.55]
    .filter((value) => value != null);
  const propertyFactsConsistent = factsAgree.length
    ? factsAgree.filter(Boolean).length >= Math.ceil(factsAgree.length / 2)
    : false;

  const location = compareListingLocations(current, {
    country: matched?.country ?? matched?.matchedCountry,
    city: matched?.city ?? matched?.matchedCity,
    district: matched?.district ?? matched?.matchedDistrict,
    metro: matched?.metro ?? matched?.matchedMetro,
    residence_complex: matched?.residence_complex ?? matched?.residenceComplex,
  });
  const matchType = evidence.matchType === 'perceptual' ? 'perceptual' : 'exact';
  const perceptualDistance = finiteNumber(evidence.perceptualDistance);

  let score = matchType === 'exact' ? 35 : 30;
  if (matchType === 'perceptual' && perceptualDistance != null && perceptualDistance <= 3) score += 5;
  if (propertyFactsConsistent) score += 10;
  if (sellerRelation !== 'same' && sellerRelation !== 'unknown') score += 10;
  if (priceDeltaPct != null && Math.abs(priceDeltaPct) >= PRICE_CONFLICT_PCT) score += 20;
  if (chronology === 'later_copy_candidate') score += 15;
  if (location.level === 'medium') score += 10;
  if (location.level === 'high') score += 20;
  if (location.level === 'very_high') score += 30;
  score = Math.min(100, score);

  const currentCopyCandidate = chronology === 'later_copy_candidate' && score >= 60;
  const matchedCopyCandidate = chronology === 'earlier_source_candidate' && score >= 60;
  const reasonCodes = [
    matchType === 'exact' ? 'photo_exact_match' : 'photo_perceptual_match',
    ...location.reasonCodes,
    ...(propertyFactsConsistent ? ['property_facts_consistent'] : []),
    ...(sellerRelation !== 'same' && sellerRelation !== 'unknown' ? ['seller_type_conflict'] : []),
    ...(priceDeltaPct != null && Math.abs(priceDeltaPct) >= PRICE_CONFLICT_PCT ? ['price_conflict'] : []),
    ...(chronology === 'later_copy_candidate' ? ['current_listing_later'] : []),
    ...(chronology === 'earlier_source_candidate' ? ['matched_listing_later'] : []),
  ];

  let reason = 'duplicate_listing';
  if (currentCopyCandidate && location.level === 'very_high') {
    reason = 'possible_location_spoofed_copy';
  } else if (currentCopyCandidate && sellerRelation === 'owner_to_agency' && priceDirection === 'higher') {
    reason = 'possible_broker_markup_copy';
  } else if (currentCopyCandidate && priceDirection === 'lower' && priceDeltaPct != null && Math.abs(priceDeltaPct) >= PRICE_CONFLICT_PCT) {
    reason = 'possible_low_price_copy';
  } else if (currentCopyCandidate && sellerRelation !== 'same' && sellerRelation !== 'unknown') {
    reason = 'possible_republished_copy';
  } else if (matchedCopyCandidate) {
    reason = 'matched_listing_may_be_copy';
  } else if (location.level === 'very_high' || location.level === 'high') {
    reason = 'conflicting_duplicate_location';
  } else if (priceDeltaPct != null && Math.abs(priceDeltaPct) >= PRICE_CONFLICT_PCT) {
    reason = 'conflicting_duplicate_price';
  }

  return {
    score,
    reason,
    reasonCodes: [...new Set(reasonCodes)],
    chronology,
    sellerRelation,
    priceDirection,
    priceDeltaPct: priceDeltaPct == null ? null : Math.round(priceDeltaPct * 10) / 10,
    propertyFactsConsistent,
    titleSimilarity: titleScore == null ? null : Math.round(titleScore * 100) / 100,
    locationConflict: location,
    matchType,
    perceptualDistance,
    currentCopyCandidate,
    matchedCopyCandidate,
  };
}

export function isPropertyClusterMatch(match) {
  if (!match?.relation) return false;
  const exactCount = Number(match.exactPhotoCount || 0);
  const perceptualCount = Number(match.perceptualPhotoCount || 0);
  const total = Number(match.matchedPhotoCount || exactCount + perceptualCount || 0);
  if (exactCount >= 2 || perceptualCount >= 2) return true;
  if (exactCount >= 1 && match.relation.propertyFactsConsistent) return true;
  if (perceptualCount >= 1 && match.relation.propertyFactsConsistent && match.relation.score >= 55) return true;
  return total >= 1 && ['high', 'very_high'].includes(match.relation.locationConflict?.level) && match.relation.score >= 65;
}

function photoRowKey(row) {
  return `${row.source}:${row.country}:${row.source_id}:${row.photo_url}`;
}

async function exactMatches(exactHash, identity) {
  const result = await pool.query(
    `SELECT source, country, source_id, city, district, metro, residence_complex, photo_url,
            hash, perceptual_hash, title, price, currency, by_agency, rooms, area_sqm,
            created_at, first_seen_at, last_seen_at
       FROM listing_photo_hashes
      WHERE hash = $1
        AND NOT (source = $2 AND country = $3 AND source_id = $4)
      ORDER BY last_seen_at DESC
      LIMIT 50`,
    [exactHash, identity.source, identity.country, identity.sourceId],
  );
  return result.rows.map((row) => ({ row, matchType: 'exact', perceptualDistance: 0 }));
}

async function perceptualMatches(perceptualHash, identity) {
  if (!/^[0-9a-f]{16}$/.test(String(perceptualHash || ''))) return [];
  const result = await pool.query(
    `SELECT source, country, source_id, city, district, metro, residence_complex, photo_url,
            hash, perceptual_hash, title, price, currency, by_agency, rooms, area_sqm,
            created_at, first_seen_at, last_seen_at
       FROM listing_photo_hashes
      WHERE country = $1
        AND perceptual_hash IS NOT NULL
        AND NOT (source = $2 AND country = $1 AND source_id = $3)
        AND (
          SUBSTRING(perceptual_hash FROM 1 FOR 2) = SUBSTRING($4::text FROM 1 FOR 2)
          OR SUBSTRING(perceptual_hash FROM 3 FOR 2) = SUBSTRING($4::text FROM 3 FOR 2)
          OR SUBSTRING(perceptual_hash FROM 5 FOR 2) = SUBSTRING($4::text FROM 5 FOR 2)
          OR SUBSTRING(perceptual_hash FROM 7 FOR 2) = SUBSTRING($4::text FROM 7 FOR 2)
          OR SUBSTRING(perceptual_hash FROM 9 FOR 2) = SUBSTRING($4::text FROM 9 FOR 2)
          OR SUBSTRING(perceptual_hash FROM 11 FOR 2) = SUBSTRING($4::text FROM 11 FOR 2)
          OR SUBSTRING(perceptual_hash FROM 13 FOR 2) = SUBSTRING($4::text FROM 13 FOR 2)
          OR SUBSTRING(perceptual_hash FROM 15 FOR 2) = SUBSTRING($4::text FROM 15 FOR 2)
        )
      ORDER BY last_seen_at DESC`,
    [identity.country, identity.source, identity.sourceId, perceptualHash],
  );
  const matches = [];
  for (const row of result.rows) {
    const distance = hammingDistanceHex(perceptualHash, row.perceptual_hash);
    if (distance != null && distance <= PERCEPTUAL_MAX_DISTANCE) {
      matches.push({ row, matchType: 'perceptual', perceptualDistance: distance });
    }
  }
  return matches;
}

function makeMatch(listing, image, hashes, candidate) {
  const row = candidate.row;
  const location = compareListingLocations(listing, row);
  return {
    hash: hashes.exactHash,
    perceptualHash: hashes.perceptualHash,
    matchType: candidate.matchType,
    perceptualDistance: candidate.perceptualDistance,
    photoId: image?.id || null,
    photoUrl: image.url,
    matchedSource: row.source,
    matchedCountry: row.country,
    matchedListingId: String(row.source_id),
    matchedCity: row.city || null,
    matchedDistrict: row.district || null,
    matchedMetro: row.metro || null,
    matchedResidenceComplex: row.residence_complex || null,
    matchedPhotoUrl: row.photo_url,
    crossCountry: location.countryConflict,
    crossCity: location.conflicts.includes('city'),
    relation: scoreCloneRelationship(listing, row, candidate),
  };
}

async function storePhotoHash(listing, identity, url, hashes) {
  await pool.query(
    `INSERT INTO listing_photo_hashes
      (hash, perceptual_hash, source, country, source_id, city, district, metro,
       residence_complex, photo_url, title, price, currency, by_agency, rooms,
       area_sqm, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT (hash, source, country, source_id, photo_url)
     DO UPDATE SET
       perceptual_hash = COALESCE(EXCLUDED.perceptual_hash, listing_photo_hashes.perceptual_hash),
       city = EXCLUDED.city,
       district = EXCLUDED.district,
       metro = EXCLUDED.metro,
       residence_complex = EXCLUDED.residence_complex,
       title = EXCLUDED.title,
       price = EXCLUDED.price,
       currency = EXCLUDED.currency,
       by_agency = EXCLUDED.by_agency,
       rooms = EXCLUDED.rooms,
       area_sqm = EXCLUDED.area_sqm,
       created_at = COALESCE(EXCLUDED.created_at, listing_photo_hashes.created_at),
       last_seen_at = NOW()`,
    [
      hashes.exactHash,
      hashes.perceptualHash,
      identity.source,
      identity.country,
      identity.sourceId,
      identity.city || null,
      listing.district || null,
      listing.metro || null,
      listing.residenceComplex || null,
      url,
      listing.title || null,
      finiteNumber(listing.price),
      String(listing.currency || '').toUpperCase() || null,
      listing.byAgency == null ? null : Boolean(listing.byAgency),
      finiteNumber(listing.rooms),
      finiteNumber(listing.areaSqm),
      listing.createdAt || null,
    ],
  );
}

function groupMatches(uniqueMatches) {
  const grouped = new Map();
  for (const match of uniqueMatches) {
    const key = `${match.matchedSource}:${match.matchedCountry}:${match.matchedListingId}`;
    const current = grouped.get(key) || {
      matchedSource: match.matchedSource,
      matchedCountry: match.matchedCountry,
      matchedListingId: match.matchedListingId,
      matchedCity: match.matchedCity,
      matchedDistrict: match.matchedDistrict,
      matchedMetro: match.matchedMetro,
      matchedResidenceComplex: match.matchedResidenceComplex,
      matchedPhotoCount: 0,
      exactPhotoCount: 0,
      perceptualPhotoCount: 0,
      minimumPerceptualDistance: null,
      crossCountry: false,
      crossCity: false,
      relation: match.relation,
    };
    current.matchedPhotoCount += 1;
    if (match.matchType === 'exact') current.exactPhotoCount += 1;
    else current.perceptualPhotoCount += 1;
    if (match.perceptualDistance != null) {
      current.minimumPerceptualDistance = current.minimumPerceptualDistance == null
        ? match.perceptualDistance
        : Math.min(current.minimumPerceptualDistance, match.perceptualDistance);
    }
    current.crossCountry ||= match.crossCountry;
    current.crossCity ||= match.crossCity;
    current.relation = {
      ...current.relation,
      score: Math.min(100, current.relation.score + Math.min(24, (current.matchedPhotoCount - 1) * 8)),
    };
    grouped.set(key, current);
  }
  return [...grouped.values()];
}

function memberKey(member) {
  return `${member.source}:${member.country}:${member.sourceId}`;
}

async function assignPropertyCluster(identity, cloneMatches) {
  const plausible = cloneMatches.filter(isPropertyClusterMatch);
  if (!plausible.length) return null;
  const members = [
    { source: identity.source, country: identity.country, sourceId: identity.sourceId },
    ...plausible.map((match) => ({
      source: match.matchedSource,
      country: match.matchedCountry,
      sourceId: match.matchedListingId,
    })),
  ];
  const unique = [...new Map(members.map((member) => [memberKey(member), member])).values()];
  const keys = unique.map(memberKey).sort();
  const proposedClusterId = `property:${createHash('sha256').update(keys.join('|')).digest('hex').slice(0, 20)}`;
  const payload = unique.map((member) => ({
    source: member.source,
    country: member.country,
    source_id: member.sourceId,
  }));
  const result = await pool.query(
    'SELECT merge_listing_property_cluster($1::jsonb, $2::text) AS cluster',
    [JSON.stringify(payload), proposedClusterId],
  );
  const cluster = result.rows[0]?.cluster;
  if (!cluster?.id) return null;
  return {
    id: String(cluster.id),
    size: Number(cluster.size) || 0,
    members: Array.isArray(cluster.members)
      ? cluster.members.map((member) => ({
        source: String(member.source || ''),
        country: String(member.country || '').toUpperCase(),
        id: String(member.id || ''),
      })).filter((member) => member.source && member.country && member.id)
      : [],
  };
}

export async function detectExactDuplicatePhotos(listing, images) {
  const identity = listingIdentity(listing);
  const matches = [];
  const hashes = [];

  for (const image of images || []) {
    const url = String(image?.url || image || '');
    if (!/^https?:\/\//i.test(url)) continue;
    const normalizedImage = { id: image?.id || null, url };

    try {
      const imageHashes = await hashRemoteImage(url);
      hashes.push({
        id: normalizedImage.id,
        url,
        hash: imageHashes.exactHash,
        perceptualHash: imageHashes.perceptualHash,
      });

      const candidates = new Map();
      for (const candidate of await exactMatches(imageHashes.exactHash, identity)) {
        candidates.set(photoRowKey(candidate.row), candidate);
      }
      for (const candidate of await perceptualMatches(imageHashes.perceptualHash, identity)) {
        const key = photoRowKey(candidate.row);
        if (!candidates.has(key)) candidates.set(key, candidate);
      }
      for (const candidate of candidates.values()) {
        matches.push(makeMatch(listing, normalizedImage, imageHashes, candidate));
      }

      await storePhotoHash(listing, identity, url, imageHashes);
    } catch (error) {
      console.warn(`[flats:antifake] ${identity.source}:${identity.sourceId} image skipped: ${error.message}`);
    }
  }

  const uniqueMatches = [...new Map(matches.map((match) => [
    `${match.matchType}:${match.matchedSource}:${match.matchedCountry}:${match.matchedListingId}:${match.matchedPhotoUrl}:${match.photoUrl}`,
    match,
  ])).values()];
  const cloneMatches = groupMatches(uniqueMatches);
  const propertyCluster = await assignPropertyCluster(identity, cloneMatches);

  const crossCountry = uniqueMatches.some((match) => match.crossCountry);
  const crossCity = uniqueMatches.some((match) => match.crossCity);
  const strongLocationConflict = cloneMatches.some((match) =>
    isPropertyClusterMatch(match) && ['high', 'very_high'].includes(match.relation.locationConflict?.level),
  );
  const currentCopyCandidate = cloneMatches.some((match) => match.relation.currentCopyCandidate && match.relation.score >= 70);
  const matchedCopyCandidate = cloneMatches.some((match) => match.relation.matchedCopyCandidate && match.relation.score >= 70);
  const conflictingClone = cloneMatches.some((match) =>
    match.relation.score >= 65 && (
      match.relation.priceDirection === 'higher'
      || match.relation.priceDirection === 'lower'
      || match.relation.sellerRelation !== 'same'
      || ['high', 'very_high'].includes(match.relation.locationConflict?.level)
    ),
  );

  const reasonCodes = [...new Set(cloneMatches.flatMap((match) => match.relation.reasonCodes || []))];
  const risk = crossCountry || strongLocationConflict
    ? 'very_high'
    : crossCity || currentCopyCandidate || conflictingClone
      ? 'high'
      : uniqueMatches.length
        ? 'medium'
        : 'none';

  return {
    exactDuplicatePhoto: uniqueMatches.some((match) => match.matchType === 'exact'),
    perceptualDuplicatePhoto: uniqueMatches.some((match) => match.matchType === 'perceptual'),
    suspectedClone: currentCopyCandidate,
    matchedListingMayBeClone: matchedCopyCandidate,
    conflictingClone,
    propertyIdentityConflict: strongLocationConflict ? 'high' : crossCity ? 'medium' : 'none',
    propertyCluster,
    reasonCodes,
    risk,
    hashes: hashes.map(({ id, hash, perceptualHash }) => ({ id, hash, perceptualHash })),
    matches: uniqueMatches,
    cloneMatches,
    checkedAt: new Date().toISOString(),
  };
}