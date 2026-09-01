import { detectUsLocation } from '@whiteslove/parsing-lexicon/hiring-source-semantics'
import { detectWorkModes } from '@whiteslove/parsing-lexicon/hiring-work-semantics'
import { crawlStandardJobBoard } from './cyclicJobBoardCrawler'
import type { Job } from './jobTypes'

const REPO = 'NotifyYouInc/2026-H1B-Sponsor-Jobs'
const API = `https://api.github.com/repos/${REPO}`
const RAW = `https://raw.githubusercontent.com/${REPO}`

interface GitHubCommitRef {
  sha: string
}

interface GitHubCommitFile {
  filename: string
  status: string
}

interface GitHubCommitDetail {
  sha: string
  files?: GitHubCommitFile[]
}

type HydratedJobFile = {
  filename: string
  markdown: string
}

function headers(accept = 'application/vnd.github+json'): Record<string, string> {
  const token = process.env.USA_VISA_GITHUB_TOKEN?.trim()
  return {
    Accept: accept,
    'User-Agent': 'whiteslove-job-finder/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: headers() })
  if (!response.ok) throw new Error(`GitHub H1B feed -> ${response.status}`)
  return response.json() as Promise<T>
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { 'User-Agent': 'whiteslove-job-finder/1.0' } })
  if (!response.ok) throw new Error(`GitHub H1B raw -> ${response.status}`)
  return response.text()
}

function field(markdown: string, name: string): string | undefined {
  const match = markdown.match(new RegExp(`\\|\\s*${name}\\s*\\|\\s*([^\\n|]+)`, 'i'))
  return match?.[1]?.trim()
}

function markdownLinkText(value: string | undefined): string | undefined {
  if (!value) return undefined
  const match = value.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
  return match?.[1]?.trim() || value.trim()
}

function markdownLinkUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  const match = value.match(/\]\((https?:\/\/[^)]+)\)/)
  return match?.[1]?.trim()
}

function postedAt(value: string | undefined): string {
  const parsed = Date.parse(value || '')
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString()
}

function parseJob(markdown: string, filename: string): Job | null {
  const heading = markdown.match(/^#\s+(.+?)\s+at\s+(.+)$/m)
  const companyField = field(markdown, 'Company')
  const title = heading?.[1]?.trim()
  const company = markdownLinkText(companyField) || heading?.[2]?.trim()
  const location = field(markdown, 'Location') || ''
  const category = field(markdown, 'Category') || undefined
  const applyUrl = markdownLinkUrl(field(markdown, 'Apply'))

  if (!title || !company || !applyUrl || !detectUsLocation(location)) return null

  const evidence = 'Current opening from a company included in the 2026 H1B Sponsor Jobs feed; sponsorship for this exact role is not guaranteed.'

  return {
    id: `h1b-github-${filename.replace(/[^a-z0-9_-]+/gi, '-')}`,
    title,
    company,
    location,
    url: applyUrl,
    applyUrl,
    source: 'companies',
    remote: detectWorkModes(`${title} ${location}`).includes('remote'),
    tags: ['H1B Sponsor Feed', 'H1B sponsor history', 'USA', category].filter(Boolean) as string[],
    postedAt: postedAt(field(markdown, 'Posted')),
    description: evidence,
    sponsorshipConfidence: 'historical',
    sponsorshipEvidence: [evidence],
  }
}

async function fetchCommitPage(page: number): Promise<string> {
  // per_page is the upstream GitHub API page shape. Historical traversal and
  // page rotation are owned by crawlStandardJobBoard.
  const commits = await fetchJson<GitHubCommitRef[]>(`${API}/commits?per_page=100&page=${page}`)
  const files = new Map<string, HydratedJobFile>()

  for (const commit of commits) {
    if (!commit?.sha) continue
    const detail = await fetchJson<GitHubCommitDetail>(`${API}/commits/${encodeURIComponent(commit.sha)}`)
    for (const file of detail.files || []) {
      if (file.status === 'removed' || !/^jobs\/[^/]+\.md$/i.test(file.filename) || file.filename.endsWith('/.gitkeep')) continue
      if (files.has(file.filename)) continue
      const encodedPath = file.filename.split('/').map(encodeURIComponent).join('/')
      try {
        const markdown = await fetchText(`${RAW}/${encodeURIComponent(detail.sha || commit.sha)}/${encodedPath}`)
        files.set(file.filename, { filename: file.filename, markdown })
      } catch (error) {
        console.warn(
          `[jobs:h1b] ${file.filename} failed:`,
          error instanceof Error ? error.message : String(error),
        )
      }
    }
  }

  return JSON.stringify([...files.values()])
}

function parseCommitPage(raw: string): Job[] {
  let files: HydratedJobFile[]
  try {
    const parsed = JSON.parse(raw) as unknown
    files = Array.isArray(parsed) ? parsed as HydratedJobFile[] : []
  } catch {
    return []
  }

  const byUrl = new Map<string, Job>()
  for (const file of files) {
    const job = parseJob(file.markdown, file.filename)
    if (job) byUrl.set(job.url, job)
  }
  return [...byUrl.values()]
}

export const USA_VISA_SPONSOR_TARGET = 'usa-visa-sponsor:h1b-github'

export function configuredUsaVisaSponsorTargets(): string[] {
  return process.env.USA_VISA_SPONSOR_SOURCE === 'off' ? [] : [USA_VISA_SPONSOR_TARGET]
}

export function isUsaVisaSponsorTarget(target: string): boolean {
  return target === USA_VISA_SPONSOR_TARGET
}

export async function fetchUsaVisaSponsorTarget(target: string): Promise<Job[]> {
  if (!isUsaVisaSponsorTarget(target)) throw new Error(`Unknown USA visa sponsor target ${target}`)
  const run = await crawlStandardJobBoard({
    key: 'usa-visa-sponsor:h1b-github',
    fetchPage: fetchCommitPage,
    parsePage: (raw) => parseCommitPage(raw),
  })
  return run.jobs
}
