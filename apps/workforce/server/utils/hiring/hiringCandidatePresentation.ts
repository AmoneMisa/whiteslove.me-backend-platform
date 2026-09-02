import type { CvProfile } from '~~/shared/contracts/hiring'
import { parseExtendedLanguageContext } from '@whiteslove/parsing-lexicon/hiring-language-extensions'
import { normalizeSourceRole } from '@whiteslove/parsing-lexicon/hiring-source-aliases'
import {
  publicCandidateGender,
  publicCandidateName,
  publicCandidateProfessionKeys as coreProfessionKeys,
  publicCandidateRemote,
  publicCandidateSalary,
  type HiringCandidateLocale,
} from '../../../shared/hiring/candidatePresentationCore'

export {
  publicCandidateGender,
  publicCandidateName,
  publicCandidateRemote,
  publicCandidateSalary,
}
export type { HiringCandidateLocale }

export function publicCandidateProfessionKeys(profile: CvProfile): string[] {
  if (normalizeSourceRole(profile.role)?.label === 'Any Role') return ['Any Role']
  return coreProfessionKeys(profile)
}

const LANGUAGE_LABELS_RU: Record<string, string> = {
  en: 'Английский',
  ru: 'Русский',
  uz: 'Узбекский',
  kk: 'Казахский',
  uk: 'Украинский',
  tr: 'Турецкий',
  de: 'Немецкий',
  fr: 'Французский',
  es: 'Испанский',
  zh: 'Китайский',
  ko: 'Корейский',
  ja: 'Японский',
  ar: 'Арабский',
  tg: 'Таджикский',
  ky: 'Кыргызский',
  ro: 'Румынский',
  pl: 'Польский',
}

const LEVEL_LABELS_RU: Record<string, string> = {
  basic: 'базовый',
  elementary: 'элементарный',
  preIntermediate: 'ниже среднего',
  intermediate: 'разговорный',
  upperIntermediate: 'выше среднего',
  advanced: 'продвинутый',
  professional: 'профессиональный',
  fluent: 'свободный',
  native: 'родной',
}

const LEVEL_LABELS_EN: Record<string, string> = {
  basic: 'basic',
  elementary: 'elementary',
  preIntermediate: 'pre-intermediate',
  intermediate: 'conversational',
  upperIntermediate: 'upper-intermediate',
  advanced: 'advanced',
  professional: 'professional',
  fluent: 'fluent',
  native: 'native',
}

export function publicCandidateLanguages(profile: CvProfile, locale: HiringCandidateLocale): string[] {
  const text = profile.originalText || profile.description || ''
  if (!text) return [...new Set((profile.languages || []).filter(Boolean))]

  const parsed = parseExtendedLanguageContext(text, { mode: 'candidate' })
  if (!parsed.length) return [...new Set((profile.languages || []).filter(Boolean))]

  return parsed.map((item) => {
    const label = locale === 'ru' ? LANGUAGE_LABELS_RU[item.language] || item.name : item.name
    const level = item.cefr || (item.level
      ? (locale === 'ru' ? LEVEL_LABELS_RU[item.level] : LEVEL_LABELS_EN[item.level]) || item.level
      : null)
    return level ? `${label} — ${level}` : label
  })
}
