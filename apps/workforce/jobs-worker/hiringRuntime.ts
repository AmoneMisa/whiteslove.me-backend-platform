import { hiringRefreshAdapters } from './hiringAdapters'
import { hiringIshBorSourceHandles } from '../shared/hiring/sources/ishBorSource'
import { hiringUzJobsSourceHandles } from '../shared/hiring/sources/uzJobsSource'
import { hiringSocialSourceHandles } from '../shared/hiring/sources/socialSources'
import { hiringLinkedInSourceHandles } from '../shared/hiring/sources/linkedInSources'
import { hiringSecondaryWebSourceHandles } from '../shared/hiring/sources/secondaryWebSources'
import { hiringWebSourceHandles } from '../shared/hiring/sources/webCvSources'
import { hiringTelegramChannelHandles } from '../shared/hiring/sources/telegramChannels'

function hasHandle(handles: string[], normalized: string): boolean {
  return handles.some((item) => item.toLowerCase() === normalized)
}

export function allHiringTargets() {
  const telegramHandles = hiringTelegramChannelHandles()
  const progressiveWebHandles = [
    ...hiringWebSourceHandles(),
    ...hiringIshBorSourceHandles(),
    ...hiringUzJobsSourceHandles(),
  ]
  const hiringHandles = [
    ...telegramHandles,
    ...progressiveWebHandles,
    ...hiringSecondaryWebSourceHandles(),
    ...hiringSocialSourceHandles(),
    ...hiringLinkedInSourceHandles(),
  ]

  return { telegramHandles, progressiveWebHandles, hiringHandles }
}

export async function refreshHiringTarget(rawHandle: string) {
  const handle = String(rawHandle || '').replace(/^@/, '')
  const normalized = handle.toLowerCase()
  const adapter = hiringRefreshAdapters.find(({ handles }) => hasHandle(handles(), normalized))

  if (!handle || !adapter) {
    throw new Error(`Unknown hiring source: ${handle || '<empty>'}`)
  }

  const result = await adapter.refresh(handle)
  if (!result) throw new Error(`Hiring source is disabled: ${handle}`)

  return { handle, ...(result as Record<string, unknown>) }
}
