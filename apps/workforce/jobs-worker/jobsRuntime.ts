import { COMMUNITY_JOB_BOARDS } from '../server/utils/communityJobBoardSources'
import { configuredJobRefreshTargets, refreshJobTarget } from '../server/vacancies/application/jobsSourceRefresh'

export function configuredSources(): string[] {
  return configuredJobRefreshTargets()
}

export function communityJobBoardHosts(): string[] {
  const hosts = new Set<string>()
  for (const board of COMMUNITY_JOB_BOARDS) {
    try {
      hosts.add(new URL(board.url).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, ''))
    } catch {
      // Registry URLs are constants; an invalid entry should fail only its source.
    }
  }
  hosts.add('himalayas.app')
  return [...hosts]
}

export async function refreshSource(source: string) {
  return refreshJobTarget(source)
}