import { classifyPersonaChange, personaCore } from './identity-change.js';

/**
 * Identity churn metrics and their reason codes (§22).
 *
 * Churn is evidence, never a verdict. A person may rebrand, marry, or fix a
 * typo; what these metrics describe is a pattern worth a human look, and every
 * consumer is expected to treat them that way.
 *
 * Only semantic changes count. Cosmetic edits -- adding an emoji, changing
 * case -- are excluded, because counting them would flag ordinary users and
 * drown the real signal.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const CHURN_REASONS = Object.freeze([
  'rapid_display_name_churn',
  'rapid_username_churn',
  'role_identity_rotation',
  'same_platform_id_multiple_personas',
  'owner_agent_role_switching',
  'contact_channel_identity_mismatch',
]);

/** Thresholds are conservative on purpose: a false accusation costs more than
 * a missed signal, and these feed a review queue rather than an action. */
export const CHURN_THRESHOLDS = Object.freeze({
  displayNameChanges7d: 3,
  usernameChanges7d: 2,
  roleChanges30d: 2,
  distinctPersonas30d: 3,
});

const timeOf = (value) => {
  if (!value) return null;
  const at = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(at) ? at : null;
};

/**
 * @param observations newest-last, each `{ observedAt, displayName, username,
 * claimedRole }`. The caller reads them from the observation table in
 * chronological order, which its index already provides.
 */
export function summarizeIdentityChurn(observations, options = {}) {
  const now = timeOf(options.now) ?? Date.now();
  const rows = (observations ?? [])
    .map((row) => ({ ...row, at: timeOf(row?.observedAt) }))
    .filter((row) => row.at !== null)
    .sort((a, b) => a.at - b.at);

  const changes = [];
  for (let i = 1; i < rows.length; i += 1) {
    const previous = rows[i - 1];
    const current = rows[i];
    const display = classifyPersonaChange(previous.displayName, current.displayName);
    const username = classifyPersonaChange(previous.username, current.username);
    changes.push({
      at: current.at,
      display,
      username,
      roleChanged: display.roleChanged
        || (previous.claimedRole ?? null) !== (current.claimedRole ?? null),
      fromRole: previous.claimedRole ?? display.fromRole ?? null,
      toRole: current.claimedRole ?? display.toRole ?? null,
    });
  }

  const within = (days) => (change) => now - change.at <= days * DAY_MS;
  const countWhere = (days, predicate) => changes.filter(within(days)).filter(predicate).length;

  const displayNameChanges7d = countWhere(7, (change) => change.display.kind === 'semantic');
  const displayNameChanges30d = countWhere(30, (change) => change.display.kind === 'semantic');
  const usernameChanges7d = countWhere(7, (change) => change.username.kind === 'semantic');
  const usernameChanges30d = countWhere(30, (change) => change.username.kind === 'semantic');
  const roleChanges30d = countWhere(30, (change) => change.roleChanged);

  const recent = rows.filter((row) => now - row.at <= 30 * DAY_MS);
  const distinctHumanNames30d = new Set(recent.map((row) => personaCore(row.displayName)).filter(Boolean)).size;
  const distinctUsernames30d = new Set(recent.map((row) => personaCore(row.username)).filter(Boolean)).size;

  const roleSequence = changes
    .filter(within(30))
    .filter((change) => change.roleChanged)
    .map((change) => `${change.fromRole ?? 'unknown'}->${change.toRole ?? 'unknown'}`);

  const reasons = [];
  if (displayNameChanges7d >= CHURN_THRESHOLDS.displayNameChanges7d) reasons.push('rapid_display_name_churn');
  if (usernameChanges7d >= CHURN_THRESHOLDS.usernameChanges7d) reasons.push('rapid_username_churn');
  if (roleChanges30d >= CHURN_THRESHOLDS.roleChanges30d) reasons.push('role_identity_rotation');
  if (distinctHumanNames30d >= CHURN_THRESHOLDS.distinctPersonas30d) reasons.push('same_platform_id_multiple_personas');
  // Switching between owner and agency is the specific pattern §23 calls out
  // for housing: claiming to be the owner on one listing and the agent on
  // another is not a rebrand.
  if (roleSequence.some((step) => step === 'owner->agency' || step === 'agency->owner')) reasons.push('owner_agent_role_switching');

  return Object.freeze({
    observationCount: rows.length,
    displayNameChanges7d,
    displayNameChanges30d,
    usernameChanges7d,
    usernameChanges30d,
    distinctHumanNames30d,
    distinctUsernames30d,
    roleChanges30d,
    roleSequence: Object.freeze(roleSequence),
    reasons: Object.freeze(reasons),
    // Says plainly what this is, so no consumer mistakes it for a conclusion.
    evidenceOnly: true,
  });
}

/**
 * Detects a contact claiming a different identity than the account that
 * published it -- the contact_channel_identity_mismatch reason.
 *
 * Only reported when both sides actually state a name; an absent name is not a
 * mismatch.
 */
export function detectContactIdentityMismatch({ accountDisplayName, contactClaimedName } = {}) {
  const account = personaCore(accountDisplayName);
  const claimed = personaCore(contactClaimedName);
  if (!account || !claimed) return { mismatch: false, reason: null };
  if (account === claimed) return { mismatch: false, reason: null };
  // One containing the other is a shortening ("Andrey" vs "Andrey Ivanov"),
  // not a different person.
  if (account.includes(claimed) || claimed.includes(account)) return { mismatch: false, reason: null };
  return { mismatch: true, reason: 'contact_channel_identity_mismatch' };
}
