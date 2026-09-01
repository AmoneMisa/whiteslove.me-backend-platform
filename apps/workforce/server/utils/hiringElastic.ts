// Elasticsearch index + search for candidate profiles.
// Desired professions are ranked above previous positions; the store remains
// the source of truth and Elasticsearch is only the search/ranking layer.

import type { CvProfile } from './hiringTypes'
import { transliterationMappings } from './cyrillicTransliteration'

const ELASTICSEARCH_URL = (
    process.env.ELASTICSEARCH_URL || 'http://flat-finder-elasticsearch:9200'
).replace(/\/$/, '')

// v2 adds multi-profession, work-history and availability fields.
const CANDIDATE_INDEX = process.env.HIRING_ELASTICSEARCH_INDEX || 'candidate-profiles-v2'
const REQUEST_TIMEOUT_MS = 10_000
const BULK_SIZE = 400

function searchableText() {
    return {
        type: 'text',
        analyzer: 'candidate_text',
        fields: { latin: { type: 'text', analyzer: 'candidate_latin' } },
    }
}

function indexDefinition() {
    return {
        settings: {
            number_of_shards: 1,
            number_of_replicas: 0,
            analysis: {
                char_filter: {
                    candidate_cyrillic: { type: 'mapping', mappings: transliterationMappings() },
                },
                filter: {
                    candidate_ascii: { type: 'asciifolding', preserve_original: true },
                    candidate_shingle: { type: 'shingle', min_shingle_size: 2, max_shingle_size: 3 },
                },
                analyzer: {
                    candidate_text: {
                        type: 'custom',
                        tokenizer: 'standard',
                        filter: ['lowercase', 'candidate_ascii'],
                    },
                    candidate_latin: {
                        type: 'custom',
                        char_filter: ['candidate_cyrillic'],
                        tokenizer: 'standard',
                        filter: ['lowercase', 'candidate_ascii'],
                    },
                },
                normalizer: {
                    candidate_keyword: { type: 'custom', filter: ['lowercase', 'asciifolding'] },
                },
            },
        },
        mappings: {
            dynamic: false,
            properties: {
                id: { type: 'keyword' },
                source: { type: 'keyword' },
                country: { type: 'keyword' },
                city: { type: 'keyword', normalizer: 'candidate_keyword', fields: { text: searchableText() } },
                district: { type: 'keyword', normalizer: 'candidate_keyword', fields: { text: searchableText() } },
                name: searchableText(),
                role: searchableText(),
                professions: { type: 'keyword', normalizer: 'candidate_keyword', fields: { text: searchableText() } },
                previousProfessions: { type: 'keyword', normalizer: 'candidate_keyword', fields: { text: searchableText() } },
                features: { type: 'keyword', normalizer: 'candidate_keyword', fields: { text: searchableText() } },
                description: searchableText(),
                skills: { type: 'keyword', normalizer: 'candidate_keyword', fields: { text: searchableText() } },
                languages: { type: 'keyword', normalizer: 'candidate_keyword' },
                seniority: { type: 'keyword' },
                age: { type: 'short' },
                isAdult: { type: 'boolean' },
                experienceYears: { type: 'float' },
                remote: { type: 'boolean' },
                relocationReady: { type: 'boolean' },
                employmentTypes: { type: 'keyword' },
                salaryMin: { type: 'float' },
                salaryMax: { type: 'float' },
                createdAt: { type: 'date' },
                syncToken: { type: 'keyword' },
            },
        },
    }
}

async function request(path: string, init: RequestInit = {}): Promise<any> {
    const response = await fetch(`${ELASTICSEARCH_URL}${path}`, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`Elasticsearch ${response.status}: ${body.slice(0, 300)}`)
    }
    return response.status === 204 ? null : response.json()
}

let availableAt = 0
let available = false
export async function candidateSearchAvailable(): Promise<boolean> {
    if (Date.now() - availableAt < 30_000) return available
    availableAt = Date.now()
    try {
        await request('/', { method: 'GET' })
        available = true
    } catch {
        available = false
    }
    return available
}

export async function ensureCandidateIndex(): Promise<void> {
    try {
        await request(`/${CANDIDATE_INDEX}`, { method: 'HEAD' })
        return
    } catch {
        // Missing (or unreachable) — try to create it below.
    }
    await request(`/${CANDIDATE_INDEX}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(indexDefinition()),
    })
    console.log(`[hiring:elasticsearch] created ${CANDIDATE_INDEX}`)
}

function toDocument(profile: CvProfile, syncToken: string) {
    return {
        id: profile.id,
        source: profile.source,
        country: profile.country,
        city: profile.city || '',
        district: profile.district || '',
        name: profile.name || '',
        role: profile.role || '',
        professions: profile.professions || [],
        previousProfessions: profile.previousProfessions || [],
        features: profile.features || [],
        description: profile.description || '',
        skills: profile.skills || [],
        languages: profile.languages || [],
        seniority: profile.seniority || null,
        age: profile.age ?? null,
        isAdult: profile.isAdult ?? true,
        experienceYears: profile.experienceYears ?? null,
        remote: profile.remote ?? null,
        relocationReady: profile.relocationReady ?? null,
        employmentTypes: profile.employmentTypes || [],
        salaryMin: profile.salaryMin ?? null,
        salaryMax: profile.salaryMax ?? null,
        createdAt: profile.createdAt || null,
        syncToken,
    }
}

export async function syncCandidateIndex(profiles: CvProfile[]): Promise<number> {
    if (!profiles.length) return 0
    await ensureCandidateIndex()
    const syncToken = String(Date.now())

    for (let i = 0; i < profiles.length; i += BULK_SIZE) {
        const batch = profiles.slice(i, i + BULK_SIZE)
        const lines: string[] = []
        for (const profile of batch) {
            lines.push(JSON.stringify({ index: { _index: CANDIDATE_INDEX, _id: `${profile.source}:${profile.id}` } }))
            lines.push(JSON.stringify(toDocument(profile, syncToken)))
        }
        const result = await request('/_bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-ndjson' },
            body: `${lines.join('\n')}\n`,
        })
        if (result?.errors) {
            const failed = (result.items || []).find((item: any) => item.index?.error)
            throw new Error(`Elasticsearch bulk error: ${JSON.stringify(failed?.index?.error).slice(0, 300)}`)
        }
    }

    await request(`/${CANDIDATE_INDEX}/_delete_by_query?conflicts=proceed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: { bool: { must_not: { term: { syncToken } } } } }),
    }).catch(() => {})

    await request(`/${CANDIDATE_INDEX}/_refresh`, { method: 'POST' }).catch(() => {})
    return profiles.length
}

export interface CandidateSearchParams {
    query?: string
    countries?: string[]
    city?: string
    skills?: string[]
    seniority?: string
    languages?: string[]
    remote?: boolean
    experienceMin?: number
    sources?: string[]
    from?: number
    size?: number
}

export async function searchCandidates(
    params: CandidateSearchParams,
): Promise<{ total: number; hits: { id: string; score: number }[] } | null> {
    const filter: any[] = []
    if (params.countries?.length) filter.push({ terms: { country: params.countries } })
    if (params.sources?.length) filter.push({ terms: { source: params.sources } })
    if (params.seniority) filter.push({ term: { seniority: params.seniority } })
    if (params.remote != null) filter.push({ term: { remote: params.remote } })
    if (params.city) {
        filter.push({
            bool: {
                should: [
                    { match: { 'city.text': { query: params.city, fuzziness: 'AUTO' } } },
                    { match: { 'district.text': { query: params.city, fuzziness: 'AUTO' } } },
                ],
                minimum_should_match: 1,
            },
        })
    }
    if (params.experienceMin) filter.push({ range: { experienceYears: { gte: params.experienceMin } } })
    for (const skill of params.skills || []) filter.push({ term: { skills: skill } })
    for (const language of params.languages || []) filter.push({ term: { languages: language } })

    const text = (params.query || '').trim()
    const must = text
        ? [{
            bool: {
                should: [
                    {
                        multi_match: {
                            query: text,
                            type: 'phrase',
                            fields: ['professions.text^9', 'role^8', 'name^4', 'skills.text^4'],
                            boost: 3,
                        },
                    },
                    {
                        multi_match: {
                            query: text,
                            type: 'best_fields',
                            fields: [
                                'professions.text^8',
                                'role^7',
                                'name^3',
                                'skills.text^4',
                                'features.text^3',
                                'city.text^2',
                                'district.text^2',
                                'previousProfessions.text^1.5',
                                'description',
                            ],
                            fuzziness: 'AUTO',
                            operator: 'or',
                            minimum_should_match: '70%',
                        },
                    },
                    {
                        multi_match: {
                            query: text,
                            type: 'best_fields',
                            fields: [
                                'professions.text.latin^7',
                                'role.latin^6',
                                'name.latin^3',
                                'skills.text.latin^3',
                                'previousProfessions.text.latin',
                                'description.latin',
                            ],
                            fuzziness: 'AUTO',
                            operator: 'or',
                            minimum_should_match: '70%',
                        },
                    },
                ],
                minimum_should_match: 1,
            },
        }]
        : []

    const body = {
        from: Math.max(0, params.from || 0),
        size: Math.min(100, Math.max(1, params.size || 20)),
        track_total_hits: true,
        query: { bool: { must, filter } },
        sort: text ? ['_score', { createdAt: { order: 'desc', missing: '_last' } }] : [{ createdAt: { order: 'desc', missing: '_last' } }],
        _source: ['id', 'source'],
    }

    try {
        const result = await request(`/${CANDIDATE_INDEX}/_search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })
        return {
            total: result?.hits?.total?.value ?? 0,
            hits: (result?.hits?.hits || []).map((hit: any) => ({
                id: hit?._source?.id,
                score: hit?._score ?? 0,
            })).filter((hit: any) => hit.id),
        }
    } catch (error) {
        console.warn('[hiring:elasticsearch] search failed:', (error as Error).message)
        return null
    }
}
