import { fetchHiringChannel } from '../sources/telegramRuntime'
import { persistTelegramCandidates } from './candidateSnapshotWriter'

/**
 * Fetch one configured Telegram channel and persist its candidate profiles.
 * Transport/parsing stays behind the source boundary; snapshot mutation and AI
 * enrichment are owned by candidateSnapshotWriter.
 */
export async function refreshHiringChannel(handle: string): Promise<{ fetched: number; stored: number } | null> {
  const outcome = await fetchHiringChannel(handle)
  if (!outcome) return null

  const stored = await persistTelegramCandidates(outcome.result.profiles, outcome.diagnostic)
  return { fetched: outcome.diagnostic.fetched, stored }
}
