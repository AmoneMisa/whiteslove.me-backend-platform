// Runtime-neutral diagnostics for candidate source runs.

export interface SourceRun {
  handle: string
  country: string
  status: 'ok' | 'empty' | 'error' | 'disabled'
  fetched: number
  candidates: number
  checkedAt: string
  error?: string
}

export function runOrigin(handle: string): 'telegram' | 'web' | 'social' {
  if (/^(?:social|linkedin):/i.test(handle)) return 'social'
  return /^web:/i.test(handle) ? 'web' : 'telegram'
}

export interface WebSourceDiagnostic extends SourceRun {
  key: string
  label: string
  pages: number
  blocks: number
  parsed: number
  rejected: number
  duplicate: number
  expired: number
  shown: number
  fetchDurationMs: number
  newestActivityAt: string | null
  oldestActivityAt: string | null
  lastSeenProfileId: string
  lastSuccessAt: string | null
  reachedCursor: boolean
}

const webDiagnostics = new Map<string, WebSourceDiagnostic>()

export function recordWebDiagnostic(diagnostic: WebSourceDiagnostic): void {
  webDiagnostics.set(diagnostic.key, diagnostic)
}

export function getHiringWebDiagnostics(): WebSourceDiagnostic[] {
  return [...webDiagnostics.values()].sort((a, b) => a.key.localeCompare(b.key))
}
