import { normalizeSourceRole } from '@whiteslove/parsing-lexicon/hiring-source-aliases'

export type HiringProfessionLocale = 'en' | 'ru'

interface ProfessionLabels {
  en: string
  ru: string
}

/**
 * Canonical hiring profession keys stay in English in storage/search.
 * This table is display-only and may safely grow without migrating persisted CVs.
 */
export const HIRING_PROFESSION_LABELS: Record<string, ProfessionLabels> = {
  'Any Role': { en: 'Any role', ru: 'Любая работа' },
  'Chief Executive Officer': { en: 'CEO', ru: 'CEO / Генеральный директор' },
  'Chief Technology Officer': { en: 'CTO', ru: 'CTO / Технический директор' },
  'Sales Manager': { en: 'Sales Manager', ru: 'Менеджер по продажам' },
  'Project Manager': { en: 'Project Manager', ru: 'Менеджер проектов' },
  'Product Manager': { en: 'Product Manager', ru: 'Продакт-менеджер' },
  'Store Manager': { en: 'Store Manager', ru: 'Управляющий магазином' },
  'Restaurant Manager': { en: 'Restaurant Manager', ru: 'Управляющий рестораном' },
  'Restaurant / Cafe Worker': { en: 'Restaurant / cafe worker', ru: 'Работник кафе / ресторана' },
  'Tourism / Hospitality Specialist': { en: 'Tourism / Hospitality Specialist', ru: 'Специалист по туризму / гостиничному делу' },
  'General Manager': { en: 'General Manager', ru: 'Генеральный менеджер' },
  'Commercial Director': { en: 'Commercial Director', ru: 'Коммерческий директор' },
  Supervisor: { en: 'Supervisor', ru: 'Супервайзер' },
  Consultant: { en: 'Consultant', ru: 'Консультант' },
  'HR / Recruiter': { en: 'HR / Recruiter', ru: 'HR / Рекрутер' },
  'Office Manager': { en: 'Office Manager', ru: 'Офис-менеджер' },
  Administrator: { en: 'Administrator', ru: 'Администратор' },
  Receptionist: { en: 'Receptionist', ru: 'Администратор ресепшена' },
  Manager: { en: 'Manager', ru: 'Менеджер' },
  'Chief Accountant': { en: 'Chief Accountant', ru: 'Главный бухгалтер' },
  Accountant: { en: 'Accountant', ru: 'Бухгалтер' },
  Treasurer: { en: 'Treasurer', ru: 'Казначей' },
  Cashier: { en: 'Cashier', ru: 'Кассир' },
  Salesperson: { en: 'Salesperson', ru: 'Продавец' },
  'Retail Worker': { en: 'Retail Worker', ru: 'Работник магазина' },
  Merchandiser: { en: 'Merchandiser', ru: 'Мерчендайзер' },
  Promoter: { en: 'Promoter', ru: 'Промоутер' },
  'Brand Ambassador': { en: 'Brand Ambassador', ru: 'Бренд-амбассадор' },
  'Chat Operator': { en: 'Chat Operator', ru: 'Оператор чата' },
  'Customer Support': { en: 'Customer Support', ru: 'Специалист поддержки' },
  'Call Center Operator': { en: 'Call Center Operator', ru: 'Оператор колл-центра' },
  Operator: { en: 'Operator', ru: 'Оператор' },
  'Bank Operations Specialist': { en: 'Bank Operations Specialist', ru: 'Операционист банка' },
  Copywriter: { en: 'Copywriter', ru: 'Копирайтер' },

  Courier: { en: 'Courier', ru: 'Курьер' },
  Driver: { en: 'Driver', ru: 'Водитель' },
  'Logistics Specialist': { en: 'Logistics Specialist', ru: 'Логист' },
  'Security Guard': { en: 'Security Guard', ru: 'Охранник' },
  'Security Specialist': { en: 'Security Specialist', ru: 'Специалист по безопасности' },
  'Operative Officer': { en: 'Operative Officer', ru: 'Оперуполномоченный' },
  'Flight Attendant': { en: 'Flight Attendant', ru: 'Бортпроводник' },
  Cleaner: { en: 'Cleaner', ru: 'Специалист по уборке' },
  Caregiver: { en: 'Caregiver', ru: 'Сиделка' },

  Bartender: { en: 'Bartender', ru: 'Бармен' },
  Barista: { en: 'Barista', ru: 'Бариста' },
  Waiter: { en: 'Waiter', ru: 'Официант' },
  Hostess: { en: 'Hostess', ru: 'Хостес' },
  'Cook / Chef': { en: 'Cook / Chef', ru: 'Повар / шеф-повар' },
  Confectioner: { en: 'Confectioner', ru: 'Кондитер' },

  'Fitness Trainer': { en: 'Fitness Trainer', ru: 'Фитнес-тренер' },
  'Trainer / Coach': { en: 'Trainer / Coach', ru: 'Тренер / коуч' },

  Dentist: { en: 'Dentist', ru: 'Стоматолог' },
  Pharmacist: { en: 'Pharmacist', ru: 'Фармацевт' },
  Doctor: { en: 'Doctor', ru: 'Врач' },
  Nurse: { en: 'Nurse', ru: 'Медсестра / медбрат' },
  'Medical Assistant': { en: 'Medical Assistant', ru: 'Медицинский ассистент' },
  'Healthcare Specialist': { en: 'Healthcare Specialist', ru: 'Специалист сферы здравоохранения' },

  Tutor: { en: 'Tutor', ru: 'Репетитор' },
  'English Teacher': { en: 'English Teacher', ru: 'Преподаватель английского' },
  'Kindergarten Teacher': { en: 'Kindergarten Teacher', ru: 'Воспитатель детского сада' },
  Nanny: { en: 'Nanny', ru: 'Няня' },
  Teacher: { en: 'Teacher', ru: 'Преподаватель' },
  Psychologist: { en: 'Psychologist', ru: 'Психолог' },
  'Speech Therapist': { en: 'Speech Therapist', ru: 'Логопед' },
  Librarian: { en: 'Librarian', ru: 'Библиотекарь' },

  'Full-stack Developer': { en: 'Full-stack Developer', ru: 'Full-stack-разработчик' },
  'Backend Developer': { en: 'Backend Developer', ru: 'Backend-разработчик' },
  'Frontend Developer': { en: 'Frontend Developer', ru: 'Frontend Developer' },
  'Mobile Developer': { en: 'Mobile Developer', ru: 'Мобильный разработчик' },
  'IT Specialist': { en: 'IT Specialist', ru: 'IT-специалист' },
  'Network Administrator': { en: 'Network Administrator', ru: 'Сетевой администратор' },
  'System Administrator': { en: 'System Administrator', ru: 'Системный администратор' },
  'ERP Administrator': { en: 'ERP Administrator', ru: 'ERP-администратор' },
  'Software Developer': { en: 'Software Developer', ru: 'Разработчик ПО' },
  'QA Engineer': { en: 'QA Engineer', ru: 'QA Engineer' },
  'DevOps Engineer': { en: 'DevOps Engineer', ru: 'DevOps Engineer' },
  'Cybersecurity Specialist': { en: 'Cybersecurity Specialist', ru: 'Специалист по информационной безопасности' },
  'Penetration Tester': { en: 'Pentester', ru: 'Pentester' },
  'AI / ML Engineer': { en: 'AI / ML Engineer', ru: 'AI / ML Engineer' },
  'Data Scientist': { en: 'Data Scientist', ru: 'Data Scientist' },
  'Data Engineer': { en: 'Data Engineer', ru: 'Data Engineer' },
  'Engineering Manager': { en: 'Engineering Manager', ru: 'Технический руководитель' },
  'Hardware Engineer': { en: 'Hardware Engineer', ru: 'Инженер-электронщик' },
  'CCTV / Intercom Technician': { en: 'CCTV / Intercom Technician', ru: 'Специалист по видеонаблюдению / домофонам' },
  'HVAC Technician': { en: 'HVAC Technician', ru: 'Специалист по кондиционерам' },
  Designer: { en: 'Designer', ru: 'Дизайнер' },
  Architect: { en: 'Architect', ru: 'Архитектор' },
  Analyst: { en: 'Analyst', ru: 'Аналитик' },
  'Internal Control Specialist': { en: 'Internal Control Specialist', ru: 'Специалист внутреннего контроля' },
  Engineer: { en: 'Engineer', ru: 'Инженер' },
  Marketer: { en: 'Marketer', ru: 'Маркетолог' },
  'Media Specialist': { en: 'Media Specialist', ru: 'Специалист по СМИ' },
  'Mobile Content Creator': { en: 'Mobile Content Creator', ru: 'Мобилограф' },
  'Singer / Vocalist': { en: 'Singer / Vocalist', ru: 'Певец / вокалист' },
  Model: { en: 'Model', ru: 'Модель' },
  'Quality Inspector': { en: 'Quality Inspector', ru: 'Инспектор по качеству' },
  'Production Manager': { en: 'Production Manager', ru: 'Руководитель производства' },
  Translator: { en: 'Translator', ru: 'Переводчик' },
  Lawyer: { en: 'Lawyer', ru: 'Юрист' },
  Notary: { en: 'Notary', ru: 'Нотариус' },
  'Notary Assistant': { en: 'Notary Assistant', ru: 'Помощник нотариуса' },
  Economist: { en: 'Economist', ru: 'Экономист' },
  'Metrology Specialist': { en: 'Metrology Specialist', ru: 'Специалист по метрологии и стандартизации' },
  'Finance / Banking Specialist': { en: 'Finance / Banking Specialist', ru: 'Специалист по финансам и банковскому делу' },
  'Insurance Specialist': { en: 'Insurance Specialist', ru: 'Специалист по страхованию' },
  'Water Supply Specialist': { en: 'Water Supply Specialist', ru: 'Специалист по водоснабжению' },
  'Oil & Gas Worker': { en: 'Oil & Gas Worker', ru: 'Работник нефтегазовой отрасли' },
  Biotechnologist: { en: 'Biotechnologist', ru: 'Биотехнолог' },
  'Laboratory Technician': { en: 'Laboratory Technician', ru: 'Лаборант' },

  'General Laborer': { en: 'General Laborer', ru: 'Разнорабочий' },
  'Construction Worker': { en: 'Construction Worker', ru: 'Строитель' },
  Welder: { en: 'Welder', ru: 'Сварщик' },
  Electrician: { en: 'Electrician', ru: 'Электрик' },
  Plumber: { en: 'Plumber', ru: 'Сантехник' },
  Mechanic: { en: 'Mechanic', ru: 'Механик' },
  'Warehouse Manager': { en: 'Warehouse Manager', ru: 'Начальник склада' },
  'Warehouse Worker': { en: 'Warehouse Worker', ru: 'Работник склада' },
  Packer: { en: 'Packer', ru: 'Упаковщик' },
  'Factory Worker': { en: 'Factory Worker', ru: 'Работник производства' },
  Loader: { en: 'Loader', ru: 'Грузчик' },
  Seamstress: { en: 'Seamstress', ru: 'Швея' },
}

export function hiringProfessionLocale(value: unknown): HiringProfessionLocale {
  return String(value || '').toLowerCase().startsWith('en') ? 'en' : 'ru'
}

export function hiringProfessionLabel(value: string, locale: HiringProfessionLocale): string {
  const key = String(value || '').trim()
  const canonical = HIRING_PROFESSION_LABELS[key]
  if (canonical) return canonical[locale]
  const normalized = normalizeSourceRole(key)
  if (!normalized) return key
  return HIRING_PROFESSION_LABELS[normalized.label]?.[locale] || normalized.label
}
