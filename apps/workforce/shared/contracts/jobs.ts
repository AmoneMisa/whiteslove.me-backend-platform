// Runtime-neutral jobs domain and transport contracts shared by Nuxt and workers.

export type RiskCategory = 'gambling' | 'adult' | 'scam'
export type WorkMode = 'remote' | 'hybrid' | 'office' | 'unknown'
export type Relocation = 'offered' | 'none' | 'unknown'
export type SalaryPeriod = 'hour' | 'day' | 'shift' | 'week' | 'month' | 'year' | 'project' | 'piece'
export type Seniority = 'intern' | 'junior' | 'middle' | 'senior' | 'staff' | 'principal' | 'lead' | 'head' | 'director' | 'vp' | 'chief'
export type EmployerType = 'direct' | 'agency' | 'board' | 'telegram'
export type SponsorshipConfidence = 'explicit' | 'verified' | 'historical'
export type EmploymentKind =
  | 'fulltime'
  | 'parttime'
  | 'contract'
  | 'project'
  | 'freelance'
  | 'internship'
  | 'temporary'
  | 'volunteer'
  | 'seasonal'
export type WorkSchedule =
  | 'fiveTwo'
  | 'twoTwo'
  | 'sixOne'
  | 'threeThree'
  | 'oneThree'
  | 'twentyFourFortyEight'
  | 'shift'
  | 'flexible'
  | 'day'
  | 'night'
  | 'rotational'
export type ProbationKind = 'probation' | 'noProbation' | 'paidProbation' | 'unpaidProbation'
export type ExperienceRequirement = 'noExperience' | 'experienceRequired'

/**
 * Professional directions (сферы) a vacancy can be filtered by. The ids are
 * the public contract; classification from title/tags/skills lives on the
 * server (server/vacancies/domain/jobDirections.ts).
 */
export type JobDirection =
  | 'frontend'
  | 'mobile'
  | 'backend'
  | 'fullstack'
  | 'gamedev'
  | 'devops'
  | 'qa'
  | 'data'
  | 'security'
  | 'design'
  | 'product'
  | 'healthcare'
  | 'driving'

export const JOB_DIRECTIONS: JobDirection[] = [
  'frontend',
  'mobile',
  'backend',
  'fullstack',
  'gamedev',
  'devops',
  'qa',
  'data',
  'security',
  'design',
  'product',
  'healthcare',
  'driving',
]

export const JOB_DIRECTION_LABELS: Record<JobDirection, { en: string; ru: string }> = {
  frontend: { en: 'Frontend', ru: 'Фронтенд' },
  mobile: { en: 'Mobile (iOS / Android / cross-platform)', ru: 'Мобильная разработка' },
  backend: { en: 'Backend', ru: 'Бэкенд' },
  fullstack: { en: 'Fullstack', ru: 'Фулстек' },
  gamedev: { en: 'Game development', ru: 'Разработка игр' },
  devops: { en: 'DevOps / SRE', ru: 'DevOps / SRE' },
  qa: { en: 'QA / Testing', ru: 'QA / Тестирование' },
  data: { en: 'Data / Analytics / ML', ru: 'Данные / Аналитика / ML' },
  security: { en: 'Information security', ru: 'Информационная безопасность' },
  design: { en: 'Design', ru: 'Дизайн' },
  product: { en: 'Product', ru: 'Продукт' },
  healthcare: { en: 'Healthcare / Medicine', ru: 'Медицина / Здравоохранение' },
  driving: { en: 'Driving / Delivery', ru: 'Водители / Доставка' },
}

export const EMPLOYMENT_KINDS: EmploymentKind[] = [
  'fulltime',
  'parttime',
  'contract',
  'project',
  'freelance',
  'internship',
  'temporary',
  'volunteer',
  'seasonal',
]

export interface LanguageReq {
  language: string
  level?: string
  requirement?: 'required' | 'preferred' | 'notRequired'
}

export interface JobSkillDetail {
  name: string
  category: string
  subcategory: string
}

export interface Job {
  id: string
  publicId?: number
  title: string
  company: string
  location: string
  officeLocations?: string[]
  url: string
  source: JobSource
  remote: boolean
  tags: string[]
  postedAt: string
  description?: string
  employmentType?: string
  salaryMin?: number
  salaryMax?: number
  salaryCurrency?: string
  applyUrl?: string
  country?: string
  city?: string
  workMode?: WorkMode
  relocation?: Relocation
  foreignerFriendly?: boolean
  sponsorshipConfidence?: SponsorshipConfidence
  sponsorshipEvidence?: string[]
  noExperience?: boolean
  experienceRequirement?: ExperienceRequirement | null
  employmentKind?: EmploymentKind
  workSchedules?: WorkSchedule[]
  probationKind?: ProbationKind | null
  languages?: LanguageReq[]
  skills?: string[]
  niceToHave?: string[]
  skillDetails?: JobSkillDetail[]
  niceToHaveDetails?: JobSkillDetail[]
  experienceMinYears?: number
  experienceMaxYears?: number
  salaryPeriod?: SalaryPeriod
  salaryUsd?: number
  salaryGross?: boolean
  salaryNegotiable?: boolean
  seniority?: Seniority | null
  managementRole?: boolean
  education?: string
  schedule?: string
  contractType?: string
  deadline?: string
  tools?: string[]
  applicationLanguage?: string
  hiringKind?: 'vacancy' | 'candidate' | 'vacancy_digest' | 'recruitment_ad' | 'course' | 'job_service' | 'closed_vacancy' | 'spam' | 'unknown'
  vacancyStatus?: string
  workAuthorization?: string[]
  travelRequirement?: string
  benefits?: string[]
  applicationRequirements?: string[]
  openingCount?: number
  employerType?: EmployerType
  riskCategory?: RiskCategory | null
  riskReasons?: string[]
  suspicious?: boolean
  suspicionReasons?: string[]
  directions?: JobDirection[]
}

export type JobSource =
  | 'remotive'
  | 'remoteok'
  | 'arbeitnow'
  | 'themuse'
  | 'jobicy'
  | 'hh'
  | 'adzuna'
  | 'jooble'
  | 'rss'
  | 'companies'
  | 'linkedin'
  | 'facebook'
  | 'threads'
  | 'devkg'
  | 'ishgo'
  | 'itjobsuz'
  | 'telegram'
  | 'olx'

export const FREE_SOURCES: JobSource[] = [
  'remotive',
  'remoteok',
  'arbeitnow',
  'themuse',
  'jobicy',
  'hh',
  'devkg',
  'telegram',
  'linkedin',
  'facebook',
  'threads',
]

export const OPTIONAL_SOURCES: JobSource[] = [
  'adzuna',
  'jooble',
  'rss',
  'companies',
  'ishgo',
  'itjobsuz',
  'olx',
]

export const ALL_SOURCES: JobSource[] = [...FREE_SOURCES, ...OPTIONAL_SOURCES]

export type SortKey = 'date' | 'oldest' | 'title' | 'company' | 'salary'

export interface JobQuery {
  q: string
  location: string
  remote?: boolean
  sources: JobSource[]
  sort: SortKey
  maxAgeDays: number
  salaryMin?: number
  page: number
  pageSize: number
  countries: string[]
  cities: string[]
  includeRu?: boolean
  includeBy?: boolean
  workMode?: WorkMode
  relocation?: Relocation
  employmentKind?: EmploymentKind
  hasSalary?: boolean
  maxExperienceYears?: number
  foreignerFriendly?: boolean
  hideRiskyIndustries?: boolean
  noExperience?: boolean
  language?: string
  languageLevel?: string
  excludeLanguages: string[]
  skills: string[]
  /** Multi-select OR: a vacancy matches when it belongs to any requested direction. */
  directions?: JobDirection[]
}

export interface SalaryStat {
  count: number
  medianUsd: number
  avgUsd: number
  minUsd: number
  maxUsd: number
}

export interface JobGroupedSalaryStat {
  count: number
  salaryCount: number
  medianUsd: number
}

export interface JobExperienceStats {
  knownCount: number
  medianYears: number | null
  noExperience: number
  upToOne: number
  oneToThree: number
  threeToFive: number
  fivePlus: number
  unknown: number
}

export interface JobProfessionGeographyStat extends JobGroupedSalaryStat {
  kind: 'country' | 'city'
  key: string
}

export interface JobProfessionStat extends JobGroupedSalaryStat {
  profession: string
  medianExperienceYears: number | null
  geographies: JobProfessionGeographyStat[]
}

export interface JobSalaryTrendPoint {
  postedAt: string
  salaryUsd: number
  country?: string
  city?: string
  title: string
  profession?: string
  experienceYears?: number
}

export interface JobStats {
  salary: SalaryStat
  bySource: Partial<Record<JobSource, JobGroupedSalaryStat>>
  byCountry: Record<string, JobGroupedSalaryStat>
  byWorkMode: Record<WorkMode, number>
  byRelocation: Record<Relocation, number>
  byEmploymentKind: Record<EmploymentKind | 'unknown', number>
  experience: JobExperienceStats
  byProfession: JobProfessionStat[]
  foreignerFriendly: number
  byLanguage: Record<string, number>
  topSkills: { skill: string; count: number }[]
  salaryTrend: JobSalaryTrendPoint[]
}

export interface JobResponse {
  jobs: Job[]
  total: number
  page: number
  pageSize: number
  sources: Partial<Record<JobSource, number>>
  stats: JobStats
  rates?: Record<string, number>
}

/**
 * An employer collection: one company with two or more different live roles.
 * `roles` counts distinct job clusters, `postings` counts the vacancies behind
 * them, so a heavily reposted single role reads as 1 role / many postings.
 */
export interface JobEmployerSummary {
  employerKey: string
  company: string
  country: string
  roles: number
  postings: number
  lastPostedAt: string | null
}
