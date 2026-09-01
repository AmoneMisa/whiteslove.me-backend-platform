import { htmlText } from './webFields'

export interface UzJobsPublicRow {
  id: string
  roles: string[]
  region: string
  activityAt: string
  activityText: string
}

function lastVisit(value: string): string | null {
  const match = value.match(/(\d{1,2})\.(\d{1,2})\.(20\d{2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
  if (!match) return null
  const time = Date.UTC(
    Number(match[3]),
    Number(match[2]) - 1,
    Number(match[1]),
    Number(match[4] || 12) - 5,
    Number(match[5] || 0),
    Number(match[6] || 0),
  )
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

function roleLines(value: string): string[] {
  return htmlText(value)
    .split('\n')
    .map((line) => line.replace(/^.*?\/\s*/u, '').trim())
    .filter((line) => line.length >= 2 && !/^другое$/iu.test(line))
}

/** Extract only fields exposed by the logged-out public listing. */
export function parseUzJobsRows(html: string): UzJobsPublicRow[] {
  const rows: UzJobsPublicRow[] = []
  const tableRows = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || []

  for (const row of tableRows) {
    const idCell = row.match(/<td\b[^>]*class=["'][^"']*td_left_id[^"']*["'][^>]*>([\s\S]*?)<\/td>/i)
    const id = htmlText(idCell?.[1] || '').match(/^\d+$/)?.[0]
    if (!id) continue

    const cells = [...row.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)]
    const roleCell = cells.find((cell) => !/td_left_id|td_region|td_kol_vak/i.test(cell[1] || ''))
    const regionCell = cells.find((cell) => /td_region/i.test(cell[1] || ''))
    const dateCell = cells.find((cell) => /td_kol_vak/i.test(cell[1] || ''))
    const roles = roleLines(roleCell?.[2] || '')
    const region = htmlText(regionCell?.[2] || '').replace(/\s+/g, ' ').trim()
    const activityText = htmlText(dateCell?.[2] || '')
    const activityAt = lastVisit(activityText)
    if (!roles.length || !region || !activityAt) continue
    rows.push({ id, roles, region, activityAt, activityText })
  }

  return rows
}
