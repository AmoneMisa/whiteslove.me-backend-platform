import {
    Client,
} from '@elastic/elasticsearch';

import {
    getActiveListingsBatch,
} from '../../db.js';

const ELASTICSEARCH_URL =
    process.env.ELASTICSEARCH_URL ||
    'http://flat-finder-elasticsearch:9200';

export const SEARCH_INDEX =
    process.env.ELASTICSEARCH_INDEX ||
    'flat-listings-v1';

const client =
    new Client({
        node:
        ELASTICSEARCH_URL,

        maxRetries: 3,

        requestTimeout:
            15_000,
    });

function searchableText() {
    return {
        type: 'text',

        analyzer:
            'flat_text',

        fields: {
            latin: {
                type: 'text',
                analyzer:
                    'flat_latin',
            },
        },
    };
}

function locationText() {
    return {
        type: 'text',

        analyzer:
            'flat_text',

        fields: {
            latin: {
                type: 'text',
                analyzer:
                    'flat_latin',
            },

            raw: {
                type: 'keyword',
                normalizer:
                    'flat_keyword',
            },
        },
    };
}

function indexDefinition() {
    return {
        settings: {
            number_of_shards: 1,

            number_of_replicas: 0,

            analysis: {
                filter: {
                    flat_ascii: {
                        type:
                            'asciifolding',

                        preserve_original:
                            true,
                    },

                    flat_transliteration: {
                        type:
                            'icu_transform',

                        id:
                            'Any-Latin; ' +
                            'NFD; ' +
                            '[:Nonspacing Mark:] Remove; ' +
                            'NFC',
                    },
                },

                analyzer: {
                    /*
                     * Обычный текст:
                     *
                     * București → bucuresti
                     * CHILANZAR → chilanzar
                     */
                    flat_text: {
                        type:
                            'custom',

                        tokenizer:
                            'standard',

                        filter: [
                            'lowercase',
                            'flat_ascii',
                        ],
                    },

                    /*
                     * Транслитерированное поле:
                     *
                     * Чиланзар → cilanzar
                     * квартира → kvartira
                     */
                    flat_latin: {
                        type:
                            'custom',

                        tokenizer:
                            'standard',

                        filter: [
                            'flat_transliteration',
                            'lowercase',
                            'flat_ascii',
                        ],
                    },
                },

                normalizer: {
                    flat_keyword: {
                        type:
                            'custom',

                        filter: [
                            'lowercase',
                            'asciifolding',
                        ],
                    },
                },
            },
        },

        mappings: {
            /*
             * Новые поля Listing можно
             * хранить в _source, но они
             * автоматически не создадут
             * тысячи mappings.
             */
            dynamic: false,

            properties: {
                id: {
                    type:
                        'keyword',
                },

                source: {
                    type:
                        'keyword',
                },

                country: {
                    type:
                        'keyword',
                },

                title:
                    searchableText(),

                description:
                    searchableText(),

                propertyType: {
                    type:
                        'keyword',
                },

                dealType: {
                    type:
                        'keyword',
                },

                city:
                    locationText(),

                district:
                    locationText(),

                area:
                    locationText(),

                kvartal:
                    locationText(),

                metro:
                    locationText(),

                microdistrict:
                    locationText(),

                address:
                    locationText(),

                /*
                 * Что вокруг дома —
                 * заполняется по координатам
                 * (nearby-places.js) из
                 * таблицы places.
                 *
                 * nested, а не object:
                 * иначе «Новза ближе 500 м»
                 * совпадёт с любым домом, у
                 * которого есть и Новза, и
                 * что-нибудь в 500 м — но
                 * не одновременно.
                 */
                metroNearby: {
                    type:
                        'nested',

                    properties: {
                        name: {
                            type:
                                'keyword',

                            normalizer:
                                'flat_keyword',
                        },

                        nameRu: {
                            type:
                                'keyword',

                            normalizer:
                                'flat_keyword',
                        },

                        distanceM: {
                            type:
                                'integer',
                        },
                    },
                },

                nearbyPlaces: {
                    type:
                        'nested',

                    properties: {
                        name:
                            searchableText(),

                        kind: {
                            type:
                                'keyword',
                        },

                        distanceM: {
                            type:
                                'integer',
                        },
                    },
                },

                landmarksNearby: {
                    type:
                        'nested',

                    properties: {
                        name: {
                            type:
                                'keyword',

                            normalizer:
                                'flat_keyword',
                        },

                        distanceM: {
                            type:
                                'integer',
                        },
                    },
                },

                /*
                 * Плоская копия названий для
                 * обычного поиска: nested-поля
                 * multi_match не видит.
                 *
                 * Намеренно НЕ в SEARCH_FIELDS:
                 * «IT Park» иначе вернёт всё в
                 * радиусе трёх километров.
                 * Это поле для отдельного
                 * фильтра «рядом с ...».
                 */
                placeNames:
                    searchableText(),

                metroDistanceM: {
                    type:
                        'integer',
                },

                metroSource: {
                    type:
                        'keyword',
                },

                placesSource: {
                    type:
                        'keyword',
                },

                adminSource: {
                    type:
                        'keyword',
                },

                residenceComplex:
                    locationText(),

                nearby:
                    searchableText(),

                nearbyShops:
                    searchableText(),

                amenities:
                    searchableText(),

                tags:
                    searchableText(),

                contact:
                    searchableText(),

                price: {
                    type:
                        'double',
                },

                currency: {
                    type:
                        'keyword',
                },

                rooms: {
                    type:
                        'integer',
                },

                bedrooms: {
                    type:
                        'integer',
                },

                bathrooms: {
                    type:
                        'integer',
                },

                areaSqm: {
                    type:
                        'double',
                },

                floor: {
                    type:
                        'integer',
                },

                totalFloors: {
                    type:
                        'integer',
                },

                buildingYear: {
                    type:
                        'integer',
                },

                byAgency: {
                    type:
                        'boolean',
                },

                commercial: {
                    type:
                        'boolean',
                },

                roomOnly: {
                    type:
                        'boolean',
                },

                petsAllowed: {
                    type:
                        'boolean',
                },

                childrenAllowed: {
                    type:
                        'boolean',
                },

                furnished: {
                    type:
                        'boolean',
                },

                newBuilding: {
                    type:
                        'boolean',
                },

                balcony: {
                    type:
                        'boolean',
                },

                parking: {
                    type:
                        'boolean',
                },

                elevator: {
                    type:
                        'boolean',
                },

                airConditioner: {
                    type:
                        'boolean',
                },

                internet: {
                    type:
                        'boolean',
                },

                negotiable: {
                    type:
                        'boolean',
                },

                createdAt: {
                    type:
                        'date',
                },

                firstSeenAt: {
                    type:
                        'date',
                },

                lastSeenAt: {
                    type:
                        'date',
                },

                updatedAt: {
                    type:
                        'date',
                },

                active: {
                    type:
                        'boolean',
                },

                location: {
                    type:
                        'geo_point',
                },
            },
        },
    };
}

function documentId(listing) {
    return [
        String(
            listing.source || '',
        ).toLowerCase(),

        String(
            listing.country || '',
        ).toUpperCase(),

        String(
            listing.id,
        ),
    ].join(':');
}

function validCoordinate(value) {
    const number =
        Number(value);

    return Number.isFinite(number)
        ? number
        : null;
}

function toSearchDocument(
    listing,
    metadata = {},
) {
    const lat =
        validCoordinate(
            listing.lat,
        );

    const lng =
        validCoordinate(
            listing.lng,
        );

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
            ? {
                placeNames: [
                    ...new Set(
                        placeNames,
                    ),
                ],
            }
            : {}),

        id:
            String(
                listing.id,
            ),

        source:
            String(
                listing.source || '',
            ).toLowerCase(),

        country:
            String(
                listing.country || '',
            ).toUpperCase(),

        active:
            metadata.active ??
            true,
    };

    if (
        metadata.firstSeenAt
    ) {
        document.firstSeenAt =
            metadata.firstSeenAt;
    }

    if (
        metadata.lastSeenAt
    ) {
        document.lastSeenAt =
            metadata.lastSeenAt;
    }

    if (
        metadata.updatedAt
    ) {
        document.updatedAt =
            metadata.updatedAt;
    }

    if (
        lat != null &&
        lng != null
    ) {
        document.location = {
            lat,
            lon: lng,
        };
    }

    return document;
}

export async function initElasticsearch() {
    await client.ping();

    const exists =
        await client.indices.exists({
            index: SEARCH_INDEX,
        });

    if (!exists) {
        const created =
            await client.indices.create({
                index: SEARCH_INDEX,

                ...indexDefinition(),

                wait_for_active_shards:
                    'all',

                timeout:
                    '30s',
            });

        if (
            created.shards_acknowledged ===
            false
        ) {
            throw new Error(
                `Elasticsearch index ${SEARCH_INDEX} ` +
                `created, but primary shard is not active`,
            );
        }

        console.log(
            `[elasticsearch] index ` +
            `${SEARCH_INDEX} created`,
        );
    } else {
        /*
         * Маппинг применяется только при
         * создании индекса, а dynamic:false
         * означает, что новое поле попадёт
         * в _source и никогда — в поиск.
         *
         * Добавление полей — это merge;
         * Elasticsearch отвергает только
         * изменение уже существующих, чего
         * здесь не происходит.
         */
        try {
            await client.indices.putMapping({
                index:
                SEARCH_INDEX,

                properties:
                indexDefinition()
                    .mappings
                    .properties,
            });

            console.log(
                `[elasticsearch] mappings ` +
                `merged into ${SEARCH_INDEX}`,
            );
        } catch (error) {
            console.warn(
                `[elasticsearch] mapping merge ` +
                `skipped: ${error?.message ?? error}`,
            );
        }
    }

    await client.cluster.health({
        index:
        SEARCH_INDEX,

        wait_for_status:
            'yellow',

        timeout:
            '30s',
    });

    console.log(
        `[elasticsearch] connected ` +
        `${ELASTICSEARCH_URL}`,
    );

    return true;
}

export async function elasticsearchHealth() {
    try {
        const health =
            await client.cluster.health();

        return {
            ok: true,

            status:
            health.status,

            clusterName:
            health.cluster_name,

            nodes:
            health.number_of_nodes,
        };
    } catch (err) {
        return {
            ok: false,

            error:
                err?.message ??
                String(err),
        };
    }
}

export async function indexListings(
    listings,
) {
    if (
        !Array.isArray(listings) ||
        !listings.length
    ) {
        return 0;
    }

    const unique =
        new Map();

    for (
        const listing
        of listings
        ) {
        if (
            !listing?.source ||
            !listing?.country ||
            listing?.id == null
        ) {
            continue;
        }

        unique.set(
            documentId(
                listing,
            ),
            listing,
        );
    }

    if (!unique.size) {
        return 0;
    }

    const operations = [];

    for (
        const [
            id,
            listing,
        ]
        of unique
        ) {
        operations.push({
            index: {
                _index:
                SEARCH_INDEX,

                _id:
                id,
            },
        });

        operations.push(
            toSearchDocument(
                listing,
            ),
        );
    }

    const result =
        await client.bulk({
            operations,

            refresh: false,
        });

    if (
        result.errors
    ) {
        const failures = [];

        for (
            const item
            of result.items || []
            ) {
            const operation =
                item.index ||
                item.create ||
                item.update ||
                item.delete;

            if (
                operation?.error
            ) {
                failures.push({
                    id:
                    operation._id,

                    status:
                    operation.status,

                    error:
                    operation.error
                        ?.reason,
                });
            }

            if (
                failures.length >= 10
            ) {
                break;
            }
        }

        throw new Error(
            `Elasticsearch bulk indexing failed: ` +
            JSON.stringify(
                failures,
            ),
        );
    }

    return unique.size;
}

async function indexDbRows(
    rows,
) {
    if (
        !Array.isArray(rows) ||
        !rows.length
    ) {
        return 0;
    }

    const operations = [];

    for (const row of rows) {
        const listing = {
            ...(row.data || {}),

            id:
                String(
                    row.source_id,
                ),

            source:
            row.source,

            country:
            row.country,
        };

        operations.push({
            index: {
                _index:
                SEARCH_INDEX,

                _id:
                    documentId(
                        listing,
                    ),
            },
        });

        operations.push(
            toSearchDocument(
                listing,
                {
                    active: true,

                    firstSeenAt:
                    row.first_seen_at,

                    lastSeenAt:
                    row.last_seen_at,

                    updatedAt:
                    row.updated_at,
                },
            ),
        );
    }

    const result =
        await client.bulk({
            operations,

            refresh: false,
        });

    if (
        result.errors
    ) {
        const failed =
            (result.items || [])
                .filter(
                    (item) =>
                        item.index
                            ?.error,
                )
                .slice(0, 10)
                .map(
                    (item) => ({
                        id:
                        item.index
                            ?._id,

                        error:
                        item.index
                            ?.error
                            ?.reason,
                    }),
                );

        throw new Error(
            `Elasticsearch DB bulk failed: ` +
            JSON.stringify(
                failed,
            ),
        );
    }

    return rows.length;
}

export async function deleteListingDocuments(
    listings,
) {
    if (
        !Array.isArray(listings) ||
        !listings.length
    ) {
        return 0;
    }

    const ids =
        new Set();

    for (
        const listing
        of listings
        ) {
        if (
            !listing?.source ||
            !listing?.country ||
            listing?.id == null
        ) {
            continue;
        }

        ids.add(
            documentId(
                listing,
            ),
        );
    }

    if (!ids.size) {
        return 0;
    }

    const operations = [];

    for (const id of ids) {
        operations.push({
            delete: {
                _index:
                SEARCH_INDEX,

                _id:
                id,
            },
        });
    }

    const result =
        await client.bulk({
            operations,

            refresh: false,
        });

    const fatalErrors =
        (result.items || [])
            .map(
                (item) =>
                    item.delete,
            )
            .filter(
                (item) =>
                    item?.error &&
                    item.status !== 404,
            );

    if (fatalErrors.length) {
        throw new Error(
            `Elasticsearch delete failed: ` +
            JSON.stringify(
                fatalErrors.slice(
                    0,
                    10,
                ),
            ),
        );
    }

    return ids.size;
}

/*
 * Поля, где опечатка недопустима.
 *
 * После ICU-транслитерации
 * «новза» → novza, а «новая» →
 * novaa: одна правка. С
 * fuzziness AUTO запрос
 * «Новза» вытаскивал каждую
 * «новую квартиру» в городе, а
 * настоящие объявления у метро
 * тонули среди них.
 *
 * Названия локаций короткие и
 * пишутся правильно — здесь
 * ищем точно, опечатки
 * оставляем описанию.
 */
const EXACT_ONLY_FIELDS = [
    'metro',
    'city',
    'district',
    'area',
    'kvartal',
];

function isExactOnlyField(field) {
    const name =
        String(field)
            .split('^')[0]
            .replace(
                /\.latin$/,
                '',
            );

    return EXACT_ONLY_FIELDS.includes(
        name,
    );
}

const SEARCH_FIELDS = [
    'title^10',
    'title.latin^10',

    'residenceComplex^9',
    'residenceComplex.latin^9',

    'address^8',
    'address.latin^8',

    'district^7',
    'district.latin^7',

    'area^7',
    'area.latin^7',

    'kvartal^6',
    'kvartal.latin^6',

    'city^6',
    'city.latin^6',

    'metro^5',
    'metro.latin^5',

    'nearby^4',
    'nearby.latin^4',

    'nearbyShops^3',
    'nearbyShops.latin^3',

    'tags^3',
    'tags.latin^3',

    'amenities^2',
    'amenities.latin^2',

    'description',
    'description.latin',

    'contact',
    'contact.latin',
];

function searchTokens(query) {
    const text =
        String(
            query ?? '',
        ).trim();

    if (!text) {
        return [];
    }

    const matches =
        text.match(
            /[\p{L}\p{N}]+/gu,
        ) ?? [];

    return [
        ...new Set(
            matches.map(
                (token) =>
                    token.toLowerCase(),
            ),
        ),
    ].slice(
        0,
        16,
    );
}

function buildTextSearchQuery(
    query,
    {
        countries = [],
        sources = [],
    } = {},
) {
    const text =
        String(
            query ?? '',
        ).trim();

    const tokens =
        searchTokens(
            text,
        );

    if (!tokens.length) {
        return {
            match_none: {},
        };
    }

    const filter = [
        {
            term: {
                active: true,
            },
        },
    ];

    const countryValues =
        [
            ...new Set(
                countries
                    .map(
                        (country) =>
                            String(country)
                                .trim()
                                .toUpperCase(),
                    )
                    .filter(Boolean),
            ),
        ];

    if (
        countryValues.length
    ) {
        filter.push({
            terms: {
                country:
                countryValues,
            },
        });
    }

    const sourceValues =
        [
            ...new Set(
                sources
                    .map(
                        (source) =>
                            String(source)
                                .trim()
                                .toLowerCase(),
                    )
                    .filter(Boolean),
            ),
        ];

    if (
        sourceValues.length
    ) {
        filter.push({
            terms: {
                source:
                sourceValues,
            },
        });
    }

    const must =
        tokens.map(
            (token) => {
                const options = {
                    query:
                    token,

                    fields:
                    SEARCH_FIELDS,

                    type:
                        'best_fields',

                    operator:
                        'and',
                };

                /*
                 * Для достаточно длинных слов
                 * разрешаем опечатки.
                 *
                 * Например:
                 *
                 * Чиланзар
                 * Chilanzar
                 *
                 * После ICU-транслитерации
                 * различие уже может быть
                 * обработано fuzzy search.
                 *
                 * Порог 6, а не 4: на коротких
                 * словах одна правка меняет
                 * смысл (новза/новая,
                 * минор/мирзо), и такие
                 * запросы — это почти всегда
                 * название станции или района.
                 */
                const fuzzy =
                    [
                        ...token,
                    ].length >= 6;

                if (!fuzzy) {
                    return {
                        multi_match:
                        options,
                    };
                }

                /*
                 * Опечатки — только по
                 * описательным полям.
                 * Совпадение по названию
                 * локации остаётся точным,
                 * но по-прежнему участвует
                 * в поиске.
                 */
                return {
                    bool: {
                        should: [
                            {
                                multi_match: {
                                    ...options,

                                    fields:
                                        SEARCH_FIELDS.filter(
                                            (field) =>
                                                !isExactOnlyField(
                                                    field,
                                                ),
                                        ),

                                    fuzziness:
                                        'AUTO',

                                    prefix_length:
                                        1,
                                },
                            },

                            {
                                multi_match: {
                                    ...options,

                                    fields:
                                        SEARCH_FIELDS.filter(
                                            isExactOnlyField,
                                        ),
                                },
                            },
                        ],

                        minimum_should_match: 1,
                    },
                };
            },
        );

    return {
        bool: {
            filter,

            must,

            /*
             * Эти условия не обязательны,
             * а только повышают relevance
             * хороших совпадений.
             */
            should: [
                {
                    multi_match: {
                        query:
                        text,

                        fields:
                        SEARCH_FIELDS,

                        type:
                            'phrase',

                        slop:
                            1,

                        boost:
                            6,
                    },
                },

                {
                    multi_match: {
                        query:
                        text,

                        fields:
                        SEARCH_FIELDS,

                        type:
                            'best_fields',

                        operator:
                            'and',

                        boost:
                            3,
                    },
                },
            ],
        },
    };
}

/*
 * Один и тот же запрос повторяется
 * постоянно: клиент шлёт его заново
 * на каждую страницу (offset) и на
 * каждый повторный рендер, а результат
 * при этом не меняется.
 *
 * Без кэша каждый такой вызов заново
 * прокручивал весь индекс через
 * search_after — десятки round-trip
 * к Elasticsearch на один поиск.
 */
const SEARCH_CACHE_TTL_MS =
    60_000;

const SEARCH_CACHE_MAX =
    64;

const searchCache =
    new Map();

function searchCacheKey(
    text,
    countries,
    sources,
) {
    return [
        text,

        [...countries]
            .sort()
            .join('+'),

        [...sources]
            .sort()
            .join('+'),
    ].join('|');
}

export async function searchListingMatches(
    query,
    {
        countries = [],
        sources = [],
    } = {},
) {
    const text =
        String(
            query ?? '',
        ).trim();

    if (!text) {
        return {
            rank:
                new Map(),

            scores:
                new Map(),

            total:
                0,

            truncated:
                false,
        };
    }

    const cacheKey =
        searchCacheKey(
            text,
            countries,
            sources,
        );

    const cached =
        searchCache.get(
            cacheKey,
        );

    if (
        cached &&
        Date.now() - cached.at <
        SEARCH_CACHE_TTL_MS
    ) {
        return cached.value;
    }

    /*
     * search_after не ограничен
     * max_result_window, но size одной
     * страницы — ограничен (10 000 по
     * умолчанию). Берём максимум: строки
     * идут без _source, поэтому это просто
     * id + score, зато round-trip'ов в
     * десять раз меньше.
     */
    const PAGE_SIZE =
        10_000;

    const MAX_MATCHES =
        50_000;

    const rank =
        new Map();

    const scores =
        new Map();

    let searchAfter =
        null;

    let total =
        0;

    while (
        rank.size <
        MAX_MATCHES
        ) {
        const response =
            await client.search({
                index:
                SEARCH_INDEX,

                size:
                    Math.min(
                        PAGE_SIZE,
                        MAX_MATCHES -
                        rank.size,
                    ),

                _source:
                    false,

                track_total_hits:
                    true,

                track_scores:
                    true,

                query:
                    buildTextSearchQuery(
                        text,
                        {
                            countries,
                            sources,
                        },
                    ),

                sort: [
                    {
                        _score: {
                            order:
                                'desc',
                        },
                    },

                    {
                        source: {
                            order:
                                'asc',
                        },
                    },

                    {
                        country: {
                            order:
                                'asc',
                        },
                    },

                    {
                        id: {
                            order:
                                'asc',
                        },
                    },
                ],

                ...(
                    searchAfter
                        ? {
                            search_after:
                            searchAfter,
                        }
                        : {}
                ),
            });

        const hits =
            response.hits
                ?.hits ?? [];

        if (
            typeof response.hits
                ?.total ===
            'number'
        ) {
            total =
                response.hits.total;
        } else {
            total =
                response.hits
                    ?.total
                    ?.value ??
                total;
        }

        if (!hits.length) {
            break;
        }

        for (
            const hit
            of hits
            ) {
            if (
                rank.has(
                    hit._id,
                )
            ) {
                continue;
            }

            rank.set(
                hit._id,
                rank.size,
            );

            scores.set(
                hit._id,
                Number(
                    hit._score ?? 0,
                ),
            );
        }

        if (
            hits.length <
            PAGE_SIZE
        ) {
            break;
        }

        const lastHit =
            hits[
            hits.length - 1
                ];

        if (
            !Array.isArray(
                lastHit.sort,
            )
        ) {
            break;
        }

        searchAfter =
            lastHit.sort;
    }

    const value = {
        rank,
        scores,

        total,

        truncated:
            rank.size < total,
    };

    /*
     * Простейший LRU: самый старый ключ
     * уходит первым. Map хранит порядок
     * вставки, поэтому достаточно удалить
     * первый ключ.
     */
    if (
        searchCache.size >=
        SEARCH_CACHE_MAX
    ) {
        const oldest =
            searchCache
                .keys()
                .next()
                .value;

        searchCache.delete(
            oldest,
        );
    }

    searchCache.set(
        cacheKey,
        {
            at:
                Date.now(),

            value,
        },
    );

    return value;
}

export async function rebuildSearchIndex() {
    /*
     * Кэш ранжирования ссылается на
     * документы старого индекса — после
     * пересборки он бессмыслен.
     */
    searchCache.clear();

    await client.ping();

    console.log(
        `[elasticsearch] rebuilding ` +
        `${SEARCH_INDEX}`,
    );

    const exists =
        await client.indices.exists({
            index:
            SEARCH_INDEX,
        });

    /*
     * Rebuild означает полный rebuild.
     *
     * Не делаем deleteByQuery:
     * он требует рабочий search shard.
     *
     * Старый индекс нам вообще не нужен,
     * потому что source of truth = Postgres.
     */
    if (exists) {
        console.log(
            `[elasticsearch] deleting old ` +
            `index ${SEARCH_INDEX}`,
        );

        await client.indices.delete({
            index:
            SEARCH_INDEX,
        });
    }

    console.log(
        `[elasticsearch] creating fresh ` +
        `index ${SEARCH_INDEX}`,
    );

    const created =
        await client.indices.create({
            index:
            SEARCH_INDEX,

            ...indexDefinition(),

            /*
             * У нас:
             *
             * shards = 1
             * replicas = 0
             *
             * Поэтому all = дождаться
             * единственного primary shard.
             */
            wait_for_active_shards:
                'all',

            timeout:
                '30s',
        });

    if (
        created.shards_acknowledged ===
        false
    ) {
        /*
         * Сразу получаем нормальную причину,
         * а не падаем потом где-нибудь
         * внутри bulk/search.
         */
        let explanation = null;

        try {
            explanation =
                await client.cluster
                    .allocationExplain({
                        index:
                        SEARCH_INDEX,

                        shard:
                            0,

                        primary:
                            true,
                    });
        } catch {
            // Не маскируем исходную ошибку.
        }

        throw new Error(
            `Primary shard for ${SEARCH_INDEX} ` +
            `was not allocated. ` +
            (
                explanation
                    ? JSON.stringify(
                        explanation,
                    )
                    : ''
            ),
        );
    }

    /*
     * Дополнительно ждём, пока индекс
     * станет доступен для search/write.
     */
    const health =
        await client.cluster.health({
            index:
            SEARCH_INDEX,

            wait_for_status:
                'yellow',

            timeout:
                '30s',
        });

    console.log(
        `[elasticsearch] index ready: ` +
        `${health.status}`,
    );

    const BATCH_SIZE =
        500;

    let afterId =
        0;

    let indexed =
        0;

    while (true) {
        const rows =
            await getActiveListingsBatch(
                afterId,
                BATCH_SIZE,
            );

        if (!rows.length) {
            break;
        }

        await indexDbRows(
            rows,
        );

        indexed +=
            rows.length;

        afterId =
            rows[
            rows.length - 1
                ].db_id;

        console.log(
            `[elasticsearch] indexed ` +
            `${indexed}`,
        );
    }

    await client.indices.refresh({
        index:
        SEARCH_INDEX,
    });

    const count =
        await client.count({
            index:
            SEARCH_INDEX,
        });

    console.log(
        `[elasticsearch] rebuild complete: ` +
        `${count.count} documents`,
    );

    return {
        indexed:
        count.count,
    };
}

export async function getElasticsearchStats() {
    const health =
        await elasticsearchHealth();

    if (!health.ok) {
        return {
            ...health,

            index:
            SEARCH_INDEX,

            documents: 0,
        };
    }

    const count =
        await client.count({
            index:
            SEARCH_INDEX,
        });

    return {
        ...health,

        index:
        SEARCH_INDEX,

        documents:
        count.count,
    };
}

export async function closeElasticsearch() {
    await client.close();
}