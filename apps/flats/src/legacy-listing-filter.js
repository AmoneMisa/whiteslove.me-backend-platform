import {toUsd} from './fx.js';
import { resolveHousingIntent } from '@whiteslove/parsing-lexicon/housing-intent';
import {MAX_AGE_MS} from './listing-policy.js';

function normCity(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function applyListingFilters(listings, filters, rates = null) {
  const {
    propertyType,
    agency,
    priceMin,
    priceMax,
    priceTolerance,
    priceCurrency,
    query,
    dealType,
    roomsMin,
    roomsMax,
    bedroomsMin,
    bedroomsMax,
    areaMin,
    areaMax,
    pricePerSqmMin,
    pricePerSqmMax,
    floorMin,
    floorMax,
    totalFloorsMin,
    totalFloorsMax,
    yearMin,
    yearMax,
    newBuilding,
    audience,
    city,
    cityAliases,
    district,
    metro,
    metroMaxM,
    nearbyMaxM,
    nearbyKind,
    listingId,
    pets,
    children,
    roomOnly,
    dishwasher,
    airConditioner,
    parking,
    internet,
    gas,
    balcony,
    terrace,
    privateYard,
    tv,
    microwave,
    oven,
    bidet,
    walkInCloset,
    bathtub,
    shower,
    euroLayout,
    noElevator,
    noDeposit,
    communalIncluded,
    noCommission,
    commissionPercentMin,
    commissionPercentMax,
    maxAgeDays,
    sources,
  } = filters;

  const convertPrices = Boolean(rates && priceCurrency);
  const now = Date.now();
  const ageCapMs = maxAgeDays != null && maxAgeDays > 0
    ? Math.min(maxAgeDays * 24 * 60 * 60 * 1000, MAX_AGE_MS)
    : MAX_AGE_MS;
  const cityForms = city
    ? (cityAliases?.length ? cityAliases : [city]).map(normCity)
    : null;

  return listings.filter((listing) => {
    if (listingId && String(listing.id) !== String(listingId)) return false;
    if (
      sources?.length &&
      !sources.includes(String(listing.source).toLowerCase())
    ) {
      return false;
    }

    if (String(listing.source).toLowerCase() === 'telegram') {
      const listingText = [listing.title, listing.description]
        .filter(Boolean)
        .join('\n');
      if (resolveHousingIntent(listingText)?.listingKind === 'propertyWanted') return false;
    }

    // `dealType` is a public API filter and mobile exposes shortRent explicitly.
    // Do not silently remove short-stay inventory here: the PostgreSQL path
    // already treats it like every other deal type.
    if (listing.commercial) return false;

    if (listing.createdAt) {
      const createdAt = Date.parse(listing.createdAt);
      if (!Number.isNaN(createdAt) && now - createdAt > ageCapMs) return false;
    }

    if (
      propertyType &&
      propertyType !== 'any' &&
      listing.propertyType !== propertyType
    ) {
      return false;
    }
    if (dealType && dealType !== 'any' && listing.dealType !== dealType) {
      return false;
    }

    if (agency === 'agency' && !listing.byAgency) return false;
    if (agency === 'owner' && listing.byAgency) return false;

    const effectiveMax = priceMax != null
      ? priceMax + (priceTolerance ?? 0)
      : null;

    if (priceMin != null || effectiveMax != null) {
      if (convertPrices) {
        const listingUsd = toUsd(listing.price, listing.currency, rates);
        if (listingUsd == null) return false;

        if (priceMin != null) {
          const minUsd = toUsd(priceMin, priceCurrency, rates);
          if (minUsd != null && listingUsd < minUsd) return false;
        }
        if (effectiveMax != null) {
          const maxUsd = toUsd(effectiveMax, priceCurrency, rates);
          if (maxUsd != null && listingUsd > maxUsd) return false;
        }
      } else {
        if (priceMin != null && (listing.price == null || listing.price < priceMin)) {
          return false;
        }
        if (
          effectiveMax != null &&
          (listing.price == null || listing.price > effectiveMax)
        ) {
          return false;
        }
      }
    }

    if (roomsMin != null && (listing.rooms == null || listing.rooms < roomsMin)) return false;
    if (roomsMax != null && (listing.rooms == null || listing.rooms > roomsMax)) return false;
    if (
      bedroomsMin != null &&
      (listing.bedrooms == null || listing.bedrooms < bedroomsMin)
    ) {
      return false;
    }
    if (
      bedroomsMax != null &&
      (listing.bedrooms == null || listing.bedrooms > bedroomsMax)
    ) {
      return false;
    }
    if (areaMin != null && (listing.areaSqm == null || listing.areaSqm < areaMin)) return false;
    if (areaMax != null && (listing.areaSqm == null || listing.areaSqm > areaMax)) return false;

    if (pricePerSqmMin != null || pricePerSqmMax != null) {
      const area = listing.areaSqm;
      if (area == null || !(area > 0)) return false;

      if (convertPrices) {
        const listingUsd = toUsd(listing.price, listing.currency, rates);
        if (listingUsd == null) return false;
        const perSqm = listingUsd / area;

        if (pricePerSqmMin != null) {
          const minUsd = toUsd(pricePerSqmMin, priceCurrency, rates);
          if (minUsd != null && perSqm < minUsd) return false;
        }
        if (pricePerSqmMax != null) {
          const maxUsd = toUsd(pricePerSqmMax, priceCurrency, rates);
          if (maxUsd != null && perSqm > maxUsd) return false;
        }
      } else {
        if (listing.price == null) return false;
        const perSqm = listing.price / area;
        if (pricePerSqmMin != null && perSqm < pricePerSqmMin) return false;
        if (pricePerSqmMax != null && perSqm > pricePerSqmMax) return false;
      }
    }

    if (floorMin != null && (listing.floor == null || listing.floor < floorMin)) return false;
    if (floorMax != null && (listing.floor == null || listing.floor > floorMax)) return false;
    if (
      totalFloorsMin != null &&
      (listing.totalFloors == null || listing.totalFloors < totalFloorsMin)
    ) {
      return false;
    }
    if (
      totalFloorsMax != null &&
      (listing.totalFloors == null || listing.totalFloors > totalFloorsMax)
    ) {
      return false;
    }
    if (
      yearMin != null &&
      (listing.buildingYear == null || listing.buildingYear < yearMin)
    ) {
      return false;
    }
    if (
      yearMax != null &&
      (listing.buildingYear == null || listing.buildingYear > yearMax)
    ) {
      return false;
    }

    if (newBuilding === true && listing.newBuilding !== true) return false;
    if (audience && audience !== 'any' && listing.audience !== audience) return false;
    if (pets === true && listing.petsAllowed !== true) return false;
    if (children === true && listing.childrenAllowed === false) return false;
    if (roomOnly === true && !listing.roomOnly) return false;

    // Tri-state fields: an explicit "false" is required to match, not merely
    // "not true" -- unparsed listings shouldn't count as a match either way.
    if (noElevator === true && listing.elevator !== false) return false;
    if (noDeposit === true && listing.deposit !== false) return false;
    if (communalIncluded === true && listing.communalSeparated !== false) return false;
    if (noCommission === true && listing.commission !== false && listing.commissionPercent !== 0) return false;
    if (commissionPercentMin != null || commissionPercentMax != null) {
      if (typeof listing.commissionPercent !== 'number') return false;
      if (commissionPercentMin != null && listing.commissionPercent < commissionPercentMin) return false;
      if (commissionPercentMax != null && listing.commissionPercent > commissionPercentMax) return false;
    }

    const requiredAmenities = [
      ['dishwasher', dishwasher],
      ['airConditioner', airConditioner],
      ['parking', parking],
      ['internet', internet],
      ['gas', gas],
      ['balcony', balcony],
      ['terrace', terrace],
      ['privateYard', privateYard],
      ['tv', tv],
      ['microwave', microwave],
      ['oven', oven],
      ['bidet', bidet],
      ['walkInCloset', walkInCloset],
      ['bathtub', bathtub],
      ['shower', shower],
      ['euroLayout', euroLayout],
    ];
    for (const [field, required] of requiredAmenities) {
      if (required === true && listing[field] !== true) return false;
    }

    if (cityForms) {
      const listingCity = normCity(listing.city);
      if (!cityForms.includes(listingCity)) return false;
    }
    if (
      district &&
      (listing.district ?? '').toLowerCase() !== String(district).toLowerCase()
    ) {
      return false;
    }
    if (
      metro &&
      (listing.metro ?? '').toLowerCase() !== String(metro).toLowerCase()
    ) {
      return false;
    }

    if (metroMaxM != null) {
      const distance = listing.metroDistanceM ?? listing.metroNearby?.[0]?.distanceM;
      if (distance == null || distance > metroMaxM) return false;
    }

    if (nearbyKind || nearbyMaxM != null) {
      const places = (listing.nearbyPlaces ?? []).filter((place) =>
        !nearbyKind || String(place.kind).toLowerCase() === nearbyKind,
      );
      if (!places.length) return false;
      if (
        nearbyMaxM != null &&
        !places.some((place) =>
          place.distanceM != null && place.distanceM <= nearbyMaxM,
        )
      ) {
        return false;
      }
    }

    if (query) {
      const haystack = [
        listing.title,
        listing.description,
        listing.city,
        listing.region,
        listing.district,
        listing.microdistrict,
        listing.metro,
        listing.residenceComplex,
        ...(Array.isArray(listing.tags) ? listing.tags : []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(String(query).toLowerCase())) return false;
    }

    return true;
  });
}
