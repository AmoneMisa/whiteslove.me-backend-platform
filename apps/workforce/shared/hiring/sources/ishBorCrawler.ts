import type { WebCursor } from '../hiringCursors'
import { absoluteHttpUrl } from '../../htmlText'
import { htmlText } from '../webFields'
import { ISHBOR_SOURCE_KEY } from './ishBorSource'

const REQUEST_TIMEOUT_MS = 25_000
const MAX_PAGES = 3
const DETAIL_BATCH = 6
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
  const response = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'ru,en;q=0.8',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
  const backfillPages = Math.max(1, Math.min(
    10,
    Number(process.env.HIRING_ISHBOR_BACKFILL_PAGES)
      || Math.max(1, (Number(process.env.HIRING_ISHBOR_MAX_PAGES) || MAX_PAGES) - 1),
  ))
  const backfillStart = Math.max(2, cursor.backfillPage || 1)
  const pages = cursor.bootstrapComplete
    ? [1]
    : [1, ...Array.from({ length: backfillPages }, (_, index) => backfillStart + index)]
  let bootstrapComplete = cursor.bootstrapComplete
  let lastHistoricalPage = backfillStart - 1

  for (const page of pages) {
    const url = page === 1
      ? 'https://ish-bor.uz/ru/ishchilar'
      : `https://ish-bor.uz/ru/ishchilar?page=${page}`
    const summaries = listSummaries(await fetchHtml(url))
    if (page > 1) lastHistoricalPage = page
    if (!summaries.length) {
      // A sparse/old page is not proof that newer profiles cannot exist below it.
      // Only the board returning no rows closes the historical walk.
      if (page > 1) bootstrapComplete = true
      break
    }
    summaries.forEach((item) => all.set(item.url, { ...item, page }))
  }

  const summaries = [...all.values()]
  const profiles: T[] = []
  let earliestFailedHistoricalPage: number | null = null
  for (let offset = 0; offset < summaries.length; offset += DETAIL_BATCH) {
    const batch = summaries.slice(offset, offset + DETAIL_BATCH)
    const results = await Promise.allSettled(
      batch.map(async (summary) => ({
        page: summary.page,
        profile: assembleProfile(summary, await fetchHtml(summary.url)),
      })),
    )
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        if (result.value.profile) profiles.push(result.value.profile)
        return
      }
      const page = batch[index]!.page
      if (page > 1) {
        earliestFailedHistoricalPage = earliestFailedHistoricalPage == null
          ? page
          : Math.min(earliestFailedHistoricalPage, page)
      }
    })
  }

  const newest = summaries.find((summary) => summary.page === 1)
  const nextBackfillPage = bootstrapComplete
    ? Math.max(2, cursor.backfillPage || 1)
    : earliestFailedHistoricalPage
      ?? Math.max(backfillStart + 1, lastHistoricalPage + 1)

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
