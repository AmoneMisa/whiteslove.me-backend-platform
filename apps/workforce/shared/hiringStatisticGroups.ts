import { HIRING_PROFESSION_GROUPS } from './hiringProfessionGroups'
import type { HiringProfessionLocale } from './hiringProfessionLabels'

interface HiringStatisticGroup {
  key: string
  en: string
  ru: string
  members: Set<string>
}

function groupMembers(...keys: string[]): string[] {
  return keys.flatMap((key) => HIRING_PROFESSION_GROUPS[key]?.members || [])
}

const IT_GROUP_KEYS = [
  'group:software-development',
  'group:it-infrastructure',
  'group:data-ai',
  'group:cybersecurity',
]

const manualGroups: HiringStatisticGroup[] = [
  {
    key: 'it', en: 'IT', ru: 'IT',
    members: new Set([
      ...groupMembers(...IT_GROUP_KEYS),
      'QA Engineer', 'Product Manager', 'Engineering Manager', 'Chief Technology Officer',
    ]),
  },
  {
    key: 'management', en: 'Executive / Management', ru: 'Руководство',
    members: new Set([
      'Chief Executive Officer', 'Chief Technology Officer', 'General Manager', 'Commercial Director',
      'Engineering Manager', 'Production Manager', 'Store Manager', 'Restaurant Manager', 'Warehouse Manager',
    ]),
  },
]

const legacyGroups: HiringStatisticGroup[] = Object.entries(HIRING_PROFESSION_GROUPS)
  .filter(([key]) => !IT_GROUP_KEYS.includes(key))
  .map(([key, group]) => ({ key: key.replace(/^group:/, ''), en: group.en, ru: group.ru, members: new Set(group.members) }))

export const HIRING_STATISTIC_GROUPS = [...manualGroups, ...legacyGroups]

export function hiringStatisticGroupsForProfessions(professions: string[]): string[] {
  const owned = new Set(professions)
  return HIRING_STATISTIC_GROUPS.filter((group) => [...group.members].some((profession) => owned.has(profession))).map((group) => group.key)
}

export function hiringStatisticGroupLabel(key: string, locale: HiringProfessionLocale): string {
  const group = HIRING_STATISTIC_GROUPS.find((item) => item.key === key)
  return group?.[locale] || key
}
