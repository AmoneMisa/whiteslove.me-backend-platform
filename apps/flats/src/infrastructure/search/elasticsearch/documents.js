import {client, SEARCH_INDEX} from './client.js';

function documentId(listing) {
    return [
        String(listing.source || '').toLowerCase(),
        String(listing.country || '').toUpperCase(),
        String(listing.id),
    ].join(':');
}

function validCoordinate(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function toSearchDocument(listing, metadata = {}) {
    const lat = validCoordinate(listing.lat);
    const lng = validCoordinate(listing.lng);

    const placeNames = [
        ...(listing.metroNearby || []),
        ...(listing.nearbyPlaces || []),
        ...(listing.landmarksNearby || []),
    ]
        .map((place) => place?.name)
        .filter(Boolean);

    const document = {
        ...listing,
        ...(placeNames.length
            ? {placeNames: [...new Set(placeNames)]}
            : {}),
        id: String(listing.id),
        source: String(listing.source || '').toLowerCase(),
        country: String(listing.country || '').toUpperCase(),
        active: metadata.active ?? true,
    };

    if (metadata.firstSeenAt) {
        document.firstSeenAt = metadata.firstSeenAt;
    }

    if (metadata.lastSeenAt) {
        document.lastSeenAt = metadata.lastSeenAt;
    }

    if (metadata.updatedAt) {
        document.updatedAt = metadata.updatedAt;
    }

    if (lat != null && lng != null) {
        document.location = {lat, lon: lng};
    }

    return document;
}

export async function indexListings(listings) {
    if (!Array.isArray(listings) || !listings.length) {
        return 0;
    }

    const unique = new Map();

    for (const listing of listings) {
        if (
            !listing?.source ||
            !listing?.country ||
            listing?.id == null
        ) {
            continue;
        }

        unique.set(documentId(listing), listing);
    }

    if (!unique.size) {
        return 0;
    }

    const operations = [];

    for (const [id, listing] of unique) {
        operations.push({index: {_index: SEARCH_INDEX, _id: id}});
        operations.push(toSearchDocument(listing));
    }

    const result = await client.bulk({operations, refresh: false});

    if (result.errors) {
        const failures = [];

        for (const item of result.items || []) {
            const operation =
                item.index || item.create || item.update || item.delete;

            if (operation?.error) {
                failures.push({
                    id: operation._id,
                    status: operation.status,
                    error: operation.error?.reason,
                });
            }

            if (failures.length >= 10) {
                break;
            }
        }

        throw new Error(
            `Elasticsearch bulk indexing failed: ${JSON.stringify(failures)}`,
        );
    }

    return unique.size;
}

export async function indexDbRows(rows) {
    if (!Array.isArray(rows) || !rows.length) {
        return 0;
    }

    const operations = [];

    for (const row of rows) {
        const listing = {
            ...(row.data || {}),
            id: String(row.source_id),
            source: row.source,
            country: row.country,
        };

        operations.push({
            index: {_index: SEARCH_INDEX, _id: documentId(listing)},
        });

        operations.push(
            toSearchDocument(listing, {
                active: true,
                firstSeenAt: row.first_seen_at,
                lastSeenAt: row.last_seen_at,
                updatedAt: row.updated_at,
            }),
        );
    }

    const result = await client.bulk({operations, refresh: false});

    if (result.errors) {
        const failed = (result.items || [])
            .filter((item) => item.index?.error)
            .slice(0, 10)
            .map((item) => ({
                id: item.index?._id,
                error: item.index?.error?.reason,
            }));

        throw new Error(
            `Elasticsearch DB bulk failed: ${JSON.stringify(failed)}`,
        );
    }

    return rows.length;
}

export async function deleteListingDocuments(listings) {
    if (!Array.isArray(listings) || !listings.length) {
        return 0;
    }

    const ids = new Set();

    for (const listing of listings) {
        if (
            !listing?.source ||
            !listing?.country ||
            listing?.id == null
        ) {
            continue;
        }

        ids.add(documentId(listing));
    }

    if (!ids.size) {
        return 0;
    }

    const operations = [];

    for (const id of ids) {
        operations.push({delete: {_index: SEARCH_INDEX, _id: id}});
    }

    const result = await client.bulk({operations, refresh: false});

    const fatalErrors = (result.items || [])
        .map((item) => item.delete)
        .filter((item) => item?.error && item.status !== 404);

    if (fatalErrors.length) {
        throw new Error(
            `Elasticsearch delete failed: ${JSON.stringify(fatalErrors.slice(0, 10))}`,
        );
    }

    return ids.size;
}
