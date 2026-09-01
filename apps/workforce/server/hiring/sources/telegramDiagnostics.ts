export interface HiringSourceDiagnostic {
  handle: string
  country: string
  status: 'ok' | 'empty' | 'error' | 'disabled'
  fetched: number
  candidateMarkerMatched: number
  rejectedVacancy: number
  rejectedQuality: number
  candidates: number
  mode: 'incremental' | 'backfill' | 'idle'
  newestMessageId: number
  oldestMessageId: number
  bootstrapComplete: boolean
  fetchDurationMs: number
  checkedAt: string
  error?: string
}

let telegramDiagnostics: HiringSourceDiagnostic[] = []

export function recordHiringSourceDiagnostic(diagnostic: HiringSourceDiagnostic): void {
  const handle = diagnostic.handle.toLowerCase()
  const index = telegramDiagnostics.findIndex((item) => item.handle.toLowerCase() === handle)
  if (index >= 0) telegramDiagnostics[index] = diagnostic
  else telegramDiagnostics = [...telegramDiagnostics, diagnostic]
}

export function getHiringSourceDiagnostics(): HiringSourceDiagnostic[] {
  return telegramDiagnostics.map((item) => ({ ...item }))
}
