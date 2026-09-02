import { extractCandidateExperienceMentions } from '@whiteslove/parsing-lexicon/hiring-source-semantics'
import { detectMentionedProfessions } from './hiringNormalize'
import type { CvProfile, ProfessionExperience } from '~~/shared/contracts/hiring'

function normalizeExisting(items: ProfessionExperience[] | undefined): ProfessionExperience[] {
  const out = new Map<string, ProfessionExperience>()
  for (const item of items || []) {
    const profession = String(item?.profession || '').trim()
    const years = Number(item?.years)
    if (!profession || !Number.isFinite(years) || years < 0 || years > 60) continue
    const previous = out.get(profession)
    if (!previous || years > previous.years) out.set(profession, { profession, years })
  }
  return [...out.values()]
}

export function extractProfessionExperience(text: string): ProfessionExperience[] {
  const out = new Map<string, ProfessionExperience>()
  for (const mention of extractCandidateExperienceMentions(text)) {
    for (const profession of detectMentionedProfessions(mention.context)) {
      const previous = out.get(profession)
      if (!previous || mention.years > previous.years) {
        out.set(profession, { profession, years: mention.years })
      }
    }
  }
  return [...out.values()]
}

function sameProfessionFamily(a: string, b: string): boolean {
  if (a === b) return true
  return /Developer$/u.test(a) && /Developer$/u.test(b)
}

function targetProfessions(profile: CvProfile): string[] {
  const structured = [...(profile.professions || []), profile.role || ''].filter(Boolean)
  const canonical = detectMentionedProfessions(structured.join(' '))
  return canonical.length ? canonical : structured
}

export function withProfessionExperience(profile: CvProfile): CvProfile {
  const byProfession = new Map<string, ProfessionExperience>()
  for (const item of normalizeExisting(profile.professionExperience)) {
    const previous = byProfession.get(item.profession)
    if (!previous || item.years > previous.years) byProfession.set(item.profession, item)
  }
  for (const item of extractProfessionExperience(profile.originalText || profile.description || '')) {
    byProfession.set(item.profession, item)
  }

  const professionExperience = [...byProfession.values()]
  const targets = targetProfessions(profile)
  const targetEntries = professionExperience.filter((item) =>
    targets.some((target) => sameProfessionFamily(item.profession, target)),
  )
  const previousFromExperience = professionExperience
    .filter((item) => !targets.some((target) => sameProfessionFamily(item.profession, target)))
    .map((item) => item.profession)
  const inferredTargetYears = targetEntries.length
    ? Math.max(...targetEntries.map((item) => item.years))
    : null

  return {
    ...profile,
    professionExperience,
    previousProfessions: [...new Set([...(profile.previousProfessions || []), ...previousFromExperience])],
    experienceYears: profile.experienceYears ?? inferredTargetYears,
  }
}
