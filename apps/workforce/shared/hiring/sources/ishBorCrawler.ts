import type { WebCursor } from '../hiringCursors'
import { absoluteHttpUrl } from '../../htmlText'
import { htmlText } from '../webFields'
import { ISHBOR_SOURCE_KEY } from './ishBorSource'
import { fetchWithSourceExecutionPolicy } from '../../../packages/crawler-core/src/executionPolicy.ts'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36'

export type IshBorSummary = {
  url: string
  role: string
  text: string
}

function htmlLines(value: string): string[] {
  return htmlText(value).split('\n').filter(Boolean)
}

function stripHtml(value: string): string {
  return htmlLines(value).join(' ').replace(/\s+/g, ' ').trim()
}

function absoluteUrl(raw: string, base: string): string {
  return absoluteHttpUrl(raw, base) || base
}

async function fetchHtml(url: string): Promise<string> {
  const response = await fetchWithSourceExecutionPolicy(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'ru,en;q=0.8',
    },
  })
  if (!response.ok) throw new Error(`${new URL(url).host} -> ${response.status}`)
  return response.text()
}

function listSummaries(html: string): IshBorSummary[] {
  const base = 'https://ish-bor.uz/ru/ishchilar'
  const matches = [...html.matchAll(
    /<a\b[^>]*href=["']([^"']*\/ru\/ishchilar\/id\/\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
  )]
  const byUrl = new Map<string, IshBorSummary>()
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index]!
    const role = stripHtml(match[2])
    if (role.length < 2 || role.length > 220 || /подробнее/iu.test(role)) continue
    const start = match.index || 0
    const end = matches[index + 1]?.index ?? Math.min(html.length, start + 4_500)
    const url = absoluteUrl(match[1]!, base)
    byUrl.set(url, { url, role, text: htmlLines(html.slice(start, end)).join('\n') })
  }
  return [...byUrl.values()]
}

export async function crawlIshBorPages<T>(
  cursor: WebCursor,
  assembleProfile: (summary: IshBorSummary, detailHtml: string) => T | null,
): Promise<{ profiles: T[]; fetched: number; cursor: WebCursor }> {
  const all = new Map<string, IshBorSummary & { page: number }>()
  const backfillStart = Math.max(2, cursor.backfillPage || 1)
  let bootstrapComplete = cursor.bootstrapComplete
  let lastHistoricalPage = backfillStart - 1

  const readPage = async (page: number) => {
    const url = page === 1
      ? 'https://ish-bor.uz/ru/ishchilar'
      : `https://ish-bor.uz/ru/ishchilar?page=${page}`
    const summaries = listSummaries(await fetchHtml(url))
    if (page > 1) lastHistoricalPage = page
    summaries.forEach((item) => all.set(item.url, { ...item, page }))
    return summaries.length
  }

  await readPage(1)
  if (!cursor.bootstrapComplete) {
    for (let page = backfillStart; ; page += 1) {
      const count = await readPage(page)
      if (!count) {
        bootstrapComplete = true
        break
      }
    }
  }

  const summaries = [...all.values()]
  const profiles: T[] = []
  let earliestFailedHistoricalPage: number | null = null
  for (const summary of summaries) {
    try {
      const profile = assembleProfile(summary, await fetchHtml(summary.url))
      if (profile) profiles.push(profile)
    } catch {
      if (summary.page > 1) {
        earliestFailedHistoricalPage = earliestFailedHistoricalPage == null
          ? summary.page
          : Math.min(earliestFailedHistoricalPage, summary.page)
      }
    }
  }

  const newest = summaries.find((summary) => summary.page === 1)
  if (earliestFailedHistoricalPage != null) bootstrapComplete = false
  const nextBackfillPage = earliestFailedHistoricalPage
    ?? Math.max(2, lastHistoricalPage + 1)

  return {
    profiles,
    fetched: summaries.length,
    cursor: {
      ...cursor,
      sourceKey: ISHBOR_SOURCE_KEY,
      lastSeenProfileId: newest?.url.match(/\/id\/(\d+)/)?.[1] || cursor.lastSeenProfileId,
      lastSeenUrl: newest?.url || cursor.lastSeenUrl,
      backfillPage: nextBackfillPage,
      bootstrapComplete,
      lastSuccessAt: new Date().toISOString(),
    },
  }
}
