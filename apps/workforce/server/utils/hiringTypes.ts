// Compatibility facade for existing Nitro server/utils imports.
// Runtime-neutral candidate contracts live in shared/contracts/hiring.ts.

export { HIRING_SOURCES } from '../../shared/contracts/hiring'

export type {
  CandidateContactType,
  CandidateEmploymentType,
  CandidateGender,
  CandidateOrigin,
  CountryMeta,
  CvProfile,
  HiringSource,
  ProfessionExperience,
} from '../../shared/contracts/hiring'
