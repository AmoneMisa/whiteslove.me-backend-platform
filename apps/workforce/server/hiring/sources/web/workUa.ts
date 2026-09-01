import type { CvProfile } from '../../../../shared/contracts/hiring'
import { activityDate, cityFrom, isRecent } from '../../../../shared/hiring/webFields'
import { buildWebProfile, type CandidateBlock, type WebCvAdapter } from './common'
import { crawlWebAdapter } from './crawler'

function parseWorkUa(block: CandidateBlock, source: WebCvAdapter): CvProfile | null {
  const activity = activityDate(block.text)
  if (!isRecent(activity)) return null

  return buildWebProfile(source, block, activity!, {
    role: block.title,
    city: cityFrom(block.text, 'UA'),
    updatedAt: activity,
  })
}

export const WORK_UA_API_SOURCE: WebCvAdapter = {
  key: 'workua-api',
  label: 'Work.ua · API',
  country: 'UA',
  root: 'https://www.work.ua/resumes-api/',
  pageUrl: (page) => page === 1
    ? 'https://www.work.ua/resumes-api/'
    : `https://www.work.ua/resumes-api/?page=${page}`,
  linkRe: /(?:www\.)?work\.ua\/(?:en\/)?resumes\/\d+\/?(?:[?#].*)?$/i,
  parse: parseWorkUa,
}

export async function crawlWorkUaApi(cursor?: Parameters<typeof crawlWebAdapter>[1]) {
  return crawlWebAdapter(WORK_UA_API_SOURCE, cursor)
}
