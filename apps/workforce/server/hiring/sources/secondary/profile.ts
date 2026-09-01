import { extractCandidateContacts, extractCandidateExperienceYears } from '@whiteslove/parsing-lexicon/hiring-candidate-fields'
import { detectCandidateRelocationPreference, detectCandidateRemotePreference } from '@whiteslove/parsing-lexicon/hiring-semantics'
import { parseHiringSourceSalary } from '@whiteslove/parsing-lexicon/hiring-source-semantics'
import { detectEmploymentTypes } from '@whiteslove/parsing-lexicon/hiring-work-semantics'
import type { CvProfile } from '../../../../shared/contracts/hiring'
import { cityFrom, parseAge } from '../../../../shared/hiring/webFields'
import { normalizeCandidate } from '../../../utils/hiringNormalize'

export type SecondarySourceKey = 'novarobota-ua' | 'layboard-kz' | 'amountwork-ro'

function parseSalary(text: string, fallback: string): Pick<CvProfile, 'salaryMin' | 'salaryMax' | 'currency'> {
  const parsed = parseHiringSourceSalary(text)
  if (!parsed || (parsed.min == null && parsed.max == null)) return {}
  const first = parsed.min ?? parsed.max
  const second = parsed.max ?? parsed.min
  if (first == null || !Number.isFinite(first) || first <= 0) return {}
  const upper = second != null && Number.isFinite(second) ? second : first
  const currency = parsed.currency || fallback
  if (!currency) return {}
  return {
    salaryMin: Math.min(first, upper),
    salaryMax: Math.max(first, upper),
    currency,
  }
}

function contacts(text: string, country: string): CvProfile['contacts'] {
  return { ...extractCandidateContacts(text, country) }
}

export function parseSecondaryChipSalary(
  chip: string,
): Pick<CvProfile, 'salaryMin' | 'salaryMax' | 'currency'> {
  return parseSalary(chip, '')
}

export function buildSecondaryProfile(input: {
  key: SecondarySourceKey
  country: 'UA' | 'KZ' | 'RO'
  label: string
  id: string
  role: string
  name?: string
  age?: number | null
  city?: string | null
  activity: string
  url: string
  text: string
  salaryCurrency: string
  salary?: Pick<CvProfile, 'salaryMin' | 'salaryMax' | 'currency'>
  contactType?: 'direct' | 'platform'
}): CvProfile {
  const publicContacts = contacts(input.text, input.country)
  const hasDirect = Boolean(publicContacts.phone || publicContacts.email || publicContacts.telegram)
  const age = input.age ?? parseAge(input.text)
  return normalizeCandidate({
    id: `web-${input.key}-${input.id}`,
    source: 'telegram',
    origin: 'web',
    sourceKey: input.key,
    country: input.country,
    name: input.name || '',
    role: input.role,
    professions: [input.role],
    age,
    isAdult: age == null ? true : age >= 18,
    experienceYears: extractCandidateExperienceYears(input.text),
    city: input.city ?? cityFrom(input.text, input.country),
    remote: detectCandidateRemotePreference(input.text),
    relocationReady: detectCandidateRelocationPreference(input.text),
    employmentTypes: [...detectEmploymentTypes(input.text)],
    publishedAt: input.activity,
    updatedAt: input.activity,
    activityAt: input.activity,
    createdAt: input.activity,
    url: input.url,
    originalText: input.text.slice(0, 4_000),
    description: input.text.slice(0, 4_000),
    tags: [input.label, 'Web CV', input.country],
    contacts: publicContacts,
    contact: publicContacts.telegram || publicContacts.email || publicContacts.phone || input.url,
    contactType: input.contactType || (hasDirect ? 'direct' : 'platform'),
    ...parseSalary(input.text, input.salaryCurrency),
    ...(input.salary || {}),
  })
}
