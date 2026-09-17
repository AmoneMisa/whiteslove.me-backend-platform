import { randomBytes } from 'node:crypto';
import { parsePhoneNumbers, normalizeTelegramContact } from '@whiteslove/parsing-lexicon/contact';

/**
 * Data-subject request workflow (§47, GDPR Articles 12, 15-21).
 *
 * The rule the whole module is built around: a request may only ever select
 * data through identifiers whose control has been *verified*. Anyone can type
 * someone else's phone number into a form, and an access request answered on
 * a claimed identifier is a disclosure of that other person's data.
 *
 * Verification is proportionate (Article 12(6)): proving control of the phone,
 * username or email the data is keyed on. No identity documents are asked for
 * -- a passport scan proves a name, and this system does not key anyone on
 * their name.
 */

export const REQUEST_TYPES = Object.freeze(['access', 'rectification', 'erasure', 'restriction', 'objection', 'portability', 'dispute']);
export const REQUEST_STATUSES = Object.freeze(['received', 'identity_verification_required', 'in_review', 'fulfilled', 'partially_fulfilled', 'rejected_with_reason']);
export const OPEN_STATUSES = Object.freeze(['received', 'identity_verification_required', 'in_review']);
export const IDENTIFIER_TYPES = Object.freeze(['phone', 'email', 'telegram', 'whatsapp', 'viber', 'facebook', 'threads']);
export const VERIFICATION_METHODS = Object.freeze(['code_to_phone', 'code_to_email', 'message_from_account', 'reply_from_email']);

export const MAX_DETAILS = 5000;
export const MAX_IDENTIFIERS = 10;

/** Allowed status transitions. Terminal states have none: a closed request
 * that needs more work is a new request, so the history stays truthful. */
export const STATUS_TRANSITIONS = Object.freeze({
  received: Object.freeze(['identity_verification_required', 'in_review', 'rejected_with_reason']),
  identity_verification_required: Object.freeze(['in_review', 'rejected_with_reason']),
  in_review: Object.freeze(['identity_verification_required', 'fulfilled', 'partially_fulfilled', 'rejected_with_reason']),
  fulfilled: Object.freeze([]),
  partially_fulfilled: Object.freeze([]),
  rejected_with_reason: Object.freeze([]),
});

const REASON_REQUIRED = new Set(['partially_fulfilled', 'rejected_with_reason']);
const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[^\s@<>"']{2,24}$/u;

/** An unguessable reference for the requester. 120 bits, URL-safe. */
export function newRequestReference() {
  return `PR-${randomBytes(15).toString('base64url')}`;
}

/** Calendar-month arithmetic, clamped to month end (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date, months) {
  const from = new Date(date);
  const target = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, 1, from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(from.getUTCDate(), lastDay));
  return target;
}

/** Article 12(3): one month from receipt; an extension adds two more. */
export function requestDueAt(receivedAt, { extended = false } = {}) {
  return addMonths(receivedAt, extended ? 3 : 1);
}

/**
 * Canonical identifier, in the same form the contact tables store, so a
 * verified identifier selects rows through the unique index. Null when the
 * value is not a usable identifier of that type.
 */
export function canonicalIdentifier(type, value) {
  const text = String(value ?? '').normalize('NFKC').trim();
  if (!text || text.length > 200) return null;
  switch (type) {
    case 'phone':
    case 'whatsapp':
    case 'viber': {
      const phone = parsePhoneNumbers(text).find((item) => item.valid);
      return phone ? phone.number : null;
    }
    case 'telegram': {
      const telegram = normalizeTelegramContact(text);
      const username = typeof telegram === 'string' ? telegram : telegram?.username;
      return username ? String(username).replace(/^@/u, '').toLowerCase() : null;
    }
    case 'email':
      return EMAIL.test(text) ? text.toLowerCase() : null;
    case 'facebook':
    case 'threads':
      return /^[\p{L}\p{N}._-]{2,100}$/u.test(text.replace(/^@/u, '')) ? text.replace(/^@/u, '').toLowerCase() : null;
    default:
      return null;
  }
}

/**
 * Validates and minimises a public intake submission.
 *
 * Unknown fields are dropped, not stored: whatever a client sends beyond this
 * shape is data the request does not need.
 */
export function validateIntake(body) {
  const errors = [];
  const input = body && typeof body === 'object' ? body : {};

  const requestType = String(input.requestType ?? '');
  if (!REQUEST_TYPES.includes(requestType)) errors.push('request_type_invalid');

  const requesterEmail = String(input.requesterEmail ?? '').trim();
  if (!EMAIL.test(requesterEmail)) errors.push('requester_email_invalid');

  const rawIdentifiers = Array.isArray(input.identifiers) ? input.identifiers : [];
  if (rawIdentifiers.length > MAX_IDENTIFIERS) errors.push('too_many_identifiers');
  const identifiers = [];
  const seen = new Set();
  for (const item of rawIdentifiers.slice(0, MAX_IDENTIFIERS)) {
    const type = String(item?.type ?? '');
    if (!IDENTIFIER_TYPES.includes(type)) { errors.push('identifier_type_invalid'); continue; }
    const canonical = canonicalIdentifier(type, item?.value);
    if (!canonical) { errors.push('identifier_value_invalid'); continue; }
    const key = `${type} ${canonical}`;
    if (seen.has(key)) continue;
    seen.add(key);
    identifiers.push({ type, value: canonical });
  }
  if (!identifiers.length) errors.push('identifier_required');

  const details = typeof input.details === 'string' ? input.details.trim() : '';
  if (details.length > MAX_DETAILS) errors.push('details_too_long');

  if (errors.length) return Object.freeze({ ok: false, errors: Object.freeze([...new Set(errors)]) });
  return Object.freeze({
    ok: true,
    request: Object.freeze({
      requestType,
      requesterEmail: requesterEmail.toLowerCase(),
      claimedIdentifiers: Object.freeze(identifiers),
      details: details || null,
    }),
  });
}

/** Validates a status transition before it reaches the database. */
export function planStatusTransition({ from, to, reviewer, reason } = {}) {
  if (!REQUEST_STATUSES.includes(to)) return Object.freeze({ ok: false, error: 'status_invalid' });
  if (typeof reviewer !== 'string' || !reviewer.trim()) return Object.freeze({ ok: false, error: 'reviewer_required' });
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  if (REASON_REQUIRED.has(to) && !trimmed) return Object.freeze({ ok: false, error: 'reason_required' });
  if (trimmed.length > MAX_DETAILS) return Object.freeze({ ok: false, error: 'reason_too_long' });
  const allowedFrom = REQUEST_STATUSES.filter((status) => STATUS_TRANSITIONS[status].includes(to));
  if (from !== undefined && !allowedFrom.includes(from)) return Object.freeze({ ok: false, error: 'transition_not_allowed' });
  return Object.freeze({ ok: true, to, allowedFrom: Object.freeze(allowedFrom), reviewer: reviewer.trim(), reason: trimmed || null, closes: STATUS_TRANSITIONS[to].length === 0 });
}

/**
 * Marks identifiers verified. Only identifiers the requester actually claimed
 * can be verified: a reviewer cannot widen a request to data it never asked
 * about.
 */
export function planIdentifierVerification({ claimed = [], verified = [], method, reviewer } = {}) {
  if (!VERIFICATION_METHODS.includes(method)) return Object.freeze({ ok: false, error: 'verification_method_invalid' });
  if (typeof reviewer !== 'string' || !reviewer.trim()) return Object.freeze({ ok: false, error: 'reviewer_required' });
  const claimedKeys = new Set(claimed.map((item) => `${item.type} ${item.value}`));
  const accepted = [];
  for (const item of verified) {
    const canonical = canonicalIdentifier(item?.type, item?.value);
    if (!canonical) return Object.freeze({ ok: false, error: 'identifier_value_invalid' });
    if (!claimedKeys.has(`${item.type} ${canonical}`)) return Object.freeze({ ok: false, error: 'identifier_not_claimed' });
    accepted.push({ type: item.type, value: canonical });
  }
  if (!accepted.length) return Object.freeze({ ok: false, error: 'identifier_required' });
  return Object.freeze({ ok: true, identifiers: Object.freeze(accepted), method, reviewer: reviewer.trim() });
}

/**
 * The part of the held data an access or portability response may contain.
 *
 * `records` is what the repository found for the verified identifiers:
 * `{ contactPoints, actors, platformIdentities, evidence }`.
 *
 * An actor reached through a verified phone may also be linked to contacts
 * that are *not* the requester's -- that is exactly what a wrong identity merge
 * looks like. Those contact values are withheld and counted instead, and
 * evidence detail (which can name other listings and accounts) is reduced to
 * its reason and state. Withholding is reported, never silent, so the
 * requester can dispute the merge.
 */
export function scopeSubjectData(request, records = {}) {
  const verified = new Set((request?.verifiedIdentifiers ?? []).map((item) => `${item.type} ${item.value}`));
  if (!verified.size) return Object.freeze({ ok: false, error: 'identity_verification_required' });

  const verifiedContactIds = new Set();
  const contactPoints = [];
  let withheldContacts = 0;
  for (const contact of records.contactPoints ?? []) {
    if (verified.has(`${contact.type} ${contact.canonicalValue}`)) {
      verifiedContactIds.add(Number(contact.id));
      contactPoints.push({
        type: contact.type,
        value: contact.canonicalValue,
        origin: contact.origin ?? null,
        sourceRef: contact.sourceRef ?? null,
        publiclyAccessible: contact.publiclyAccessible ?? null,
        firstSeenAt: contact.firstSeenAt ?? null,
        lastSeenAt: contact.lastSeenAt ?? null,
      });
    } else {
      withheldContacts += 1;
    }
  }

  // Only actors actually reached through a verified contact.
  const actors = (records.actors ?? []).filter((actor) => (actor.contactPointIds ?? []).some((id) => verifiedContactIds.has(Number(id))));
  const actorIds = new Set(actors.map((actor) => Number(actor.id)));

  const platformIdentities = (records.platformIdentities ?? [])
    .filter((identity) => actorIds.has(Number(identity.actorId)))
    .map((identity) => ({
      platform: identity.platform,
      username: identity.username ?? null,
      displayName: identity.displayName ?? null,
      firstObservedAt: identity.firstObservedAt ?? null,
      lastObservedAt: identity.lastObservedAt ?? null,
    }));

  // Profiling is personal data too (Article 15(1)(h)): the reasons are
  // disclosed; the detail, which describes other people's listings, is not.
  const evidence = (records.evidence ?? [])
    .filter((row) => actorIds.has(Number(row.actorId)))
    .map((row) => ({
      polarity: row.polarity,
      reasonCode: row.reasonCode,
      dimension: row.dimension,
      independentCount: row.independentCount,
      reviewState: row.reviewState,
      firstObservedAt: row.firstObservedAt ?? null,
      lastObservedAt: row.lastObservedAt ?? null,
    }));

  return Object.freeze({
    ok: true,
    data: Object.freeze({
      contactPoints: Object.freeze(contactPoints),
      actors: Object.freeze(actors.map((actor) => ({ roles: actor.roles ?? [], firstSeenAt: actor.firstSeenAt ?? null, lastSeenAt: actor.lastSeenAt ?? null }))),
      platformIdentities: Object.freeze(platformIdentities),
      evidence: Object.freeze(evidence),
    }),
    withheld: Object.freeze({
      contactPoints: withheldContacts,
      reason: withheldContacts ? 'linked_contacts_not_verified_as_requester' : null,
    }),
  });
}

/**
 * Article 20 applies only to data the subject *provided* under consent or a
 * contract. Data observed in public listings is processed under legitimate
 * interests and is not portable; the subscription account a person created
 * is.
 */
export function portabilityApplies(dataClass) {
  return dataClass === 'subscription_account';
}
