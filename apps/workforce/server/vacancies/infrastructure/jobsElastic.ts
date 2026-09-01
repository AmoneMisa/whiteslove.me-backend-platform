import type { Job } from '../../utils/jobTypes'
import { transliterationMappings } from '../../utils/cyrillicTransliteration'

const ELASTICSEARCH_URL =
    (
        process.env.ELASTICSEARCH_URL
        || 'http://flat-finder-elasticsearch:9200'
    ).replace(/\/$/, '')

const JOBS_INDEX =
    process.env.JOBS_ELASTICSEARCH_INDEX
    || 'job-listings-v1'

const REQUEST_TIMEOUT_MS = 15_000
const BULK_SIZE = 500

function searchableText() {
    return {
        type: 'text',

        analyzer: 'job_text',

        fields: {
            latin: {
                type: 'text',
                analyzer: 'job_latin',
            },
        },
    }
}

function indexDefinition() {
    return {
        settings: {
            number_of_shards: 1,
            number_of_replicas: 0,

            analysis: {
                // Transliteration is a core `mapping` char filter rather than
                // icu_transform: analysis-icu cannot be installed on this host,
                // and an index definition referencing a missing analyzer fails
                // to create at all — which left this index nonexistent and job
                // search silently unranked. Shared with the candidate index so
                // both transliterate identically.
                char_filter: {
                    job_cyrillic: {
                        type: 'mapping',
                        mappings: transliterationMappings(),
                    },
                },

                filter: {
                    job_ascii: {
                        type: 'asciifolding',
                        preserve_original: true,
                    },
                },

                analyzer: {
                    job_text: {
                        type: 'custom',

                        tokenizer: 'standard',

                        filter: [
                            'lowercase',
                            'job_ascii',
                        ],
                    },

                    job_latin: {
                        type: 'custom',

                        char_filter: [
                            'job_cyrillic',
                        ],

                        tokenizer: 'standard',

                        filter: [
                            'lowercase',
                            'job_ascii',
                        ],
                    },
                },

                normalizer: {
                    job_keyword: {
                        type: 'custom',

                        filter: [
                            'lowercase',
                            'asciifolding',
                        ],
                    },
                },
            },
        },

        mappings: {
            dynamic: false,

            properties: {
                key: {
                    type: 'keyword',
                },

                id: {
                    type: 'keyword',
                },

                source: {
                    type: 'keyword',
                },

                country: {
                    type: 'keyword',
                },

                title:
                    searchableText(),

                company:
                    searchableText(),

                location:
                    searchableText(),

                city:
                    searchableText(),

                description:
                    searchableText(),

                tags:
                    searchableText(),

                skills:
                    searchableText(),

                niceToHave:
                    searchableText(),

                tools:
                    searchableText(),

                languages:
                    searchableText(),

                education:
                    searchableText(),

                schedule:
                    searchableText(),

                contractType:
                    searchableText(),

                applicationLanguage:
                    searchableText(),

                workMode: {
                    type: 'keyword',
                },

                relocation: {
                    type: 'keyword',
                },

                employmentKind: {
                    type: 'keyword',
                },

                seniority: {
                    type: 'keyword',
                },

                foreignerFriendly: {
                    type: 'boolean',
                },

                noExperience: {
                    type: 'boolean',
                },

                remote: {
                    type: 'boolean',
                },

                salaryUsd: {
                    type: 'double',
                },

                experienceMinYears: {
                    type: 'double',
                },

                experienceMaxYears: {
                    type: 'double',
                },

                postedAt: {
                    type: 'date',
                },

                syncToken: {
                    type: 'keyword',
                },
            },
        },
    }
}

async function request(
    path: string,
    options: RequestInit = {},
) {
    const response =
        await fetch(
            `${ELASTICSEARCH_URL}${path}`,
            {
                ...options,

                signal:
                    AbortSignal.timeout(
                        REQUEST_TIMEOUT_MS,
                    ),
            },
        )

    if (!response.ok) {
        const text =
            await response.text()
                .catch(() => '')

        throw new Error(
            `Elasticsearch ${response.status}: `
            + `${text.slice(0, 1000)}`,
        )
    }

    if (
        response.status === 204
        || options.method === 'HEAD'
    ) {
        return null
    }

    return response.json()
}

async function indexExists() {
    const response =
        await fetch(
            `${ELASTICSEARCH_URL}/${JOBS_INDEX}`,
            {
                method: 'HEAD',

                signal:
                    AbortSignal.timeout(
                        REQUEST_TIMEOUT_MS,
                    ),
            },
        )

    if (response.status === 404) {
        return false
    }

    if (!response.ok) {
        throw new Error(
            `Elasticsearch HEAD ${response.status}`,
        )
    }

    return true
}

export function jobSearchKey(
    job: Pick<Job, 'source' | 'id'>,
) {
    return [
        String(job.source)
            .toLowerCase(),

        String(job.id),
    ].join(':')
}

function searchDocument(
    job: Job,
    syncToken: string,
) {
    return {
        key:
            jobSearchKey(job),

        id:
            String(job.id),

        source:
        job.source,

        country:
            job.country ?? null,

        title:
            job.title ?? '',

        company:
            job.company ?? '',

        location:
            job.location ?? '',

        city:
            job.city ?? '',

        description:
            job.description ?? '',

        tags:
            job.tags ?? [],

        skills:
            job.skills ?? [],

        niceToHave:
            job.niceToHave ?? [],

        tools:
            job.tools ?? [],

        languages:
            (job.languages ?? [])
                .map(
                    (item) =>
                        [
                            item.language,
                            item.level,
                        ]
                            .filter(Boolean)
                            .join(' '),
                ),

        education:
            job.education ?? '',

        schedule:
            job.schedule ?? '',

        contractType:
            job.contractType ?? '',

        applicationLanguage:
            job.applicationLanguage ?? '',

        workMode:
            job.workMode ?? 'unknown',

        relocation:
            job.relocation ?? 'unknown',

        employmentKind:
            job.employmentKind ?? null,

        seniority:
            job.seniority ?? null,

        foreignerFriendly:
            job.foreignerFriendly ?? false,

        noExperience:
            job.noExperience ?? false,

        remote:
        job.remote,

        salaryUsd:
            job.salaryUsd ?? null,

        experienceMinYears:
            job.experienceMinYears ?? null,

        experienceMaxYears:
            job.experienceMaxYears ?? null,

        postedAt:
        job.postedAt,

        syncToken,
    }
}

// Analysis settings are fixed at creation time, so an index built from the old
// (icu_transform) definition keeps its analyzers even after this file changes.
// Warn loudly with the fix rather than silently serving a differently-analyzed
// index — and never delete it here, since that would drop data uninvited.
async function warnIfStaleAnalysis() {
    try {
        const settings = await request(`/${JOBS_INDEX}/_settings`, { method: 'GET' })
        const analysis = settings?.[JOBS_INDEX]?.settings?.index?.analysis
        if (analysis && !analysis.char_filter?.job_cyrillic) {
            console.warn(
                `[jobs:elasticsearch] ${JOBS_INDEX} was created with the old `
                + `analysis settings, so transliterated matching is inactive. `
                + `Recreate it (delete the index, or point `
                + `JOBS_ELASTICSEARCH_INDEX at a new name) and re-run the refresh.`,
            )
        }
    } catch {
        // Diagnostics only — never block indexing on this probe.
    }
}

export async function ensureJobsSearchIndex() {
    if (
        await indexExists()
    ) {
        await warnIfStaleAnalysis()
        return
    }

    await request(
        `/${JOBS_INDEX}`,
        {
            method: 'PUT',

            headers: {
                'Content-Type':
                    'application/json',
            },

            body:
                JSON.stringify(
                    indexDefinition(),
                ),
        },
    )

    console.log(
        `[jobs:elasticsearch] `
        + `created ${JOBS_INDEX}`,
    )
}

async function bulkIndex(
    jobs: Job[],
    syncToken: string,
) {
    if (!jobs.length) {
        return
    }

    const lines: string[] = []

    for (const job of jobs) {
        const key =
            jobSearchKey(job)

        lines.push(
            JSON.stringify({
                index: {
                    _index:
                    JOBS_INDEX,

                    _id:
                    key,
                },
            }),
        )

        lines.push(
            JSON.stringify(
                searchDocument(
                    job,
                    syncToken,
                ),
            ),
        )
    }

    const result: any =
        await request(
            '/_bulk',
            {
                method: 'POST',

                headers: {
                    'Content-Type':
                        'application/x-ndjson',
                },

                body:
                    `${lines.join('\n')}\n`,
            },
        )

    if (result?.errors) {
        const failed =
            result.items
                ?.find(
                    (item: any) =>
                        item.index?.error,
                )

        throw new Error(
            `Elasticsearch bulk error: `
            + JSON.stringify(
                failed?.index?.error
                ?? failed
                ?? result,
            ),
        )
    }
}

export async function syncJobsSearchIndex(
    jobs: Job[],
) {
    /*
     * Пустой store не используем
     * как сигнал удалить весь индекс:
     * это может быть временная проблема Redis.
     */
    if (!jobs.length) {
        console.warn(
            '[jobs:elasticsearch] '
            + 'empty store, sync skipped',
        )

        return 0
    }

    await ensureJobsSearchIndex()

    const syncToken =
        new Date()
            .toISOString()

    let indexed = 0

    for (
        let offset = 0;
        offset < jobs.length;
        offset += BULK_SIZE
    ) {
        const batch =
            jobs.slice(
                offset,
                offset + BULK_SIZE,
            )

        await bulkIndex(
            batch,
            syncToken,
        )

        indexed +=
            batch.length
    }

    /*
     * Удаляем вакансии, которых уже
     * нет в текущем Redis store.
     *
     * Это заменяет необходимость
     * отдельного PostgreSQL для jobs.
     */
    await request(
        `/${JOBS_INDEX}/_delete_by_query`
        + '?conflicts=proceed'
        + '&refresh=true',
        {
            method: 'POST',

            headers: {
                'Content-Type':
                    'application/json',
            },

            body:
                JSON.stringify({
                    query: {
                        bool: {
                            must_not: [
                                {
                                    term: {
                                        syncToken,
                                    },
                                },
                            ],
                        },
                    },
                }),
        },
    )

    console.log(
        `[jobs:elasticsearch] `
        + `synced ${indexed} jobs`,
    )

    return indexed
}

const SEARCH_FIELDS = [
    'title^12',
    'title.latin^12',

    'skills^10',
    'skills.latin^10',

    'niceToHave^7',
    'niceToHave.latin^7',

    'company^6',
    'company.latin^6',

    'tools^6',
    'tools.latin^6',

    'tags^5',
    'tags.latin^5',

    'location^5',
    'location.latin^5',

    'city^5',
    'city.latin^5',

    'description^2',
    'description.latin^2',

    'education',
    'education.latin',

    'schedule',
    'schedule.latin',

    'contractType',
    'contractType.latin',
]

function searchTokens(
    query: string,
) {
    return [
        ...new Set(
            (
                query.match(
                    /[\p{L}\p{N}+#.-]+/gu,
                )
                ?? []
            )
                .map(
                    (token) =>
                        token
                            .trim()
                            .toLowerCase(),
                )
                .filter(Boolean),
        ),
    ].slice(
        0,
        16,
    )
}

function buildSearchQuery(
    query: string,
) {
    const tokens =
        searchTokens(query)

    if (!tokens.length) {
        return {
            match_none: {},
        }
    }

    return {
        bool: {
            must:
                tokens.map(
                    (token) => ({
                        multi_match: {
                            query:
                            token,

                            fields:
                            SEARCH_FIELDS,

                            type:
                                'best_fields',

                            fuzziness:
                                token.length >= 4
                                    ? 'AUTO'
                                    : 0,

                            prefix_length:
                                token.length >= 4
                                    ? 1
                                    : 0,
                        },
                    }),
                ),

            should: [
                {
                    multi_match: {
                        query,

                        fields: [
                            'title^12',
                            'title.latin^12',
                            'skills^10',
                            'skills.latin^10',
                            'company^6',
                            'company.latin^6',
                        ],

                        type:
                            'phrase',

                        slop:
                            1,

                        boost:
                            8,
                    },
                },

                {
                    multi_match: {
                        query,

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
    }
}

export interface JobSearchMatches {
    rank: Map<string, number>
    total: number
}

export async function searchJobMatches(
    query: string,
): Promise<JobSearchMatches | null> {
    const text =
        String(query ?? '')
            .trim()

    if (!text) {
        return null
    }

    /*
     * Индекс ещё не построен после
     * первого deploy → используем
     * старый includes fallback.
     */
    if (
        !(await indexExists())
    ) {
        return null
    }

    const rank =
        new Map<string, number>()

    const PAGE_SIZE = 1000
    const MAX_MATCHES = 50_000

    let searchAfter:
        unknown[] | undefined

    let total = 0

    while (
        rank.size <
        MAX_MATCHES
        ) {
        const body: any = {
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
                buildSearchQuery(
                    text,
                ),

            sort: [
                {
                    _score:
                        'desc',
                },

                {
                    key:
                        'asc',
                },
            ],
        }

        if (searchAfter) {
            body.search_after =
                searchAfter
        }

        const result: any =
            await request(
                `/${JOBS_INDEX}/_search`,
                {
                    method: 'POST',

                    headers: {
                        'Content-Type':
                            'application/json',
                    },

                    body:
                        JSON.stringify(
                            body,
                        ),
                },
            )

        const hits =
            result?.hits?.hits
            ?? []

        total =
            typeof result?.hits?.total
            === 'number'
                ? result.hits.total
                : (
                    result?.hits
                        ?.total
                        ?.value
                    ?? total
                )

        if (!hits.length) {
            break
        }

        for (const hit of hits) {
            const key =
                hit.sort?.[1]

            if (
                typeof key !== 'string'
                || rank.has(key)
            ) {
                continue
            }

            rank.set(
                key,
                rank.size,
            )
        }

        if (
            hits.length <
            PAGE_SIZE
        ) {
            break
        }

        const last =
            hits[
            hits.length - 1
                ]

        if (
            !Array.isArray(
                last?.sort,
            )
        ) {
            break
        }

        searchAfter =
            last.sort
    }

    /*
     * Пустой ES после первого создания,
     * когда Redis уже содержит вакансии,
     * лучше считать fallback-состоянием.
     */
    if (!rank.size && total === 0) {
        const count: any =
            await request(
                `/${JOBS_INDEX}/_count`,
            )

        if (
            Number(
                count?.count ?? 0,
            ) === 0
        ) {
            return null
        }
    }

    return {
        rank,
        total,
    }
}