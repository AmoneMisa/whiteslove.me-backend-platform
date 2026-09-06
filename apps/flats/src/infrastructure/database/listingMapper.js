import {canonicalCity} from '@whiteslove/parsing-lexicon/geography';
import {buildResidentialCoordinateBackfillPatch} from '../../geo/residential-coordinate-backfill.js';
import {enrichListingDetails} from '../../listing/listing-enrichment.js';

function finiteNumber(value) {
    if (
        value === null ||
        value === undefined ||
        value === ''
    ) {
        return null;
    }

    const number = Number(value);

    return Number.isFinite(number)
        ? number
        : null;
}

function finiteInteger(value) {
    const number =
        finiteNumber(value);

    return number == null
        ? null
        : Math.trunc(number);
}

function safeTimestamp(value) {
    if (!value) {
        return null;
    }

    const time =
        Date.parse(value);

    if (!Number.isFinite(time)) {
        return null;
    }

    return new Date(time)
        .toISOString();
}

function preserveStablePhotoFields(data) {
    const next = {...data};
    const photos = Array.isArray(next.photos)
        ? next.photos.filter((value) => typeof value === 'string' && value.trim())
        : [];
    const photo = typeof next.photo === 'string' && next.photo.trim()
        ? next.photo.trim()
        : null;

    // Source pages occasionally omit their media block during a crawl. The
    // repository merges JSONB with the new snapshot on the right, so persisting
    // photo:null / photos:[] here would erase previously valid images. Omit only
    // empty photo fields; a later non-empty snapshot still replaces them.
    if (photos.length) {
        next.photos = photos;
    } else {
        delete next.photos;
    }

    if (photo) {
        next.photo = photo;
    } else if (photos.length) {
        next.photo = photos[0];
    } else {
        delete next.photo;
    }

    return next;
}

export function mapListingToRow(inputListing) {
    const enriched = enrichListingDetails(inputListing);
    const coordinatePatch = buildResidentialCoordinateBackfillPatch(enriched);
    const listing = coordinatePatch ? {...enriched, ...coordinatePatch} : enriched;
    const country = String(listing.country || '').toUpperCase();
    const sourceCity = String(listing.city || '').trim();
    const city = sourceCity ? (canonicalCity(sourceCity, country) || sourceCity) : null;
    const normalizedData = city && sourceCity && city !== sourceCity
        ? {...listing, city, sourceCity}
        : {...listing, city};
    const data = preserveStablePhotoFields(normalizedData);

    return {
        source:
            String(
                listing.source || '',
            ).toLowerCase(),

        country,

        source_id:
            String(
                listing.id,
            ),

        title:
            listing.title ?? '',

        description:
            listing.description ?? '',

        property_type:
            listing.propertyType ?? null,

        deal_type:
            listing.dealType ?? null,

        city,

        district:
            listing.district ?? null,

        area:
            listing.area ??
            listing.kvartal ??
            null,

        metro:
            listing.metro ?? null,

        address:
            listing.address ?? null,

        residence_complex:
            listing.residenceComplex ?? null,

        price:
            finiteNumber(
                listing.price,
            ),

        currency:
            listing.currency ?? null,

        rooms:
            finiteInteger(
                listing.rooms,
            ),

        area_sqm:
            finiteNumber(
                listing.areaSqm,
            ),

        by_agency:
            Boolean(
                listing.byAgency,
            ),

        created_at:
            safeTimestamp(
                listing.createdAt,
            ),

        // Полный normalized Listing.
        // ES позже будем строить именно из него.
        data,
    };
}

