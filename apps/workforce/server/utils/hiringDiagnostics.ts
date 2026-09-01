// Compatibility facade for existing Nitro/source imports.
// Runtime-neutral hiring diagnostics live in shared/hiring.

export {
  getHiringWebDiagnostics,
  recordWebDiagnostic,
  runOrigin,
} from '../../shared/hiring/hiringDiagnostics'

export type {
  SourceRun,
  WebSourceDiagnostic,
} from '../../shared/hiring/hiringDiagnostics'
