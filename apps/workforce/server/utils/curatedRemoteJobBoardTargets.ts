import {
  CURATED_REMOTE_BOARDS,
  parseCuratedRemoteBoardHtml,
  parseWorkingNomadsItems,
  type RemoteBoard,
  type WorkingNomadsItem,
} from './curatedRemoteJobSources'
import { crawlStandardJobBoard } from './cyclicJobBoardCrawler'
import type { Job } from './jobTypes'

export const CURATED_REMOTE_JOB_BOARD_TARGET_PREFIX = 'curated-remote-job-board:'

function targetName(board: RemoteBoard): string {
  return `${CURATED_REMOTE_JOB_BOARD_TARGET_PREFIX}${board.key}`
}

export function configuredCuratedRemoteJobBoardTargets(): string[] {
  if (String(process.env.CURATED_REMOTE_JOB_SOURCES || 'on').toLowerCase() === 'off') return []
  return CURATED_REMOTE_BOARDS.map(targetName)
}

export function isCuratedRemoteJobBoardTarget(target: string): boolean {
  return target.startsWith(CURATED_REMOTE_JOB_BOARD_TARGET_PREFIX)
}

function boardForTarget(target: string): RemoteBoard | undefined {
  if (!isCuratedRemoteJobBoardTarget(target)) return undefined
  const key = target.slice(CURATED_REMOTE_JOB_BOARD_TARGET_PREFIX.length)
  return CURATED_REMOTE_BOARDS.find((board) => board.key === key)
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  })
  if (!response.ok) throw new Error(`${new URL(url).host} -> ${response.status}`)
  return response.text()
}

function parseWorkingNomads(raw: string): Job[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parseWorkingNomadsItems(Array.isArray(parsed) ? parsed as WorkingNomadsItem[] : [])
  } catch {
    return []
  }
}

export async function fetchCuratedRemoteJobBoardTarget(target: string): Promise<Job[]> {
  const board = boardForTarget(target)
  if (!board) throw new Error(`Unknown curated remote job-board target ${target}`)

  const apiUrl = board.key === 'working-nomads'
    ? 'https://www.workingnomads.com/api/exposed_jobs/'
    : board.listUrl
  const run = await crawlStandardJobBoard({
    key: `curated-remote:${board.key}`,
    // No adapter-local category fan-out or pagination policy. Boards without a
    // documented page contract expose the same list endpoint; repeated-page
    // termination belongs to the shared crawler.
    fetchPage: () => fetchText(apiUrl),
    parsePage: (raw) => board.key === 'working-nomads'
      ? parseWorkingNomads(raw)
      : parseCuratedRemoteBoardHtml(raw, board.key, board.listUrl),
  })
  return run.jobs
}
