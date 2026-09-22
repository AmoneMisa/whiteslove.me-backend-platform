import { normalizeCompany } from './jobCluster'

/**
 * Employer collections: one company advertising two or more different live
 * roles, the jobs-board counterpart of Flat Finder's owner collections.
 *
 * "Different roles" means distinct cluster keys, not distinct postings. A
 * cluster is the role being advertised (shared/hiring/jobCluster.ts), so one
 * vacancy reposted five times stays one role and does not make an employer
 * look like it is hiring five people. Only `active` vacancies count: a company
 * whose openings have all closed is not currently hiring.
 *
 * Grouping is by normalised company within a country, so "Acme LLC", "ACME,
 * LLC." and "acme" are one employer. The country is part of the identity
 * because the same brand hiring in two countries is two employers to a
 * jobseeker.
 */

export interface JobEmployerIdentity {
  country: string
  company: string
}

/**
 * The key that addresses an employer collection in URLs.
 *
 * Reversible (base64url of "COUNTRY:normalised"), not a hash, unlike Flat
 * Finder's owner key. That key is opaque because it stands for a person's
 * published contact -- a phone number, an email or a Telegram nickname -- and
 * must never be reversible from a URL. A company name identifies no one: it is
 * public and printed on every posting it appears in. Being reversible is what
 * lets a single employer be looked up by an indexed equality match instead of
 * hashing inside SQL (pgcrypto) or materialising an employers table purely to
 * map keys back to names.
 */
export function jobEmployerKey(country: unknown, company: unknown): string | null {
  const normalized = normalizeCompany(company)
  if (!normalized) return null
  const countryCode = String(country ?? '').toUpperCase()
  return Buffer.from(`${countryCode}:${normalized}`, 'utf8').toString('base64url')
}

/** The identity a key stands for, or null when it is not one of ours. */
export function parseJobEmployerKey(value: unknown): JobEmployerIdentity | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{4,512}$/.test(value)) return null
  let decoded: string
  try {
    decoded = Buffer.from(value, 'base64url').toString('utf8')
  } catch {
    return null
  }
  const separator = decoded.indexOf(':')
  if (separator < 0) return null
  const country = decoded.slice(0, separator)
  const company = decoded.slice(separator + 1)
  // Re-normalising rejects a hand-edited key that would otherwise match no
  // rows, and guarantees the key we accept is the key we would have produced.
  if (!company || normalizeCompany(company) !== company) return null
  if (country && !/^[A-Z]{2}$/.test(country)) return null
  return { country, company }
}

/** The threshold that makes a company a collection rather than a one-off post. */
export const MIN_EMPLOYER_ROLES = 2
