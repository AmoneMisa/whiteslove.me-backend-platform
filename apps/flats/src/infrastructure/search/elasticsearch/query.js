import {client, SEARCH_INDEX} from './client.js';

/*
 * Поля, где опечатка недопустима.
 *
 * После ICU-транслитерации «новза» → novza, а «новая» → novaa:
 * одна правка. С fuzziness AUTO запрос «Новза» вытаскивал каждую
 * «новую квартиру» в городе, а настоящие объявления у метро
 * тонули среди них.
 *
 * Названия локаций короткие и пишутся правильно — здесь ищем
 * точно, опечатки оставляем описанию.
 */
const EXACT_ONLY_FIELDS = ['metro', 'city', 'district', 'area', 'kvartal'];

function isExactOnlyField(field) {
    const name = String(field).split('^')[0].replace(/\.latin$/, '');
    return EXACT_ONLY_FIELDS.includes(name);
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
    const text = String(query ?? '').trim();

    if (!text) {
        return [];
    }

    const matches = text.match(/[\p{L}\p{N}]+/gu) ?? [];

    return [...new Set(matches.map((token) => token.toLowerCase()))].slice(
        0,
        16,
    );
}

function buildTextSearchQuery(query, {countries = [], sources = []} = {}) {
    const text = String(query ?? '').trim();
    const tokens = searchTokens(text);

    if (!tokens.length) {
        return {match_none: {}};
    }

    const filter = [{term: {active: true}}];

    const countryValues = [
        ...new Set(
            countries
                .map((country) => String(country).trim().toUpperCase())
                .filter(Boolean),
        ),
    ];

    if (countryValues.length) {
        filter.push({terms: {country: countryValues}});
    }

    const sourceValues = [
        ...new Set(
            sources
                .map((source) => String(source).trim().toLowerCase())
                .filter(Boolean),
        ),
    ];

    if (sourceValues.length) {
        filter.push({terms: {source: sourceValues}});
    }

    const must = tokens.map((token) => {
        const options = {
            query: token,
            fields: SEARCH_FIELDS,
            type: 'best_fields',
            operator: 'and',
        };

        /*
         * Для достаточно длинных слов разрешаем опечатки.
         *
         * Например: Чиланзар / Chilanzar — после ICU-транслитерации
         * различие уже может быть обработано fuzzy search.
         *
         * Порог 6, а не 4: на коротких словах одна правка меняет
         * смысл (новза/новая, минор/мирзо), и такие запросы — это
         * почти всегда название станции или района.
         */
        const fuzzy = [...token].length >= 6;

        if (!fuzzy) {
            return {multi_match: options};
        }

        /*
         * Опечатки — только по описательным полям. Совпадение по
         * названию локации остаётся точным, но по-прежнему
         * участвует в поиске.
         */
        return {
            bool: {
                should: [
                    {
                        multi_match: {
                            ...options,
                            fields: SEARCH_FIELDS.filter(
                                (field) => !isExactOnlyField(field),
                            ),
                            fuzziness: 'AUTO',
                            prefix_length: 1,
                        },
                    },
                    {
                        multi_match: {
                            ...options,
                            fields: SEARCH_FIELDS.filter(isExactOnlyField),
                        },
                    },
                ],
                minimum_should_match: 1,
            },
        };
    });

    return {
        bool: {
            filter,
            must,
            /*
             * Эти условия не обязательны, а только повышают
             * relevance хороших совпадений.
             */
            should: [
                {
                    multi_match: {
                        query: text,
                        fields: SEARCH_FIELDS,
                        type: 'phrase',
                        slop: 1,
                        boost: 6,
                    },
                },
                {
                    multi_match: {
                        query: text,
                        fields: SEARCH_FIELDS,
                        type: 'best_fields',
                        operator: 'and',
                        boost: 3,
                    },
                },
            ],
        },
    };
}

/*
 * Один и тот же запрос повторяется постоянно: клиент шлёт его
 * заново на каждую страницу (offset) и на каждый повторный
 * рендер, а результат при этом не меняется.
 *
 * Без кэша каждый такой вызов заново прокручивал весь индекс
 * через search_after — десятки round-trip к Elasticsearch на
 * один поиск.
 */
const SEARCH_CACHE_TTL_MS = 60_000;
const SEARCH_CACHE_MAX = 64;
const searchCache = new Map();

function searchCacheKey(text, countries, sources) {
    return [
        text,
        [...countries].sort().join('+'),
        [...sources].sort().join('+'),
    ].join('|');
}

export function clearSearchCache() {
    searchCache.clear();
}

export async function searchListingMatches(
    query,
    {countries = [], sources = []} = {},
) {
    const text = String(query ?? '').trim();

    if (!text) {
        return {
            rank: new Map(),
            scores: new Map(),
            total: 0,
            truncated: false,
        };
    }

    const cacheKey = searchCacheKey(text, countries, sources);
    const cached = searchCache.get(cacheKey);

    if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) {
        return cached.value;
    }

    /*
     * search_after не ограничен max_result_window, но size одной
     * страницы — ограничен (10 000 по умолчанию). Берём максимум:
     * строки идут без _source, поэтому это просто id + score, зато
     * round-trip'ов в десять раз меньше.
     */
    const PAGE_SIZE = 10_000;
    const MAX_MATCHES = 50_000;

    const rank = new Map();
    const scores = new Map();

    let searchAfter = null;
    let total = 0;

    while (rank.size < MAX_MATCHES) {
        const response = await client.search({
            index: SEARCH_INDEX,
            size: Math.min(PAGE_SIZE, MAX_MATCHES - rank.size),
            _source: false,
            track_total_hits: true,
            track_scores: true,
            query: buildTextSearchQuery(text, {countries, sources}),
            sort: [
                {_score: {order: 'desc'}},
                {source: {order: 'asc'}},
                {country: {order: 'asc'}},
                {id: {order: 'asc'}},
            ],
            ...(searchAfter ? {search_after: searchAfter} : {}),
        });

        const hits = response.hits?.hits ?? [];

        if (typeof response.hits?.total === 'number') {
            total = response.hits.total;
        } else {
            total = response.hits?.total?.value ?? total;
        }

        if (!hits.length) {
            break;
        }

        for (const hit of hits) {
            if (rank.has(hit._id)) {
                continue;
            }

            rank.set(hit._id, rank.size);
            scores.set(hit._id, Number(hit._score ?? 0));
        }

        if (hits.length < PAGE_SIZE) {
            break;
        }

        const lastHit = hits[hits.length - 1];

        if (!Array.isArray(lastHit.sort)) {
            break;
        }

        searchAfter = lastHit.sort;
    }

    const value = {
        rank,
        scores,
        total,
        truncated: rank.size < total,
    };

    /*
     * Простейший LRU: самый старый ключ уходит первым. Map хранит
     * порядок вставки, поэтому достаточно удалить первый ключ.
     */
    if (searchCache.size >= SEARCH_CACHE_MAX) {
        const oldest = searchCache.keys().next().value;
        searchCache.delete(oldest);
    }

    searchCache.set(cacheKey, {at: Date.now(), value});

    return value;
}
