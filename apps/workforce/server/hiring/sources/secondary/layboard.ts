import type { CvProfile } from '../../../../shared/contracts/hiring'
import { activityDate, cityFrom, htmlText, isRecent, parseAge } from '../../../../shared/hiring/webFields'
import { fetchSecondaryHtml, safeAbsoluteUrl } from './http'
import { buildSecondaryProfile, parseSecondaryChipSalary } from './profile'

function maxActivity(...values: Array<string | null>): string | null {
  const times = values
    .map((value) => value ? Date.parse(value) : Number.NaN)
    .filter(Number.isFinite)
  return times.length ? new Date(Math.max(...times)).toISOString() : null
}

function activity(text: string): string | null {
  const online = text.match(/(?:был\(а\) в сети|last online)[^\d]{0,20}(\d{1,2})[.-](\d{1,2})[.-](20\d{2})(?:\s+(\d{1,2}):(\d{2}))?/iu)
  let onlineIso: string | null = null
  if (online) {
    onlineIso = new Date(Date.UTC(
      Number(online[3]),
      Number(online[2]) - 1,
      Number(online[1]),
      Number(online[4] || 12),
      Number(online[5] || 0),
    )).toISOString()
  }
  return maxActivity(onlineIso, activityDate(text))
}

function cards(html: string): string[] {
  const marker = '<div class="resume__card">'
  return html.split(marker).slice(1).map((part) => {
    const stop = part.indexOf('<div class="pagination')
    return stop > 0 ? part.slice(0, stop) : part
  })
}

export async function crawlLayboard(): Promise<{ profiles: CvProfile[]; fetched: number }> {
  const byUrl = new Map<string, CvProfile>()
  let fetched = 0

  for (let page = 1; ; page++) {
    const pageUrl = page === 1
      ? 'https://layboard.com/rezume/kazahstan'
      : `https://layboard.com/rezume/kazahstan?page=${page}`
    const html = await fetchSecondaryHtml(pageUrl)
    const pageCards = cards(html)
    if (!pageCards.length) break
    let fresh = 0

    for (const card of pageCards) {
      const link = card.match(/<a[^>]*href="([^"]+)"[^>]*class="[^"]*card__title[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
      if (!link) continue
      fetched += 1

      const url = safeAbsoluteUrl(link[1]!, pageUrl)
      if (!url) continue
      const text = htmlText(card)
      const activityAt = activity(text)
      if (!isRecent(activityAt)) continue

      const chips = [...card.matchAll(/class="org__info[^"]*"[^>]*>([\s\S]*?)<\/span>/gi)]
        .map((match) => htmlText(match[1]!).trim())
        .filter(Boolean)
      const age = chips.map((chip) => parseAge(chip)).find((value) => value != null) ?? null
      const place = chips.find((chip) => !/\d/.test(chip)) || ''
      const salary = chips.map(parseSecondaryChipSalary).find((value) => value.salaryMin != null) || {}

      const profile = buildSecondaryProfile({
        key: 'layboard-kz',
        country: 'KZ',
        label: 'Layboard',
        id: url.match(/\/rezume\/(\d+)\//)?.[1] || url,
        role: htmlText(link[2]!),
        name: htmlText(card.match(/class="name"[^>]*>([\s\S]*?)<\/a>/i)?.[1] || ''),
        age,
        city: cityFrom(place, 'KZ') || cityFrom(text, 'KZ'),
        activity: activityAt!,
        url,
        text,
        salaryCurrency: 'KZT',
        salary,
        contactType: 'platform',
      })
      byUrl.set(profile.url, profile)
      fresh += 1
    }

    if (!fresh) break
  }

  return { profiles: [...byUrl.values()], fetched }
}
