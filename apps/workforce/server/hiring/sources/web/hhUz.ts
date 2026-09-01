import type { CvProfile } from '../../../../shared/contracts/hiring'
import { activityDate, isRecent } from '../../../../shared/hiring/webFields'
import { buildWebProfile, type CandidateBlock, type WebCvAdapter } from './common'
import { crawlWebAdapter } from './crawler'

function parseHhUz(block: CandidateBlock, source: WebCvAdapter): CvProfile | null {
  if (/не\s+ищет\s+работу/iu.test(block.text)) return null

  const activity = activityDate(block.text)
  if (!isRecent(activity)) return null

  const profile = buildWebProfile(source, block, activity!, {
    role: block.title,
    city: 'Tashkent',
    updatedAt: activity,
  })

  // hh.uz supplies a user-facing resume title. Keep it verbatim for the card;
  // normalizeCandidate still records the canonical profession separately.
  return { ...profile, role: block.title }
}

export const HH_UZ_SOURCE: WebCvAdapter = {
  key: 'hh-uz-tashkent',
  label: 'hh.uz · Tashkent resumes',
  country: 'UZ',
  root: 'https://tashkent.hh.uz/search/resume?area=2759&order_by=publication_time',
  pageUrl: (page) => {
    const url = new URL('https://tashkent.hh.uz/search/resume')
    url.searchParams.set('area', '2759')
    url.searchParams.set('order_by', 'publication_time')
    url.searchParams.set('page', String(Math.max(0, page - 1)))
    return url.toString()
  },
  linkRe: /(?:https?:\/\/)?(?:[a-z0-9-]+\.)?hh\.uz\/resume\/[a-f0-9]{16,}/i,
  parse: parseHhUz,
}

export async function crawlHhUz(cursor?: Parameters<typeof crawlWebAdapter>[1]) {
  return crawlWebAdapter(HH_UZ_SOURCE, cursor)
}
