import { parseHousingSeller } from '@whiteslove/parsing-lexicon/housing-structured';

/**
 * Tells a cosmetic rename from a change of persona.
 *
 * §22 turns on this distinction. "Andrey" becoming "Andrey 🏠" is someone
 * decorating their profile; "Realtor Andrey" becoming "Owner Oleg" is a
 * different person or a different claimed role wearing the same account.
 * Counting the first as identity churn would flag ordinary users, which is the
 * false positive that makes a risk signal useless.
 *
 * Role detection reuses the lexicon's parseHousingSeller rather than defining a
 * second owner/agency vocabulary, so the seven supported languages come along.
 */

/** Decoration people add around a name without changing who they claim to be. */
const DECORATION = /[\p{Extended_Pictographic}\p{S}\p{P}\p{M}️‍]/gu;

/** Case, decoration and spacing folded away, leaving the claimed name. */
export function personaCore(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(DECORATION, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
}

/** owner | agency | null, from the lexicon's multilingual seller vocabulary. */
export function personaRole(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return parseHousingSeller(text).type;
}

/**
 * Compares two observed personas.
 *
 * - `none`     — nothing observable changed.
 * - `cosmetic` — the same claimed name with different decoration.
 * - `semantic` — a different name, or the same name claiming a different role.
 *
 * A role change is always semantic even when the human name is unchanged:
 * "Andrey (owner)" to "Andrey (realtor)" is the identity claim changing, which
 * is exactly what §22's owner_agent_role_switching is about.
 */
export function classifyPersonaChange(before, after) {
  const beforeText = String(before ?? '');
  const afterText = String(after ?? '');
  if (beforeText === afterText) return { kind: 'none', coreChanged: false, roleChanged: false };

  const coreChanged = personaCore(beforeText) !== personaCore(afterText);
  const beforeRole = personaRole(beforeText);
  const afterRole = personaRole(afterText);
  const roleChanged = beforeRole !== afterRole && (beforeRole !== null || afterRole !== null);

  if (coreChanged || roleChanged) {
    return { kind: 'semantic', coreChanged, roleChanged, fromRole: beforeRole, toRole: afterRole };
  }
  return { kind: 'cosmetic', coreChanged: false, roleChanged: false };
}

/**
 * Whether two identities may be treated as the same actor.
 *
 * §19's resolution order, strongest first. The rule that matters is the last
 * one: a display name alone never merges actors. Two people called "Andrey"
 * are two people, and merging them would attribute one's history to the other.
 */
export function identityMatchStrength(left, right) {
  if (!left || !right) return { merge: false, basis: 'insufficient' };
  if (left.platform && left.platform === right.platform && left.subjectId && left.subjectId === right.subjectId) {
    return { merge: true, basis: 'platform_subject_id', confidence: 1 };
  }
  if (left.verifiedContact && left.verifiedContact === right.verifiedContact) {
    return { merge: true, basis: 'verified_contact', confidence: 0.9 };
  }
  if (left.platform && left.platform === right.platform && left.username && left.username === right.username) {
    return { merge: true, basis: 'platform_username', confidence: 0.7 };
  }
  if (left.displayName && personaCore(left.displayName) === personaCore(right.displayName)) {
    // Deliberately not a merge.
    return { merge: false, basis: 'display_name_only', confidence: 0.1 };
  }
  return { merge: false, basis: 'no_shared_identifier' };
}

/**
 * Account age, stated honestly (§20).
 *
 * firstObservedAt is when *we* first saw the account, which says nothing about
 * when it was created. Presenting one as the other would manufacture evidence,
 * so an unknown creation date stays unknown.
 */
export function accountAgeFacts(identity) {
  const created = identity?.accountCreatedAt ?? null;
  return Object.freeze({
    accountCreatedAt: created,
    accountCreatedAtKnown: Boolean(created),
    firstObservedAt: identity?.firstObservedAt ?? null,
    registrationObservedAt: identity?.registrationObservedAt ?? null,
    // What a UI may safely say when the creation date is unknown.
    displayHint: created ? 'account_created_known' : 'account_created_unavailable',
  });
}
