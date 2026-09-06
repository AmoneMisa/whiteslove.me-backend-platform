import type { CvProfile } from '../../../../shared/contracts/hiring'
import { activityDate, cityFrom, htmlText, isRecent, parseAge } from '../../../../shared/hiring/webFields'
import { fetchSecondaryHtml, safeAbsoluteUrl } from './http'
import { buildSecondaryProfile, parseSecondaryChipSalary } from './profile'

function field(card: string, cls: string): string {
  const match = card.match(new RegExp(`class="${cls}"[^>]*>([\\s\\S]{0,300}?)</`, 'i'))
  return match ? htmlText(match[1]!).trim() : ''
}

function cards(html: string): string[] {
  const marker = /<div class="resume_one[^"]*">/g
  const starts = [...html.matchAll(marker)].map((match) => match.index!)
  return starts.map((from, index) => html.slice(from, starts[index + 1] ?? html.length))
}

export async function crawlNovaRobota(): Promise<{ profiles: CvProfile[]; fetched: number }> {
  const byUrl = new Map<string, CvProfile>()
  let fetched = 0

  for (let page = 1; ; page++) {
    const pageUrl = page === 1
      ? 'https://novarobota.ua/resume'
      : `https://novarobota.ua/resume?page=${page}`
    const html = await fetchSecondaryHtml(pageUrl)
    const pageCards = cards(html)
    if (!pageCards.length) break
    let fresh = 0

    for (const card of pageCards) {
      const link = card.match(/<a[^>]*href="([^"]*\/resume\/[^"]*-\d+)"[^>]*class="[^"]*resume_title[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
      if (!link) continue
      fetched += 1

      const url = safeAbsoluteUrl(link[1]!, pageUrl)
      if (!url) continue
      const activity = activityDate(field(card, 'publish_date'))
      if (!isRecent(activity)) continue

      const cityText = field(card, 'city')
      const profile = buildSecondaryProfile({
        key: 'novarobota-ua',
        country: 'UA',
        label: 'NovaRobota',
        id: url.match(/-(\d+)\/?$/)?.[1] || url,
        role: htmlText(link[2]!),
        name: field(card, 'person_name'),
        age: parseAge(field(card, 'age')),
        city: cityFrom(cityText, 'UA') || (/за границей|за кордоном/iu.test(cityText) ? null : cityText || null),
        activity: activity!,
        url,
        text: htmlText(card),
        salaryCurrency: 'UAH',
        salary: parseSecondaryChipSalary(field(card, 'price')),
        contactType: 'platform',
      })
      byUrl.set(profile.url, profile)
      fresh += 1
    }

    if (!fresh) break
  }

  return { profiles: [...byUrl.values()], fetched }
}
