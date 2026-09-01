const CURSOR_VERSION = 1
const CURSOR_TTL_SECONDS = 30 * 86_400

export const STANDARD_CRAWL_POLICY = Object.freeze({
  pagesPerRun: 2,
  maxPage: 10_000,
  requestDelayMs: 500,
})

export interface CrawlerStateStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>
}

interface CrawlCursor {
  version: number
  nextPage: number
  cycle: number
  lastSuccessAt: string | null
}

interface OpaqueCrawlCursor {
  version: number
  nextCursor: string | null
  cycle: number
  lastSuccessAt: string | null
}

interface ExecutionOptions<T> {
  key: string
  itemKey: (item: T) => string
  requestDelayMs?: number
  logPrefix?: string
  logger?: Pick<Console, 'warn'>
}

interface StatefulOptions<T> extends ExecutionOptions<T> {
  namespace: string
  state: CrawlerStateStore
}

export interface CyclicCrawlOptions<T, Raw = string> extends StatefulOptions<T> {
  pagesPerRun: number
  maxPage: number
  fetchPage: (page: number) => Promise<Raw>
  parsePage: (raw: Raw, page: number) => T[]
  stopOnRepeatedPage?: boolean
}

export interface CyclicCrawlRun<T> {
  items: T[]
  pages: number[]
  nextPage: number
  cycle: number
  reachedEnd: boolean
}

export interface CursorCrawlOptions<T, Raw = string> extends StatefulOptions<T> {
  pagesPerRun: number
  fetchPage: (cursor: string | null) => Promise<Raw>
  parsePage: (raw: Raw, cursor: string | null) => T[]
  nextCursor: (raw: Raw) => string | null
}

export interface CursorCrawlRun<T> {
  items: T[]
  cursors: Array<string | null>
  nextCursor: string | null
  cycle: number
  reachedEnd: boolean
}

export interface DetailEnrichmentOptions<T, Raw = string> extends ExecutionOptions<T> {
  items: T[]
  fetchDetail: (item: T) => Promise<Raw>
  parseDetail: (raw: Raw, summary: T) => T | null
}

function defaultCursor(): CrawlCursor {
  return {
    version: CURSOR_VERSION,
    nextPage: 2,
    cycle: 0,
    lastSuccessAt: null,
  }
}

function defaultOpaqueCursor(): OpaqueCrawlCursor {
  return {
    version: CURSOR_VERSION,
    nextCursor: null,
    cycle: 0,
    lastSuccessAt: null,
  }
}

function cursorKey(namespace: string, key: string): string {
  return `${namespace}-cursor:v${CURSOR_VERSION}:${key}`
}

function opaqueCursorKey(namespace: string, key: string): string {
  return `${namespace}-opaque-cursor:v${CURSOR_VERSION}:${key}`
}

async function loadCursor(state: CrawlerStateStore, namespace: string, key: string): Promise<CrawlCursor> {
  const raw = await state.get(cursorKey(namespace, key))
  if (!raw) return defaultCursor()
  try {
    const parsed = JSON.parse(raw) as Partial<CrawlCursor>
    return {
      version: CURSOR_VERSION,
      nextPage: Math.max(2, Number(parsed.nextPage) || 2),
      cycle: Math.max(0, Number(parsed.cycle) || 0),
      lastSuccessAt: typeof parsed.lastSuccessAt === 'string' ? parsed.lastSuccessAt : null,
    }
  } catch {
    return defaultCursor()
  }
}

async function loadOpaqueCursor(
  state: CrawlerStateStore,
  namespace: string,
  key: string,
): Promise<OpaqueCrawlCursor> {
  const raw = await state.get(opaqueCursorKey(namespace, key))
  if (!raw) return defaultOpaqueCursor()
  try {
    const parsed = JSON.parse(raw) as Partial<OpaqueCrawlCursor>
    return {
      version: CURSOR_VERSION,
      nextCursor: typeof parsed.nextCursor === 'string' && parsed.nextCursor ? parsed.nextCursor : null,
      cycle: Math.max(0, Number(parsed.cycle) || 0),
      lastSuccessAt: typeof parsed.lastSuccessAt === 'string' ? parsed.lastSuccessAt : null,
    }
  } catch {
    return defaultOpaqueCursor()
  }
}

async function saveCursor(
  state: CrawlerStateStore,
  namespace: string,
  key: string,
  cursor: CrawlCursor,
): Promise<void> {
  await state.set(
    cursorKey(namespace, key),
    JSON.stringify(cursor),
    'EX',
    CURSOR_TTL_SECONDS,
  )
}

async function saveOpaqueCursor(
  state: CrawlerStateStore,
  namespace: string,
  key: string,
  cursor: OpaqueCrawlCursor,
): Promise<void> {
  await state.set(
    opaqueCursorKey(namespace, key),
    JSON.stringify(cursor),
    'EX',
    CURSOR_TTL_SECONDS,
  )
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

function dedupe<T>(items: T[], itemKey: (item: T) => string): T[] {
  const byKey = new Map<string, T>()
  for (const item of items) byKey.set(itemKey(item), item)
  return [...byKey.values()]
}

function pageSignature<T>(items: T[], itemKey: (item: T) => string): string {
  return items.map(itemKey).sort().join('\n')
}

function warn(
  options: Pick<ExecutionOptions<unknown>, 'key' | 'logPrefix' | 'logger'>,
  message: string,
  error: unknown,
): void {
  const logger = options.logger || console
  const prefix = options.logPrefix ? `${options.logPrefix} ` : ''
  logger.warn(
    `${prefix}${options.key} ${message}:`,
    error instanceof Error ? error.message : String(error),
  )
}

export async function crawlCyclic<T, Raw = string>(
  options: CyclicCrawlOptions<T, Raw>,
): Promise<CyclicCrawlRun<T>> {
  const pagesPerRun = Math.max(1, Math.min(50, options.pagesPerRun))
  const maxPage = Math.max(2, Math.min(10_000, options.maxPage))
  const requestDelayMs = Math.max(0, Math.min(10_000, options.requestDelayMs || 0))
  const cursor = await loadCursor(options.state, options.namespace, options.key)
  const startPage = Math.min(maxPage, Math.max(2, cursor.nextPage))
  const historicalPages = Array.from(
    { length: Math.min(pagesPerRun, maxPage - startPage + 1) },
    (_, index) => startPage + index,
  )
  const pages = [1, ...historicalPages]
  const items: T[] = []
  const readPages: number[] = []
  let nextPage = startPage
  let reachedEnd = false
  let failedHistoricalPage: number | null = null
  let firstSignature: string | null = null
  let previousHistoricalSignature: string | null = null

  for (const page of pages) {
    if (readPages.length) await delay(requestDelayMs)
    try {
      const pageItems = options.parsePage(await options.fetchPage(page), page)
      const signature = pageSignature(pageItems, options.itemKey)

      if (page === 1) {
        firstSignature = signature
      } else if (
        options.stopOnRepeatedPage
        && signature
        && (signature === firstSignature || signature === previousHistoricalSignature)
      ) {
        reachedEnd = true
        break
      }

      readPages.push(page)
      items.push(...pageItems)

      if (page > 1) {
        previousHistoricalSignature = signature
        if (!pageItems.length) {
          reachedEnd = true
          break
        }
        nextPage = page + 1
        if (nextPage > maxPage) reachedEnd = true
      }
    } catch (error) {
      if (page === 1) throw error
      failedHistoricalPage = page
      warn(options, `pagination paused at page ${page}`, error)
      break
    }
  }

  if (failedHistoricalPage != null) nextPage = failedHistoricalPage
  const cycle = reachedEnd ? cursor.cycle + 1 : cursor.cycle
  if (reachedEnd) nextPage = 2

  await saveCursor(options.state, options.namespace, options.key, {
    version: CURSOR_VERSION,
    nextPage,
    cycle,
    lastSuccessAt: new Date().toISOString(),
  })

  return {
    items: dedupe(items, options.itemKey),
    pages: readPages,
    nextPage,
    cycle,
    reachedEnd,
  }
}

export async function crawlCursor<T, Raw = string>(
  options: CursorCrawlOptions<T, Raw>,
): Promise<CursorCrawlRun<T>> {
  const pagesPerRun = Math.max(1, Math.min(50, options.pagesPerRun))
  const requestDelayMs = Math.max(0, Math.min(10_000, options.requestDelayMs || 0))
  const saved = await loadOpaqueCursor(options.state, options.namespace, options.key)
  const items: T[] = []
  const cursors: Array<string | null> = []

  const firstRaw = await options.fetchPage(null)
  const firstItems = options.parsePage(firstRaw, null)
  const firstNextCursor = options.nextCursor(firstRaw)
  items.push(...firstItems)
  cursors.push(null)

  let nextCursor = saved.nextCursor || firstNextCursor
  let reachedEnd = !nextCursor
  let failedCursor: string | null = null

  for (let index = 0; index < pagesPerRun && nextCursor; index += 1) {
    await delay(requestDelayMs)
    const currentCursor = nextCursor
    try {
      const raw = await options.fetchPage(currentCursor)
      const pageItems = options.parsePage(raw, currentCursor)
      items.push(...pageItems)
      cursors.push(currentCursor)
      nextCursor = options.nextCursor(raw)
      if (!nextCursor) reachedEnd = true
    } catch (error) {
      failedCursor = currentCursor
      warn(options, 'cursor pagination paused', error)
      break
    }
  }

  if (failedCursor) nextCursor = failedCursor
  const cycle = reachedEnd ? saved.cycle + 1 : saved.cycle
  if (reachedEnd) nextCursor = firstNextCursor

  await saveOpaqueCursor(options.state, options.namespace, options.key, {
    version: CURSOR_VERSION,
    nextCursor,
    cycle,
    lastSuccessAt: new Date().toISOString(),
  })

  return {
    items: dedupe(items, options.itemKey),
    cursors,
    nextCursor,
    cycle,
    reachedEnd,
  }
}

export async function enrichDetails<T, Raw = string>(
  options: DetailEnrichmentOptions<T, Raw>,
): Promise<T[]> {
  const items = dedupe(options.items, options.itemKey)
  const output: T[] = []
  const requestDelayMs = Math.max(0, Math.min(10_000, options.requestDelayMs || 0))

  for (const item of items) {
    if (output.length) await delay(requestDelayMs)
    try {
      const raw = await options.fetchDetail(item)
      output.push(options.parseDetail(raw, item) || item)
    } catch (error) {
      warn(options, `detail failed ${options.itemKey(item)}`, error)
      output.push(item)
    }
  }

  return output
}
