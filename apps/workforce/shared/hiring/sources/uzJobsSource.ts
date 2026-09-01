export const UZJOBS_SOURCE_KEY = 'uzjobs-uz'
export const UZJOBS_SOURCE_LABEL = 'UzJobs'
export const UZJOBS_SOURCE_COUNTRY = 'UZ'

export function hiringUzJobsSourceHandles(): string[] {
  return process.env.HIRING_UZJOBS_CV_SOURCE === 'off'
    ? []
    : [`web:${UZJOBS_SOURCE_KEY}`]
}

export function listUzJobsSources(): Array<{ key: string; label: string; country: string }> {
  return [{
    key: UZJOBS_SOURCE_KEY,
    label: UZJOBS_SOURCE_LABEL,
    country: UZJOBS_SOURCE_COUNTRY,
  }]
}

export function uzJobsIndexPageUrl(page: number): string {
  return `https://uzjobs.uz/r/resume-2-${Math.max(2, page + 1)}.html`
}

export function uzJobsProfileUrl(id: string): string {
  return `https://uzjobs.uz/resume.cgi?srid=${id}`
}
