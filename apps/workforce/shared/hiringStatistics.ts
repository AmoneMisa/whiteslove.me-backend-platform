import type { CandidateGender, HiringProfessionSalaryRange, HiringStatistics, HiringStatisticsItem } from './contracts/hiring'
import { canonicalCityValue } from './locationCatalog'
import { hiringStatisticGroupsForProfessions } from './hiringStatisticGroups'

export interface HiringStatisticsProfile {
  gender?: CandidateGender
  country: string
  city?: string | null
  activityAt?: string | null
  updatedAt?: string | null
  createdAt: string | null
  salaryMin?: number | null
  salaryMax?: number | null
  currency?: string | null
  experienceYears?: number | null
  age?: number | null
  role?: string
  professions?: string[]
}

const DAY_MS = 86_400_000
const EXPERIENCE_BRACKETS = [
  { from: 0, to: 2 },
  { from: 2, to: 4 },
  { from: 4, to: 7 },
  { from: 7, to: 11 },
  { from: 11, to: Infinity },
]

function median(values: number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function rankedItems(values: string[]): HiringStatisticsItem[] {
  const counts = new Map<string, number>()
  for (const value of values) {
    const label = value.trim()
    if (label) counts.set(label, (counts.get(label) || 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, value]) => ({ label, value }))
}

export function buildHiringStatistics<T extends HiringStatisticsProfile>(
  profiles: T[],
  options: {
    provider: (profile: T) => string
    toUsd: (amount: number, currency: string) => number | undefined
    now?: number
  },
): HiringStatistics {
  const genders = { female: 0, male: 0, unknown: 0 }
  const ages = new Map<string, number>()
  const activity = new Map<string, number>()
  const professionValues: string[] = []
  const sectorValues: string[] = []
  const professionSalary = new Map<string, { count: number; minUsd: number; maxUsd: number }>()
  const now = options.now ?? Date.now()
  const start = now - 60 * DAY_MS
  let salarySamples = 0
  const salaryByExperience = EXPERIENCE_BRACKETS.map(() => [] as number[])

  for (const profile of profiles) {
    genders[profile.gender === 'female' || profile.gender === 'male' ? profile.gender : 'unknown'] += 1
    const age = profile.age
    const ageKey = age == null || !Number.isFinite(age) ? '__unknown__'
      : age < 18 ? '<18' : age < 25 ? '18–24' : age < 35 ? '25–34'
        : age < 45 ? '35–44' : age < 55 ? '45–54' : '55+'
    ages.set(ageKey, (ages.get(ageKey) || 0) + 1)

    const professions = [...new Set([...(profile.professions || []), profile.role || ''])]
      .map((value) => value.trim())
      .filter((value) => value && value !== 'Any Role')
    professionValues.push(...professions)
    sectorValues.push(...hiringStatisticGroupsForProfessions(professions))

    const timestamp = Date.parse(profile.activityAt || profile.updatedAt || profile.createdAt || '')
    if (Number.isFinite(timestamp) && timestamp >= start && timestamp <= now) {
      const date = new Date(timestamp).toISOString().slice(0, 10)
      activity.set(date, (activity.get(date) || 0) + 1)
    }

    const currency = String(profile.currency || 'USD').trim().toUpperCase()
    const salaryMin = profile.salaryMin != null && Number.isFinite(profile.salaryMin) && profile.salaryMin > 0
      ? options.toUsd(profile.salaryMin, currency)
      : undefined
    const salaryMax = profile.salaryMax != null && Number.isFinite(profile.salaryMax) && profile.salaryMax > 0
      ? options.toUsd(profile.salaryMax, currency)
      : undefined
    const validSalaryValues = [salaryMin, salaryMax].filter((value): value is number => value != null && Number.isFinite(value) && value > 0)

    if (validSalaryValues.length) {
      const profileMin = Math.min(...validSalaryValues)
      const profileMax = Math.max(...validSalaryValues)
      for (const profession of professions) {
        const current = professionSalary.get(profession)
        if (!current) professionSalary.set(profession, { count: 1, minUsd: profileMin, maxUsd: profileMax })
        else {
          current.count += 1
          current.minUsd = Math.min(current.minUsd, profileMin)
          current.maxUsd = Math.max(current.maxUsd, profileMax)
        }
      }
    }

    const years = profile.experienceYears
    if (validSalaryValues.length && years != null && Number.isFinite(years)) {
      const average = validSalaryValues.reduce((sum, value) => sum + value, 0) / validSalaryValues.length
      const bracket = EXPERIENCE_BRACKETS.findIndex((item) => years >= item.from && years < item.to)
      if (bracket >= 0) {
        salaryByExperience[bracket]!.push(average)
        salarySamples += 1
      }
    }
  }

  const salaryByProfession: HiringProfessionSalaryRange[] = [...professionSalary.entries()]
    .map(([profession, value]) => ({ profession, ...value }))
    .sort((a, b) => b.count - a.count || b.maxUsd - a.maxUsd || a.profession.localeCompare(b.profession))

  return {
    genders,
    ages: ['<18', '18–24', '25–34', '35–44', '45–54', '55+', '__unknown__']
      .map((label) => ({ label, value: ages.get(label) || 0 })),
    platforms: rankedItems(profiles.map(options.provider)),
    locations: rankedItems(profiles.map((profile) => {
      const location = profile.city?.trim()
      return location ? canonicalCityValue(location) : profile.country || '__unknown__'
    })),
    sectors: rankedItems(sectorValues),
    professions: rankedItems(professionValues),
    activity: [...activity.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, value]) => ({ date, value })),
    salaryByExperience: salaryByExperience.map(median),
    salaryByProfession,
    salarySamples,
  }
}
