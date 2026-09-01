import type { CvProfile } from '../../../../shared/contracts/hiring'
import { activityDate, cityFrom, htmlText, isRecent } from '../../../../shared/hiring/webFields'
import { fetchSecondaryHtml, safeAbsoluteUrl } from './http'
import { buildSecondaryProfile, parseSecondaryChipSalary } from './profile'

function cards(html: string): string[] {
  const starts = [...html.matchAll(/<div class="vacancies-list-item[^"]*">/g)]
    .map((match) => match.index!)
  return starts.map((from, index) => html.slice(from, starts[index + 1] ?? html.length))
}

function spanText(card: string, cls: string): string {
  const match = card.match(new RegExp(`class="[^"]*${cls}[^"]*"[^>]*>([\\s\\S]{0,300}?)</span>`, 'i'))
  return match ? htmlText(match[1]!).replace(/^[\s,]+/, '').trim() : ''
}

export async function crawlAmountwork(): Promise<{ profiles: CvProfile[]; fetched: number }> {
  const pageUrl = 'https://amountwork.com/resume/in/rumyniya'
  const html = await fetchSecondaryHtml(pageUrl)
  const pageCards = cards(html)
  const profiles: CvProfile[] = []
  let fetched = 0

  for (const card of pageCards) {
    const link = card.match(/<a[^>]*href="([^"]*\/r\/\d+\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!link) continue
    fetched += 1

    const url = safeAbsoluteUrl(link[1]!, pageUrl)
    if (!url) continue
    const activity = activityDate(spanText(card, 'vacancies-list-date bottom'))
    if (!isRecent(activity)) continue

    profiles.push(buildSecondaryProfile({
      key: 'amountwork-ro',
      country: 'RO',
      label: 'Amountwork',
      id: url.match(/\/r\/(\d+)\//)?.[1] || url,
      role: htmlText(link[2]!),
      name: spanText(card, 'vacancies-list-user'),
      city: cityFrom(spanText(card, 'city') || htmlText(card), 'RO'),
      activity: activity!,
      url,
      text: htmlText(card),
      salaryCurrency: 'EUR',
      salary: parseSecondaryChipSalary(spanText(card, 'vacancies-list-salary')),
      contactType: 'platform',
    }))
  }

  return { profiles, fetched }
}
