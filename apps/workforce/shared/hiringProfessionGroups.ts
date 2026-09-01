import { hiringProfessionLabel, type HiringProfessionLocale } from './hiringProfessionLabels'

interface HiringProfessionGroup {
  en: string
  ru: string
  members: string[]
}

/**
 * Legacy search facets kept only so old saved/shared URLs continue to work.
 * New filter options are always the exact canonical professions and may be
 * selected together as a multi-select OR query.
 */
export const HIRING_PROFESSION_GROUPS: Record<string, HiringProfessionGroup> = {
  'group:accounting-finance': {
    en: 'Accounting / Finance',
    ru: 'Бухгалтерия / Финансы',
    members: [
      'Accountant',
      'Chief Accountant',
      'Treasurer',
      'Economist',
      'Finance / Banking Specialist',
      'Bank Operations Specialist',
      'Insurance Specialist',
    ],
  },
  'group:sales-retail': {
    en: 'Sales / Retail',
    ru: 'Продажи / Ритейл',
    members: [
      'Sales Manager',
      'Salesperson',
      'Retail Worker',
      'Consultant',
      'Cashier',
      'Merchandiser',
      'Promoter',
      'Brand Ambassador',
      'Store Manager',
    ],
  },
  'group:support-contact-center': {
    en: 'Support / Contact Center',
    ru: 'Поддержка / Колл-центр',
    members: ['Customer Support', 'Chat Operator', 'Call Center Operator'],
  },
  'group:office-admin': {
    en: 'Office / Administration',
    ru: 'Офис / Администрирование',
    members: ['Office Manager', 'Administrator', 'Receptionist'],
  },
  'group:logistics-warehouse': {
    en: 'Logistics / Warehouse',
    ru: 'Логистика / Склад',
    members: [
      'Logistics Specialist',
      'Warehouse Manager',
      'Warehouse Worker',
      'Packer',
      'Loader',
      'Courier',
      'Driver',
    ],
  },
  'group:horeca': {
    en: 'HoReCa',
    ru: 'HoReCa',
    members: [
      'Restaurant Manager',
      'Restaurant / Cafe Worker',
      'Bartender',
      'Barista',
      'Waiter',
      'Hostess',
      'Cook / Chef',
      'Confectioner',
    ],
  },
  'group:medicine': {
    en: 'Medicine / Healthcare',
    ru: 'Медицина / Здравоохранение',
    members: [
      'Doctor',
      'Dentist',
      'Nurse',
      'Medical Assistant',
      'Pharmacist',
      'Healthcare Specialist',
    ],
  },
  'group:education': {
    en: 'Teaching / Education',
    ru: 'Преподавание / Образование',
    members: ['Teacher', 'English Teacher', 'Tutor', 'Kindergarten Teacher'],
  },
  'group:software-development': {
    en: 'Software Development',
    ru: 'Разработка ПО',
    members: [
      'Full-stack Developer',
      'Backend Developer',
      'Frontend Developer',
      'Mobile Developer',
      'Software Developer',
    ],
  },
  'group:it-infrastructure': {
    en: 'IT / Infrastructure',
    ru: 'IT / Инфраструктура',
    members: [
      'IT Specialist',
      'Network Administrator',
      'System Administrator',
      'ERP Administrator',
      'DevOps Engineer',
      'Hardware Engineer',
      'CCTV / Intercom Technician',
    ],
  },
  'group:data-ai': {
    en: 'Data / AI',
    ru: 'Данные / AI',
    members: ['AI / ML Engineer', 'Data Scientist', 'Data Engineer'],
  },
  'group:cybersecurity': {
    en: 'Cybersecurity',
    ru: 'Кибербезопасность',
    members: ['Cybersecurity Specialist', 'Penetration Tester'],
  },
  'group:marketing-media': {
    en: 'Marketing / Media',
    ru: 'Маркетинг / Медиа',
    members: ['Marketer', 'Media Specialist', 'Copywriter', 'Mobile Content Creator'],
  },
  'group:legal': {
    en: 'Legal / Notary',
    ru: 'Юриспруденция / Нотариат',
    members: ['Lawyer', 'Notary', 'Notary Assistant'],
  },
  'group:security': {
    en: 'Security',
    ru: 'Безопасность',
    members: ['Security Guard', 'Security Specialist', 'Operative Officer'],
  },
  'group:production-trades': {
    en: 'Production / Skilled Trades',
    ru: 'Производство / Рабочие специальности',
    members: [
      'General Laborer',
      'Factory Worker',
      'Construction Worker',
      'Welder',
      'Electrician',
      'Plumber',
      'Mechanic',
      'Seamstress',
      'HVAC Technician',
    ],
  },
}

export function expandHiringProfessionFilters(values: string[]): string[] {
  return [...new Set(values.flatMap((value) => HIRING_PROFESSION_GROUPS[value]?.members || [value]))]
}

/**
 * Keep every canonical profession as a separate selector option. The UI is a
 * multi-select, so users explicitly choose several professions when they want
 * an OR search across adjacent directions.
 */
export function collapseHiringProfessionFilterValues(values: string[]): string[] {
  return [...new Set(values)]
}

/** Expand legacy grouped URL values into the equivalent explicit selections. */
export function normalizeHiringProfessionFilterSelections(values: string[]): string[] {
  return expandHiringProfessionFilters(values)
}

export function hiringProfessionFilterLabel(value: string, locale: HiringProfessionLocale): string {
  const group = HIRING_PROFESSION_GROUPS[value]
  return group?.[locale] || hiringProfessionLabel(value, locale)
}
