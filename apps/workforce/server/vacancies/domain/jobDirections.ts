// Direction (сфера) classification for vacancies. Vocabulary is not owned here:
// title and tag evidence comes from the lexicon's profession catalog
// (@whiteslove/parsing-lexicon), and the skill fallback reads the lexicon's
// skill subcategories already attached to each job. This module only maps
// lexicon canonicals onto the public direction ids, so a missing alias is fixed
// in parsing-lexicon rather than patched in a local regex.

import { matchProfessions } from '@whiteslove/parsing-lexicon/hiring-professions'
import { JOB_DIRECTIONS, type Job, type JobDirection } from '~~/shared/contracts/jobs'

export const DIRECTION_PROFESSIONS: Record<JobDirection, readonly string[]> = {
  frontend: ['frontend_developer'],
  mobile: ['mobile_developer', 'ios_developer', 'android_developer', 'flutter_developer', 'react_native_developer'],
  backend: ['backend_developer', 'api_developer'],
  fullstack: ['fullstack_developer'],
  gamedev: ['game_developer', 'unity_developer', 'unreal_developer'],
  devops: ['devops_engineer', 'sre_engineer', 'platform_engineer', 'cloud_engineer'],
  qa: ['qa_engineer', 'manual_qa_engineer', 'qa_automation_engineer', 'performance_qa_engineer', 'qa_lead'],
  data: ['data_analyst', 'data_engineer', 'data_scientist', 'analytics_engineer', 'bi_analyst', 'bi_developer', 'ml_engineer', 'ai_engineer'],
  security: [
    'security_engineer',
    'security_analyst',
    'penetration_tester',
    'application_security_engineer',
    'security_architect',
    'soc_engineer',
    'grc_specialist',
  ],
  design: ['product_designer', 'ui_designer', 'ux_designer', 'ui_ux_designer', 'web_designer'],
  product: ['product_manager', 'product_owner', 'growth_product_manager', 'product_analyst'],
  // Doctors and nurses are the lexicon's medicine group. Specialists such as
  // cardiologist or cleaner are added here once the lexicon release that defines
  // them is installed, so this list never names a canonical the workspace cannot resolve.
  healthcare: [
    'doctor',
    'therapist_doctor',
    'nurse',
    'dentist',
    'pharmacist',
    'medical_assistant',
    'surgeon',
    'pediatrician',
    'gynecologist',
    'radiologist',
    'psychologist',
  ],
  driving: ['driver', 'truck_driver', 'taxi_driver', 'bus_driver', 'courier', 'forklift_operator'],
}

const PROFESSION_DIRECTION = new Map<string, JobDirection>(
  JOB_DIRECTIONS.flatMap((direction) => DIRECTION_PROFESSIONS[direction].map((canonical) => [canonical, direction] as const)),
)

// Lexicon skill subcategories that point at one direction. 'QA & Security' is
// deliberately absent: its skills mix testing and security, so those roles are
// classified from their titles only.
const SKILL_SUBCATEGORY_DIRECTION: Record<string, JobDirection> = {
  Frontend: 'frontend',
  'Mobile & Desktop': 'mobile',
  Backend: 'backend',
  'DevOps & Cloud': 'devops',
  'Analytics & AI': 'data',
  'UI & UX': 'design',
}

// One stray tool (a Git or Docker mention) must not tag a whole role; two
// distinct required skills in the same area is the minimum evidence.
const MIN_SKILLS_PER_DIRECTION = 2

const CACHE_MAX = 20_000
const cache = new Map<string, { fingerprint: string; directions: JobDirection[] }>()

function professionDirections(text: string): JobDirection[] {
  return matchProfessions(text, { allowWeak: false, limit: 10 })
    .map((match) => PROFESSION_DIRECTION.get(match.canonical))
    .filter((direction): direction is JobDirection => direction !== undefined)
}

function skillDirections(job: Job): JobDirection[] {
  const skillsByDirection = new Map<JobDirection, Set<string>>()
  for (const skill of job.skillDetails ?? []) {
    const direction = SKILL_SUBCATEGORY_DIRECTION[skill.subcategory]
    if (!direction) continue
    const names = skillsByDirection.get(direction) ?? new Set<string>()
    names.add(skill.name)
    skillsByDirection.set(direction, names)
  }
  return JOB_DIRECTIONS.filter((direction) => (skillsByDirection.get(direction)?.size ?? 0) >= MIN_SKILLS_PER_DIRECTION)
}

function computeDirections(job: Job): JobDirection[] {
  const fromTitleAndTags = new Set<JobDirection>()
  for (const text of [job.title, ...(job.tags ?? [])]) {
    for (const direction of professionDirections(text)) fromTitleAndTags.add(direction)
  }
  if (fromTitleAndTags.size) return JOB_DIRECTIONS.filter((direction) => fromTitleAndTags.has(direction))
  return skillDirections(job)
}

/**
 * Directions a vacancy belongs to, in canonical order. Title and tags decide
 * when they name a profession; otherwise the required skills decide. A vacancy
 * with no evidence returns an empty list rather than a guess.
 */
export function classifyJobDirections(job: Job): JobDirection[] {
  const key = job.url || job.id
  const fingerprint = `${job.title}|${(job.tags ?? []).join(',')}|${(job.skillDetails ?? []).map((skill) => `${skill.subcategory}:${skill.name}`).join(',')}`
  const cached = cache.get(key)
  if (cached?.fingerprint === fingerprint) return cached.directions

  const directions = computeDirections(job)
  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(key, { fingerprint, directions })
  return directions
}

/** True when the vacancy belongs to at least one requested direction (OR). */
export function matchesJobDirections(job: Job, requested: readonly JobDirection[] | undefined): boolean {
  if (!requested?.length) return true
  const own = classifyJobDirections(job)
  return requested.some((direction) => own.includes(direction))
}
