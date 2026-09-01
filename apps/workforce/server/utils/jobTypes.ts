// Compatibility facade for Nitro's server/utils import paths.
// Runtime-neutral job contracts live in shared/contracts/jobs.ts so workers,
// server code and client code can depend on one source of truth.
// RiskCategory stays owned by suspicious.ts in the server auto-import namespace
// to avoid duplicate Nitro auto-import exports while migration is in progress.

export {
  ALL_SOURCES,
  EMPLOYMENT_KINDS,
  FREE_SOURCES,
  OPTIONAL_SOURCES,
} from '../../shared/contracts/jobs'

export type {
  EmployerType,
  EmploymentKind,
  Job,
  JobQuery,
  JobResponse,
  JobSkillDetail,
  JobSource,
  JobStats,
  LanguageReq,
  Relocation,
  SalaryPeriod,
  SalaryStat,
  Seniority,
  SortKey,
  SponsorshipConfidence,
  WorkMode,
} from '../../shared/contracts/jobs'
