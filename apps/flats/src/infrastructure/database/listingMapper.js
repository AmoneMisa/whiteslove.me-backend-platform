import {canonicalCity} from '@whiteslove/parsing-lexicon/geography';
import {enrichListingDetails} from '../../listing-enrichment.js';

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

export function mapListingToRow(inputListing) {
    const listing = enrichListingDetails(inputListing);
    const country = String(listing.country || '').toUpperCase();
    const sourceCity = String(listing.city || '').trim();
    const city = sourceCity ? (canonicalCity(sourceCity, country) || sourceCity) : null;
    const data = city && sourceCity && city !== sourceCity ? {...listing, city, sourceCity} : {...listing, city};

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

