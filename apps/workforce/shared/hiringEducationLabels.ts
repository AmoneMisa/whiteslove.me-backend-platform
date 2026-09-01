import type { HiringProfessionLocale } from './hiringProfessionLabels'

type EducationKind = 'higher' | 'incomplete_higher' | 'secondary' | 'vocational'

const EDUCATION_PREFIXES: Array<{ kind: EducationKind; re: RegExp }> = [
  {
    kind: 'incomplete_higher',
    re: /^(?:tugallanmagan\s+oliy|неоконченн(?:ое|ый)\s+высш(?:ее|ий)|incomplete\s+higher(?:\s+education)?)(?=$|[\s([])/iu,
  },
  {
    kind: 'vocational',
    re: /^(?:o['’ʻʼ‘`]?rta[-\s]+maxsus|средн(?:ее|ий)[-\s]+специальн(?:ое|ый)|vocational\s+secondary(?:\s+education)?)(?=$|[\s([])/iu,
  },
  {
    kind: 'higher',
    re: /^(?:oliy(?:\s+ma['’ʻʼ‘`]?lumot)?|высш(?:ее|ий)(?:\s+образование)?|higher(?:\s+education)?)(?=$|[\s([])/iu,
  },
  {
    kind: 'secondary',
    re: /^(?:o['’ʻʼ‘`]?rta|средн(?:ее|ий)(?:\s+образование)?|secondary(?:\s+education)?)(?=$|[\s([])/iu,
  },
]

const LABELS: Record<EducationKind, Record<HiringProfessionLocale, string>> = {
  higher: { ru: 'Высшее', en: 'Higher education' },
  incomplete_higher: { ru: 'Неоконченное высшее', en: 'Incomplete higher education' },
  secondary: { ru: 'Среднее', en: 'Secondary education' },
  vocational: { ru: 'Среднее специальное', en: 'Vocational secondary education' },
}

/** Localizes common source-board education levels while preserving details. */
export function hiringEducationLabel(value: string | null | undefined, locale: HiringProfessionLocale): string | null | undefined {
  const raw = value?.trim()
  if (!raw) return value
  for (const { kind, re } of EDUCATION_PREFIXES) {
    const match = raw.match(re)
    if (!match) continue
    const suffix = raw.slice(match[0].length).trim()
    return suffix ? `${LABELS[kind][locale]} ${suffix}` : LABELS[kind][locale]
  }
  return raw
}
