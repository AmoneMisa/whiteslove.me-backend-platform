import { isCandidateNameHidden } from '@whiteslove/parsing-lexicon/hiring-candidate-fields'
import { normalizeSourceRoleKeys } from '@whiteslove/parsing-lexicon/hiring-source-aliases'
import type { CvProfile } from '../contracts/hiring'
import { extractCandidateGender } from './candidateFields'

export type HiringCandidateLocale = 'en' | 'ru'

// The generic/operative/water-supply/finance-banking/role-alias checks that
// used to live here as local regex now live in the lexicon's
// SOURCE_ROLE_NORMALIZATION_RULES (normalizeSourceRoleKeys). HORECA is kept
// local: it needs a "but not if it already names a specific role" carve-out
// this presentation layer applies on top, not a role classification itself.
const REMOTE_GENERIC_RE = /(?:онлайн|online|onlayn|удал[её]н|remote|masofaviy)/iu
const HORECA_GENERIC_RE = /(?:ищу|нужна|нужен|работа|ишу)?[^\n]{0,40}(?:кафе|кафетер|ресторан|общепит|horeca)(?:[^\n]{0,40}(?:работ|подработ))?/iu

function capitalizeFirst(value: string): string {
  const match = value.match(/\p{L}/u)
  if (!match || match.index == null) return value
  const index = match.index
  return value.slice(0, index) + value.charAt(index).toLocaleUpperCase() + value.slice(index + 1)
}

function smartNameCase(value: string): string {
  const trimmed = value.trim().replace(/\s{2,}/g, ' ')
  if (!trimmed) return ''
  const letters = trimmed.match(/\p{L}/gu) || []
  if (!letters.length) return trimmed
  const upper = trimmed.match(/\p{Lu}/gu) || []
  if (upper.length / letters.length < 0.8) return trimmed
  return trimmed.toLocaleLowerCase('ru').replace(/(^|[\s-])(\p{L})/gu, (_m, boundary: string, letter: string) => (
    `${boundary}${letter.toLocaleUpperCase('ru')}`
  ))
}

export function publicCandidateName(name: string | null | undefined, locale: HiringCandidateLocale): string {
  const raw = String(name || '').trim()
  if (!raw || isCandidateNameHidden(raw)) return locale === 'en' ? 'Name hidden' : 'ФИО скрыто'
  return smartNameCase(raw)
}

function normalizeRoleKeys(value: string): { keys: string[]; normalized: boolean } {
  const raw = value.trim().replace(/^[,.;:«»"'`\s]+|[,.;:«»"'`\s]+$/gu, '').replace(/\s{2,}/g, ' ')
  if (!raw) return { keys: [], normalized: false }
  if (HORECA_GENERIC_RE.test(raw) && !/(?:официант|повар|бариста|бармен|кассир|waiter|cook|chef|barista|bartender)/iu.test(raw)) {
    return { keys: ['Restaurant / Cafe Worker'], normalized: true }
  }
  const sourceKeys = normalizeSourceRoleKeys(raw)
  if (sourceKeys) return { keys: [...sourceKeys], normalized: true }
  if (/\bish\s+(?:kere|kerak)\b/iu.test(raw) && !/\b(?:dasturchi|menejer|buxgalter|haydovchi|o['’ʻʼ‘`]?qituvchi|operator|kassir|sotuvchi|mehmonxona|turfirma|kompyuter)\b/iu.test(raw)) {
    return { keys: ['Any Role'], normalized: true }
  }
  return { keys: [capitalizeFirst(raw)], normalized: false }
}

export function publicCandidateProfessionKeys(profile: CvProfile): string[] {
  const desired = normalizeRoleKeys(profile.role || '')
  if (desired.normalized && desired.keys.length) return desired.keys

  const raw = profile.professions?.length ? profile.professions : [profile.role].filter(Boolean)
  const normalized = [...new Set(raw.flatMap((value) => normalizeRoleKeys(String(value || '')).keys).filter(Boolean))]
  if (normalized.length) return normalized

  const text = profile.originalText || profile.description || ''
  if (HORECA_GENERIC_RE.test(text)) return ['Restaurant / Cafe Worker']
  if (REMOTE_GENERIC_RE.test(text)) return ['Any Role']
  return []
}

export function publicCandidateRemote(profile: CvProfile): boolean | null | undefined {
  const role = (profile.role || '').trim()
  const text = `${role}\n${profile.originalText || profile.description || ''}`
  if (REMOTE_GENERIC_RE.test(text) || /^uyda$/iu.test(role)) return true
  return profile.remote
}

export function publicCandidateGender(profile: CvProfile): CvProfile['gender'] {
  const text = `${profile.name || ''}\n${profile.originalText || profile.description || ''}`
  return extractCandidateGender(text) || profile.gender
}

function amountWithUnit(rawNumber: string, rawUnit: string | undefined): number | null {
  const value = Number(rawNumber.replace(/\s+/g, '').replace(',', '.'))
  if (!Number.isFinite(value) || value <= 0) return null
  const unit = rawUnit || ''
  if (/(?:млн|миллион|million|mln)/iu.test(unit)) return Math.round(value * 1_000_000)
  if (/(?:тыс|тысяч|thousand|ming)/iu.test(unit)) return Math.round(value * 1_000)
  return Math.round(value)
}

function repairCareeristUzCurrency(
  profile: CvProfile,
  salary: Pick<CvProfile, 'salaryMin' | 'salaryMax' | 'currency'>,
): Pick<CvProfile, 'salaryMin' | 'salaryMax' | 'currency'> {
  const source = (profile.sourceKey || '').toLowerCase()
  const country = (profile.country || '').toUpperCase()
  const currency = salary.currency?.toUpperCase()
  const amounts = [salary.salaryMin, salary.salaryMax].filter((value): value is number => value != null && value > 0)
  if (source !== 'careerist-uz' || country !== 'UZ' || currency !== 'RUB' || !amounts.length) return salary
  if (Math.min(...amounts) >= 1_000_000) return { ...salary, currency: 'UZS' }
  return salary
}

export function publicCandidateSalary(profile: CvProfile): Pick<CvProfile, 'salaryMin' | 'salaryMax' | 'currency'> {
  const text = profile.originalText || profile.description || ''
  const mixed = text.match(
    /(?:от|from)?\s*(\d+(?:[.,]\d+)?)\s*(тыс\p{L}*|thousand|ming|млн\p{L}*|миллион\p{L}*|million|mln)?\s*(?:сум|so['’ʻʼ‘`]?m|UZS)?\s*(?:до|[-–—]|to)\s*(\d+(?:[.,]\d+)?)\s*(тыс\p{L}*|thousand|ming|млн\p{L}*|миллион\p{L}*|million|mln)?/iu,
  )
  let salary: Pick<CvProfile, 'salaryMin' | 'salaryMax' | 'currency'> = {
    salaryMin: profile.salaryMin,
    salaryMax: profile.salaryMax,
    currency: profile.currency,
  }
  if (mixed && (mixed[2] || mixed[4] || /(?:зарплат|зп|salary|maosh|oylik|ish\s+haqi)/iu.test(mixed[0]))) {
    const first = amountWithUnit(mixed[1]!, mixed[2])
    const second = amountWithUnit(mixed[3]!, mixed[4])
    if (first != null && second != null) {
      salary = {
        salaryMin: Math.min(first, second),
        salaryMax: Math.max(first, second),
        currency: /\$|USD|доллар/iu.test(mixed[0]) ? 'USD' : profile.currency || 'UZS',
      }
    }
  }
  return repairCareeristUzCurrency(profile, salary)
}
