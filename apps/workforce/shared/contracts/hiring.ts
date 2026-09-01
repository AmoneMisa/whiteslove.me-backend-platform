import type { Seniority } from './jobs'

export type HiringSource = 'telegram' | (string & {})
export type CandidateOrigin = 'telegram' | 'web' | 'facebook' | 'threads' | 'linkedin'
export type CandidateEmploymentType =
  | 'full_time'
  | 'part_time'
  | 'contract'
  | 'project'
  | 'freelance'
  | 'temporary'
  | 'internship'
  | 'volunteer'
  | 'seasonal'
export type CandidateWorkMode = 'remote' | 'hybrid' | 'onsite'
export type CandidateWorkSchedule = 'fiveTwo' | 'twoTwo' | 'shift' | 'flexible' | 'day' | 'night' | 'rotational'
export type CandidateProbationKind = 'probation' | 'noProbation' | 'paidProbation' | 'unpaidProbation'
export type CandidateExperienceRequirement = 'noExperience' | 'experienceRequired'
export type CandidateContactType = 'direct' | 'platform'
export type CandidateGender = 'male' | 'female' | 'unknown'

export interface HiringStatisticsItem {
  label: string
  value: number
}

export interface HiringProfessionSalaryRange {
  profession: string
  count: number
  minUsd: number
  maxUsd: number
}

export interface HiringStatistics {
  genders: Record<CandidateGender, number>
  ages: HiringStatisticsItem[]
  platforms: HiringStatisticsItem[]
  locations: HiringStatisticsItem[]
  sectors: HiringStatisticsItem[]
  professions: HiringStatisticsItem[]
  activity: Array<{ date: string; value: number }>
  salaryByExperience: Array<number | null>
  salaryByProfession: HiringProfessionSalaryRange[]
  salarySamples: number
}

export interface ProfessionExperience {
  profession: string
  years: number
}

export const HIRING_SOURCES: HiringSource[] = ['telegram']

export interface CvProfile {
  id: string
  publicId?: number
  source: HiringSource
  origin?: CandidateOrigin
  sourceKey?: string
  sourceLabel?: string
  derived?: string
  country: string
  sourceCountry?: string
  name: string
  role: string
  professions?: string[]
  previousProfessions?: string[]
  professionExperience?: ProfessionExperience[]
  features?: string[]
  age?: number | null
  gender?: CandidateGender
  isAdult?: boolean
  experienceYears?: number | null
  experienceRequirement?: CandidateExperienceRequirement | null
  salaryMin?: number | null
  salaryMax?: number | null
  currency?: string | null
  city?: string | null
  district?: string | null
  remote?: boolean | null
  relocationReady?: boolean | null
  employmentTypes?: CandidateEmploymentType[]
  workModes?: CandidateWorkMode[]
  schedules?: CandidateWorkSchedule[]
  probationKind?: CandidateProbationKind | null
  photo?: string | null
  photos?: string[]
  url: string
  publishedAt?: string | null
  updatedAt?: string | null
  activityAt?: string | null
  createdAt: string | null
  originalText: string
  description: string
  skills?: string[]
  languages?: string[]
  education?: string | null
  tags?: string[]
  contact?: string | null
  contactHours?: string | null
  contactType?: CandidateContactType
  employmentType?: string | null
  seniority?: Seniority | null
  contacts?: { telegram?: string; email?: string; phone?: string }
  score?: number
}

export interface CountryMeta {
  code: string
  name: string
  currency: string
  cities?: string[]
}
