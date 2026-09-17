/**
 * Candidate deduplication (§38).
 *
 * Only strong identifiers merge: the same email, phone, Telegram platform id or
 * linked social identity. Name, employment chronology, skills and education
 * corroborate a strong match but never create one -- two people called
 * "Aziz Karimov" who both know TypeScript are two people, and merging them
 * would hand one candidate the other's history and contact details.
 *
 * Normal professional change is not identity churn (§23): a new title, a new
 * employer or a new city is what a CV is supposed to show over time.
 */

export type CandidateIdentityInput = {
  emails?: (string | null | undefined)[]
  phones?: (string | null | undefined)[]
  telegramIds?: (string | null | undefined)[]
  socialIds?: (string | null | undefined)[]
  name?: string | null
  employers?: (string | null | undefined)[]
  skills?: (string | null | undefined)[]
  education?: (string | null | undefined)[]
}

export type CandidateMatch = {
  merge: boolean
  basis: string[]
  corroboration: string[]
  strength: 'strong' | 'weak' | 'none'
}

const clean = (values: (string | null | undefined)[] | undefined, normalize: (value: string) => string | null): Set<string> => {
  const result = new Set<string>()
  for (const value of values ?? []) {
    const normalized = value ? normalize(String(value)) : null
    if (normalized) result.add(normalized)
  }
  return result
}

const normalizeEmail = (value: string): string | null => {
  const text = value.trim().toLocaleLowerCase('en-US')
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(text) ? text : null
}

/** Digits only, and long enough to be a real number rather than an extension. */
const normalizePhone = (value: string): string | null => {
  const digits = value.replace(/\D+/gu, '')
  return digits.length >= 9 && digits.length <= 15 ? digits : null
}

const normalizeId = (value: string): string | null => {
  const text = value.trim().toLocaleLowerCase('en-US')
  return text || null
}

const normalizeText = (value: string): string | null => {
  const text = value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  return text || null
}

const intersects = (left: Set<string>, right: Set<string>): boolean => {
  for (const value of left) if (right.has(value)) return true
  return false
}

const overlapRatio = (left: Set<string>, right: Set<string>): number => {
  if (!left.size || !right.size) return 0
  let shared = 0
  for (const value of left) if (right.has(value)) shared += 1
  return shared / Math.min(left.size, right.size)
}

export function matchCandidates(left: CandidateIdentityInput, right: CandidateIdentityInput): CandidateMatch {
  const basis: string[] = []
  if (intersects(clean(left.emails, normalizeEmail), clean(right.emails, normalizeEmail))) basis.push('same_email')
  if (intersects(clean(left.phones, normalizePhone), clean(right.phones, normalizePhone))) basis.push('same_phone')
  if (intersects(clean(left.telegramIds, normalizeId), clean(right.telegramIds, normalizeId))) basis.push('same_telegram_id')
  if (intersects(clean(left.socialIds, normalizeId), clean(right.socialIds, normalizeId))) basis.push('same_social_identity')

  const corroboration: string[] = []
  const leftName = left.name ? normalizeText(left.name) : null
  const rightName = right.name ? normalizeText(right.name) : null
  if (leftName && leftName === rightName) corroboration.push('same_name')
  if (overlapRatio(clean(left.employers, normalizeText), clean(right.employers, normalizeText)) >= 0.5) corroboration.push('overlapping_employers')
  if (overlapRatio(clean(left.skills, normalizeText), clean(right.skills, normalizeText)) >= 0.6) corroboration.push('overlapping_skills')
  if (overlapRatio(clean(left.education, normalizeText), clean(right.education, normalizeText)) >= 0.5) corroboration.push('overlapping_education')

  if (basis.length) return { merge: true, basis, corroboration, strength: 'strong' }
  // Weak signals, however many, never merge. They are reported so a reviewer
  // can decide, which is the only safe place for that judgement.
  return { merge: false, basis, corroboration, strength: corroboration.length ? 'weak' : 'none' }
}

/**
 * Groups candidate profiles by strong identifiers only (union-find), so a
 * chain of shared emails and phones resolves to one person without any name
 * comparison. O(n * identifiers), never pairwise.
 */
export function groupCandidateProfiles<T extends CandidateIdentityInput & { id: string }>(profiles: T[]): string[][] {
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root) as string
    let node = id
    while (parent.get(node) !== root) { const next = parent.get(node) as string; parent.set(node, root); node = next }
    return root
  }
  const union = (a: string, b: string): void => {
    const rootA = find(a), rootB = find(b)
    if (rootA !== rootB) parent.set(rootB < rootA ? rootA : rootB, rootB < rootA ? rootB : rootA)
  }

  const owner = new Map<string, string>()
  for (const profile of profiles ?? []) {
    parent.set(profile.id, profile.id)
    const keys = [
      ...[...clean(profile.emails, normalizeEmail)].map((value) => `email:${value}`),
      ...[...clean(profile.phones, normalizePhone)].map((value) => `phone:${value}`),
      ...[...clean(profile.telegramIds, normalizeId)].map((value) => `tg:${value}`),
      ...[...clean(profile.socialIds, normalizeId)].map((value) => `social:${value}`),
    ]
    for (const key of keys) {
      const existing = owner.get(key)
      if (existing) union(existing, profile.id)
      else owner.set(key, profile.id)
    }
  }

  const groups = new Map<string, string[]>()
  for (const profile of profiles ?? []) {
    const root = find(profile.id)
    const group = groups.get(root) ?? []
    group.push(profile.id)
    groups.set(root, group)
  }
  return [...groups.values()].map((group) => group.sort()).sort((a, b) => a[0].localeCompare(b[0]))
}
