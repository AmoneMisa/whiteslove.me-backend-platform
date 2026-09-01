const CURSOR_VERSION = 1
const CURSOR_TTL_SECONDS = 30 * 86_400

export const STANDARD_CRAWL_POLICY = Object.freeze({
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
  acceptItem?: (item: T) => boolean
}

interface StatefulOptions<T> extends ExecutionOptions<T> {
  namespace: string
  state: CrawlerStateStore
}

export interface CyclicCrawlOptions<T, Raw = string> extends StatefulOptions<T> {
  /** @deprecated Traversal depth is semantic; this compatibility field is ignored. */
  pagesPerRun?: number
  /** @deprecated Traversal depth is semantic; this compatibility field is ignored. */
  maxPage?: number
  fetchPage: (page: number) => Promise<Raw>
  parsePage: (raw: Raw, page: number) => T[]
  shouldStop?: (items: T[], page: number) => boolean
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
  /** @deprecated Traversal depth is semantic; this compatibility field is ignored. */
  pagesPerRun?: number
  fetchPage: (cursor: string | null) => Promise<Raw>
  parsePage: (raw: Raw, cursor: string | null) => T[]
  nextCursor: (raw: Raw) => string | null
  shouldStop?: (items: T[], cursor: string | null) => boolean
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

function accepted<T>(items: T[], acceptItem?: (item: T) => boolean): T[] {
  return acceptItem ? items.filter(acceptItem) : items
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

/**
 * Traverse numbered pages until a semantic boundary, natural source exhaustion,
 * or repeated page is reached. Numeric page/run caps are intentionally ignored:
 * a transport failure pauses the cursor for retry instead of being reported as
 * successful completion.
 */
export async function crawlCyclic<T, Raw = string>(
  options: CyclicCrawlOptions<T, Raw>,
): Promise<CyclicCrawlRun<T>> {
  const requestDelayMs = Math.max(0, Math.min(10_000, options.requestDelayMs || 0))
  const cursor = await loadCursor(options.state, options.namespace, options.key)
  const startPage = Math.max(2, cursor.nextPage)
  const items: T[] = []
  const readPages: number[] = []
  let nextPage = startPage
  let reachedEnd = false
  let failedHistoricalPage: number | null = null
  let firstSignature: string | null = null
  let previousHistoricalSignature: string | null = null

  const visit = async (page: number): Promise<'continue' | 'stop' | 'failed'> => {
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
        return 'stop'
      }

      readPages.push(page)
      items.push(...accepted(pageItems, options.acceptItem))

      if (!pageItems.length || options.shouldStop?.(pageItems, page)) {
        reachedEnd = true
        return 'stop'
      }

      if (page > 1) {
        previousHistoricalSignature = signature
        nextPage = page + 1
      }
      return 'continue'
    } catch (error) {
      if (page === 1) throw error
      failedHistoricalPage = page
      warn(options, `pagination paused at page ${page}`, error)
      return 'failed'
    }
  }

  const headResult = await visit(1)
  if (headResult === 'continue') {
    let page = startPage
    while (true) {
      const result = await visit(page)
      if (result !== 'continue') break
      page += 1
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

/**
 * Traverse opaque cursors to a semantic boundary or natural end. Legacy
 * pagesPerRun is accepted for compatibility but never limits traversal.
 */
export async function crawlCursor<T, Raw = string>(
  options: CursorCrawlOptions<T, Raw>,
): Promise<CursorCrawlRun<T>> {
  const requestDelayMs = Math.max(0, Math.min(10_000, options.requestDelayMs || 0))
  const saved = await loadOpaqueCursor(options.state, options.namespace, options.key)
  const items: T[] = []
  const cursors: Array<string | null> = []

  const firstRaw = await options.fetchPage(null)
  const firstItems = options.parsePage(firstRaw, null)
  const firstNextCursor = options.nextCursor(firstRaw)
  items.push(...accepted(firstItems, options.acceptItem))
  cursors.push(null)

  let nextCursor = saved.nextCursor || firstNextCursor
  let reachedEnd = !nextCursor || Boolean(options.shouldStop?.(firstItems, null))
  let failedCursor: string | null = null
  const seenCursors = new Set<string>()

  while (!reachedEnd && nextCursor) {
    const currentCursor = nextCursor
    if (seenCursors.has(currentCursor)) {
      reachedEnd = true
      break
    }
    seenCursors.add(currentCursor)
    await delay(requestDelayMs)

    try {
      const raw = await options.fetchPage(currentCursor)
      const pageItems = options.parsePage(raw, currentCursor)
      items.push(...accepted(pageItems, options.acceptItem))
      cursors.push(currentCursor)

      if (!pageItems.length || options.shouldStop?.(pageItems, currentCursor)) {
        reachedEnd = true
        break
      }

      const followingCursor = options.nextCursor(raw)
      if (!followingCursor || followingCursor === currentCursor || seenCursors.has(followingCursor)) {
        reachedEnd = true
        break
      }
      nextCursor = followingCursor
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
