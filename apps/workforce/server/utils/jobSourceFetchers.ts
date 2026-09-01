import type { Job, JobSource } from './jobTypes'
import {
  fetchArbeitnow,
  fetchDevKg,
  fetchJobicy,
  fetchRemoteOk,
  fetchRemotive,
} from './sources'

const targetizedSource = async (): Promise<Job[]> => []

const FETCHERS: Record<JobSource, (query: string) => Promise<Job[]>> = {
  remotive: fetchRemotive,
  remoteok: fetchRemoteOk,
  arbeitnow: fetchArbeitnow,
  themuse: targetizedSource,
  jobicy: fetchJobicy,
  hh: targetizedSource,
  adzuna: targetizedSource,
  jooble: targetizedSource,
  rss: targetizedSource,
  companies: targetizedSource,
  linkedin: targetizedSource,
  facebook: targetizedSource,
  threads: targetizedSource,
  devkg: fetchDevKg,
  ishgo: targetizedSource,
  itjobsuz: targetizedSource,
  telegram: targetizedSource,
  olx: targetizedSource,
}

export async function fetchJobSource(source: JobSource): Promise<Job[]> {
  return FETCHERS[source]('')
}
