export const WEB_CV_SOURCES = [
  { key: 'flagma-uz', label: 'Flagma UZ', country: 'UZ' },
  { key: 'careerist-uz', label: 'Careerist UZ', country: 'UZ' },
  { key: 'hh-uz-tashkent', label: 'hh.uz · Tashkent resumes', country: 'UZ' },
  { key: 'uzjobs-resumes', label: 'UzJobs · resumes', country: 'UZ' },
  { key: 'resume-uz', label: 'Resume.uz · resumes', country: 'UZ' },
  { key: 'rabotakz', label: 'Rabota.kz', country: 'KZ' },
  { key: 'enbek-kz', label: 'Enbek.kz · resumes', country: 'KZ' },
  { key: 'hh-kz', label: 'hh.kz · resumes', country: 'KZ' },
  { key: 'newjob-kg', label: 'NewJob.kg · resumes', country: 'KG' },
  { key: 'hh-kg', label: 'HeadHunter.kg · resumes', country: 'KG' },
  { key: 'talent-ua', label: 'Talent.UA', country: 'UA' },
  { key: 'workua-api', label: 'Work.ua · API', country: 'UA' },
  { key: 'robota-ua', label: 'robota.ua · candidates', country: 'UA' },
  { key: 'jobsua', label: 'Jobs.ua · resumes', country: 'UA' },
  { key: 'flagma-ro', label: 'Flagma RO', country: 'RO' },
  { key: 'bestjobs-ro', label: 'BestJobs · public candidates', country: 'RO' },
] as const

export type WebCvSourceKey = (typeof WEB_CV_SOURCES)[number]['key']

export function enabledWebCvSources() {
  if (process.env.HIRING_WEB_CV_SOURCE === 'off') return []
  const raw = process.env.HIRING_WEB_CV_SOURCES?.trim()
  if (!raw) return [...WEB_CV_SOURCES]
  const allowed = new Set(raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))
  return WEB_CV_SOURCES.filter((source) => allowed.has(source.key))
}

/** Runtime-neutral discovery for the generic web-CV adapters. */
export function hiringWebSourceHandles(): string[] {
  return enabledWebCvSources().map((source) => `web:${source.key}`)
}
