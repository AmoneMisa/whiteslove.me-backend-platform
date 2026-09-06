import {
  fetchWithSourceExecutionPolicy,
  LINKEDIN_VOYAGER_EXECUTION_POLICY,
  mapWithSourceConcurrency,
} from '../../../packages/crawler-core/src/executionPolicy.ts'

const LINKEDIN_BASE_URL = 'https://www.linkedin.com'
const VOYAGER_BASE_URL = `${LINKEDIN_BASE_URL}/voyager/api`
const DEFAULT_PEOPLE_QUERY_ID = 'voyagerSearchDashClusters.66adc6056cf4138949ca5dcb31bb1749'
const DEFAULT_COMPANY_QUERY_ID = 'voyagerSearchDashClusters.02af3bc8bc85a169bb76bb4805d05759'
const DEFAULT_GEO_QUERY_ID = 'voyagerSearchDashReusableTypeahead.57a4fa1dd92d3266ed968fdbab2d7bf5'
const DEFAULT_PROFILE_DECORATION_ID = 'com.linkedin.voyager.dash.deco.identity.profile.TopCardComplete-138'
const DEFAULT_COMPONENTS_QUERY_ID = 'voyagerIdentityDashProfileComponents.277ba7d7b9afffb04683953cede751fb'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36'

export type LinkedInVoyagerHealth = {
  requests: number
  successes: number
  rateLimited: number
  authFailures: number
  parseFailures: number
  lastSuccessAt: string | null
  lastError: string | null
}

export type LinkedInVoyagerExperience = {
  title?: string
  company?: string
  location?: string
  duration?: string
}

export type LinkedInVoyagerCandidate = {
  id: string
  urn?: string
  publicIdentifier?: string
  name: string
  firstName?: string
  lastName?: string
  headline: string
  profileUrl: string
  location?: string
  company?: string
  school?: string
  photo?: string
  openToWork?: boolean
  skills: string[]
  experiences: LinkedInVoyagerExperience[]
  rawSearchText?: string
}

export type LinkedInPeopleSearchInput = {
  keywords?: string
  location?: string
  company?: string
  companyId?: string
  limit?: number
}

type SearchCandidate = Pick<LinkedInVoyagerCandidate, 'id' | 'urn' | 'name' | 'headline' | 'profileUrl'>

const health: LinkedInVoyagerHealth = {
  requests: 0,
  successes: 0,
  rateLimited: 0,
  authFailures: 0,
  parseFailures: 0,
  lastSuccessAt: null,
  lastError: null,
}

function queryId(name: string, fallback: string): string {
  return String(process.env[name] || fallback).trim()
}

function configuredCookie(): { cookie: string; csrfToken: string } | null {
  const explicit = String(process.env.HIRING_LINKEDIN_COOKIE || '').trim()
  const explicitCsrf = String(process.env.HIRING_LINKEDIN_CSRF_TOKEN || '').replace(/^"|"$/g, '').trim()
  if (explicit && explicitCsrf) return { cookie: explicit, csrfToken: explicitCsrf }

  const liAt = String(process.env.HIRING_LINKEDIN_LI_AT || '').trim()
  const rawJsession = String(process.env.HIRING_LINKEDIN_JSESSIONID || '').trim()
  const csrfToken = rawJsession.replace(/^"|"$/g, '')
  if (!liAt || !csrfToken) return null
  const jsession = rawJsession.startsWith('"') ? rawJsession : `"${rawJsession}"`
  return { cookie: `li_at=${liAt}; JSESSIONID=${jsession}`, csrfToken }
}

export function linkedinVoyagerConfigured(): boolean {
  if (String(process.env.HIRING_LINKEDIN_VOYAGER || 'off').toLowerCase() !== 'on') return false
  return Boolean(configuredCookie())
}

export function linkedinVoyagerHealth(): Readonly<LinkedInVoyagerHealth> {
  return Object.freeze({ ...health })
}

function recordError(error: unknown) {
  health.lastError = error instanceof Error ? error.message : String(error)
}

async function voyagerJson<T = Record<string, unknown>>(url: string): Promise<T> {
  const auth = configuredCookie()
  if (!auth) throw new Error('LinkedIn Voyager credentials are not configured')
  health.requests += 1
  try {
    const response = await fetchWithSourceExecutionPolicy(url, {
      headers: {
        Accept: 'application/vnd.linkedin.normalized+json+2.1',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': UA,
        Cookie: auth.cookie,
        'csrf-token': auth.csrfToken,
        'x-li-lang': 'en_US',
        'x-li-track': JSON.stringify({ clientVersion: '1.13.31194', mpVersion: '1.13.31194', osName: 'web', timezoneOffset: 0, timezone: 'UTC', deviceFormFactor: 'DESKTOP', mpName: 'voyager-web' }),
        'x-restli-protocol-version': '2.0.0',
      },
    }, fetch, LINKEDIN_VOYAGER_EXECUTION_POLICY)
    if (response.status === 429) health.rateLimited += 1
    if (response.status === 400 || response.status === 401 || response.status === 403) health.authFailures += 1
    if (!response.ok) {
      const message = `LinkedIn Voyager ${new URL(url).pathname} -> HTTP ${response.status}`
      health.lastError = message
      throw new Error(message)
    }
    health.successes += 1
    health.lastSuccessAt = new Date().toISOString()
    return await response.json() as T
  } catch (error) {
    recordError(error)
    throw error
  }
}

function getPath(input: unknown, path: Array<string | number>): unknown {
  let value: unknown = input
  for (const key of path) {
    if (!value || typeof value !== 'object') return undefined
    value = (value as Record<string | number, unknown>)[key]
  }
  return value
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  if (typeof record.text === 'string') return record.text.trim()
  return textValue(record.text)
}

function photoUrl(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const picture = value as Record<string, unknown>
  const vector = getPath(picture, ['displayImageReference', 'vectorImage']) as Record<string, unknown> | undefined
  if (!vector) return undefined
  const root = String(vector.rootUrl || '')
  const artifacts = Array.isArray(vector.artifacts) ? vector.artifacts : []
  const last = artifacts.at(-1) as Record<string, unknown> | undefined
  const suffix = String(last?.fileIdentifyingUrlPathSegment || '')
  return root && suffix ? `${root}${suffix}` : undefined
}

function encodeVoyagerValue(value: string): string {
  return encodeURIComponent(value).replace(/'/g, '%27')
}

export async function resolveLinkedInGeoUrn(location: string): Promise<string | null> {
  const value = String(location || '').trim()
  if (!value) return null
  const query = queryId('HIRING_LINKEDIN_GEO_QUERY_ID', DEFAULT_GEO_QUERY_ID)
  const url = `${VOYAGER_BASE_URL}/graphql?queryId=${query}&queryName=SearchReusableTypeaheadByType`
    + `&variables=(query:(showFullLastNameForConnections:false,typeaheadFilterQuery:(geoSearchTypes:List(MARKET_AREA,COUNTRY_REGION,ADMIN_DIVISION_1,CITY))),keywords:${encodeVoyagerValue(value)},type:GEO,start:0)`
  const json = await voyagerJson(url)
  const elements = getPath(json, ['data', 'searchDashReusableTypeaheadByType', 'elements'])
  if (!Array.isArray(elements)) return null
  for (const element of elements) {
    const urn = String((element as Record<string, unknown>).trackingUrn || '')
    const match = urn.match(/urn:li:geo:(.+)$/)
    if (match?.[1]) return match[1]
  }
  return null
}

async function companyUniversalName(company: string): Promise<string | null> {
  const value = String(company || '').trim()
  if (!value) return null
  const query = queryId('HIRING_LINKEDIN_COMPANY_QUERY_ID', DEFAULT_COMPANY_QUERY_ID)
  const encoded = encodeVoyagerValue(value)
  const url = `${VOYAGER_BASE_URL}/graphql?queryId=${query}&queryName=SearchClusterCollection`
    + `&variables=(query:(flagshipSearchIntent:SEARCH_SRP,keywords:${encoded},includeFiltersInResponse:false,queryParameters:(keywords:List(${encoded}),resultType:List(COMPANIES))),count:10,origin:GLOBAL_SEARCH_HEADER,start:0)`
  const json = await voyagerJson(url)
  const clusters = getPath(json, ['data', 'searchDashClustersByAll', 'elements'])
  if (!Array.isArray(clusters)) return null
  for (const cluster of clusters) {
    const items = (cluster as Record<string, unknown>).items
    if (!Array.isArray(items)) continue
    for (const rawItem of items) {
      const entity = getPath(rawItem, ['item', 'entityResult']) as Record<string, unknown> | undefined
      if (!entity) continue
      const navigationUrl = String(entity.navigationUrl || '')
      const match = decodeURIComponent(navigationUrl).match(/\/company\/([^/?]+)/i)
      if (match?.[1]) return match[1]
    }
  }
  return null
}

export async function resolveLinkedInCompanyId(company: string): Promise<string | null> {
  const universalName = await companyUniversalName(company)
  if (!universalName) return null
  const url = `${VOYAGER_BASE_URL}/organization/companies?q=universalName&universalName=${encodeURIComponent(universalName)}`
  const json = await voyagerJson(url)
  const elements = (json as Record<string, unknown>).elements
  if (!Array.isArray(elements) || !elements.length) return null
  const urn = String(getPath(elements[0], ['trackingInfo', 'objectUrn']) || '')
  return urn.split(':').at(-1) || null
}

function parsePeopleSearch(json: unknown): { candidates: SearchCandidate[]; total: number } {
  const clusters = getPath(json, ['data', 'searchDashClustersByAll', 'elements'])
  const total = Number(getPath(json, ['data', 'searchDashClustersByAll', 'metadata', 'totalResultCount']) || 0)
  if (!Array.isArray(clusters)) return { candidates: [], total: 0 }
  const byId = new Map<string, SearchCandidate>()

  for (const cluster of clusters) {
    const items = (cluster as Record<string, unknown>).items
    if (!Array.isArray(items)) continue
    for (const rawItem of items) {
      const person = getPath(rawItem, ['item', 'entityResult']) as Record<string, unknown> | undefined
      if (!person) continue
      const entityUrn = String(person.entityUrn || '')
      const id = entityUrn.match(/urn:li:fsd_profile:([^,]+)/i)?.[1]
      if (!id || byId.has(id)) continue
      const url = String(person.navigationUrl || '').split('?')[0]
      if (!/^https?:\/\/(?:www\.)?linkedin\.com\/in\//i.test(url)) continue
      const urn = String(person.trackingUrn || '').split(':').at(-1) || undefined
      byId.set(id, {
        id,
        urn,
        name: textValue(person.title),
        headline: textValue(person.primarySubtitle),
        profileUrl: url,
      })
    }
  }
  return { candidates: [...byId.values()], total }
}

async function fetchPeoplePage(
  input: LinkedInPeopleSearchInput,
  offset: number,
  count: number,
  companyId: string | null,
  geoUrn: string | null,
): Promise<{ candidates: SearchCandidate[]; total: number }> {
  const queryParameters = [
    companyId ? `(key:currentCompany,value:List(${companyId}))` : '',
    geoUrn ? `(key:geoUrn,value:List(${geoUrn}))` : '',
    '(key:resultType,value:List(PEOPLE))',
  ].filter(Boolean).join(',')
  const keywords = input.keywords ? `keywords:${encodeVoyagerValue(input.keywords)},` : ''
  const query = queryId('HIRING_LINKEDIN_PEOPLE_QUERY_ID', DEFAULT_PEOPLE_QUERY_ID)
  const url = `${VOYAGER_BASE_URL}/graphql?variables=(start:${offset},query:(flagshipSearchIntent:SEARCH_SRP,${keywords}queryParameters:List(${queryParameters}),includeFiltersInResponse:false),count:${count})&queryId=${query}`
  return parsePeopleSearch(await voyagerJson(url))
}

function parseTopCard(base: SearchCandidate, json: unknown): LinkedInVoyagerCandidate {
  const elements = (json as Record<string, unknown>).elements
  const top = Array.isArray(elements) ? elements[0] as Record<string, unknown> | undefined : undefined
  if (!top) return { ...base, skills: [], experiences: [] }
  const firstName = String(top.firstName || '').trim()
  const lastName = String(top.lastName || '').split(',')[0]!.trim()
  const headline = String(top.headline || base.headline || '').trim()
  const publicIdentifier = String(top.publicIdentifier || '').trim() || undefined
  const location = textValue(getPath(top, ['geoLocation', 'geo', 'defaultLocalizedName'])) || undefined
  const positions = getPath(top, ['profileTopPosition', 'elements'])
  const firstPosition = Array.isArray(positions) ? positions[0] as Record<string, unknown> | undefined : undefined
  const education = getPath(top, ['profileTopEducation', 'elements'])
  const firstEducation = Array.isArray(education) ? education[0] as Record<string, unknown> | undefined : undefined
  const frameType = String(getPath(top, ['profilePicture', 'frameType']) || '')

  return {
    ...base,
    publicIdentifier,
    firstName: firstName || undefined,
    lastName: lastName || undefined,
    name: [firstName, lastName].filter(Boolean).join(' ') || base.name,
    headline,
    profileUrl: publicIdentifier ? `${LINKEDIN_BASE_URL}/in/${publicIdentifier}` : base.profileUrl,
    location,
    company: String(firstPosition?.companyName || '').trim() || undefined,
    school: String(firstEducation?.schoolName || getPath(firstEducation, ['school', 'name']) || '').trim() || undefined,
    photo: photoUrl(top.profilePicture),
    openToWork: frameType === 'OPEN_TO_WORK',
    skills: [],
    experiences: [],
  }
}

async function fetchTopCard(base: SearchCandidate): Promise<LinkedInVoyagerCandidate> {
  const decoration = queryId('HIRING_LINKEDIN_PROFILE_DECORATION_ID', DEFAULT_PROFILE_DECORATION_ID)
  const url = `${VOYAGER_BASE_URL}/voyagerIdentityDashProfiles?count=1&decorationId=${encodeURIComponent(decoration)}&memberIdentity=${encodeURIComponent(base.id)}&q=memberIdentity`
  try {
    return parseTopCard(base, await voyagerJson(url))
  } catch (error) {
    health.parseFailures += 1
    recordError(error)
    return { ...base, skills: [], experiences: [] }
  }
}

function collectEntityComponents(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    for (const item of value) collectEntityComponents(item, out)
    return out
  }
  const record = value as Record<string, unknown>
  if (record.entityComponent && typeof record.entityComponent === 'object') {
    out.push(record.entityComponent as Record<string, unknown>)
  }
  for (const child of Object.values(record)) collectEntityComponents(child, out)
  return out
}

async function fetchProfileSection(candidate: LinkedInVoyagerCandidate, sectionType: 'skills' | 'experience'): Promise<unknown> {
  const query = queryId('HIRING_LINKEDIN_COMPONENTS_QUERY_ID', DEFAULT_COMPONENTS_QUERY_ID)
  const urn = encodeURIComponent(`urn:li:fsd_profile:${candidate.id}`)
  const url = `${VOYAGER_BASE_URL}/graphql?queryId=${query}&queryName=ProfileComponentsBySectionType`
    + `&variables=(tabIndex:0,sectionType:${sectionType},profileUrn:${urn},count:50)`
  return await voyagerJson(url)
}

async function fetchSkills(candidate: LinkedInVoyagerCandidate): Promise<string[]> {
  try {
    const json = await fetchProfileSection(candidate, 'skills')
    const names = new Set<string>()
    for (const entity of collectEntityComponents(json)) {
      const name = textValue(entity.titleV2)
      if (name && name.length <= 120) names.add(name)
    }
    return [...names]
  } catch (error) {
    health.parseFailures += 1
    recordError(error)
    return []
  }
}

function parseExperiences(json: unknown): LinkedInVoyagerExperience[] {
  const experiences: LinkedInVoyagerExperience[] = []
  const seen = new Set<string>()
  for (const entity of collectEntityComponents(json)) {
    const title = textValue(entity.titleV2) || undefined
    const subtitle = textValue(entity.subtitle) || undefined
    const duration = textValue(entity.caption) || undefined
    const location = textValue(entity.metadata) || undefined
    if (!title || title.length > 180) continue
    const company = subtitle?.split(' · ')[0]?.trim() || undefined
    const key = `${title}\u0000${company || ''}\u0000${duration || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    experiences.push({ title, company, duration, location })
  }
  return experiences.slice(0, 30)
}

async function fetchExperiences(candidate: LinkedInVoyagerCandidate): Promise<LinkedInVoyagerExperience[]> {
  try {
    return parseExperiences(await fetchProfileSection(candidate, 'experience'))
  } catch (error) {
    health.parseFailures += 1
    recordError(error)
    return []
  }
}

async function enrichCandidate(base: SearchCandidate): Promise<LinkedInVoyagerCandidate> {
  const candidate = await fetchTopCard(base)
  const skills = await fetchSkills(candidate)
  const experiences = await fetchExperiences(candidate)
  return { ...candidate, skills, experiences }
}

export async function searchLinkedInPeopleReadOnly(input: LinkedInPeopleSearchInput): Promise<LinkedInVoyagerCandidate[]> {
  if (!linkedinVoyagerConfigured()) return []
  const limit = Math.max(1, Math.min(500, Number(input.limit) || 25))
  const companyId = input.companyId || (input.company ? await resolveLinkedInCompanyId(input.company) : null)
  const geoUrn = input.location ? await resolveLinkedInGeoUrn(input.location) : null
  const discovered: SearchCandidate[] = []
  const seen = new Set<string>()

  for (let offset = 0; offset < limit; offset += 50) {
    const count = Math.min(50, limit - offset)
    const page = await fetchPeoplePage(input, offset, count, companyId, geoUrn)
    if (!page.candidates.length) break
    for (const candidate of page.candidates) {
      if (seen.has(candidate.id)) continue
      seen.add(candidate.id)
      discovered.push(candidate)
      if (discovered.length >= limit) break
    }
    if (discovered.length >= limit || offset + count >= page.total) break
  }

  return mapWithSourceConcurrency(
    discovered,
    enrichCandidate,
    LINKEDIN_VOYAGER_EXECUTION_POLICY.concurrency,
  )
}
