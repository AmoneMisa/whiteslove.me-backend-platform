import { crawlStandardJobBoard } from './cyclicJobBoardCrawler'
import { PUBLIC_JOB_BOARDS, parsePublicBoardPage, type PublicBoard } from './extraPublicJobSources'
import type { Job } from '~~/shared/contracts/jobs'

export const PUBLIC_JOB_BOARD_TARGET_PREFIX = 'public-job-board:'

function boardKey(board: PublicBoard): string {
  return board.label
    .toLocaleLowerCase('en')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function targetName(board: PublicBoard): string {
  return `${PUBLIC_JOB_BOARD_TARGET_PREFIX}${boardKey(board)}`
}

export function configuredPublicJobBoardTargets(): string[] {
  if (process.env.PUBLIC_JOB_BOARDS_SOURCE === 'off') return []
  return PUBLIC_JOB_BOARDS.map(targetName)
}

export function isPublicJobBoardTarget(target: string): boolean {
  return target.startsWith(PUBLIC_JOB_BOARD_TARGET_PREFIX)
}

function boardForTarget(target: string): PublicBoard | undefined {
  if (!isPublicJobBoardTarget(target)) return undefined
  const key = target.slice(PUBLIC_JOB_BOARD_TARGET_PREFIX.length)
  return PUBLIC_JOB_BOARDS.find((board) => boardKey(board) === key)
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  })
  if (!response.ok) throw new Error(`${new URL(url).host} -> ${response.status}`)
  return response.text()
}

export async function fetchPublicJobBoardTarget(target: string): Promise<Job[]> {
  const board = boardForTarget(target)
  if (!board) throw new Error(`Unknown public job-board target ${target}`)

  const run = await crawlStandardJobBoard({
    key: `public:${boardKey(board)}`,
    // These legacy one-page adapters do not claim a pagination contract. The
    // standard crawler owns traversal and repeated-page termination; returning
    // the list URL for historical pages makes that fact explicit without a
    // source-local max-page rule.
    fetchPage: () => fetchText(board.url),
    parsePage: (html) => parsePublicBoardPage(html, board),
  })
  return run.jobs
}
