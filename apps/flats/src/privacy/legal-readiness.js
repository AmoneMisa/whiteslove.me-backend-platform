/**
 * Legal identity and readiness configuration (§43, §56).
 *
 * Nothing here holds a value. The operator's identity comes from verified
 * configuration, and this module only reports what is missing, so that a
 * deployment with identity or risk features enabled fails its check instead
 * of publishing legal pages with invented or blank facts.
 *
 * The operator is currently a natural person. For a natural person, company
 * registration number, registered office and tax id do not exist, and asking
 * for them would push someone into inventing them; they are required only if
 * LEGAL_OPERATOR_TYPE is changed to `organization`.
 */

export const OPERATOR_TYPES = Object.freeze(['natural_person', 'organization']);

/** Required for any public deployment: Articles 13(1)(a) and 14(1)(a). */
const ALWAYS_REQUIRED = Object.freeze([
  ['PRIVACY_CONTROLLER_NAME', 'controller identity (Art 13(1)(a), 14(1)(a))'],
  ['PRIVACY_CONTACT_EMAIL', 'contact for privacy requests (Art 13(1)(a), 14(1)(a))'],
  ['LEGAL_OPERATOR_TYPE', 'whether the operator is a natural person or an organization'],
  ['LEGAL_GOVERNING_LAW', 'governing law for the Terms of Use'],
]);

const ORGANIZATION_REQUIRED = Object.freeze([
  ['LEGAL_REGISTERED_NAME', 'registered legal name'],
  ['LEGAL_REGISTERED_ADDRESS', 'registered address'],
  ['LEGAL_REGISTRATION_NUMBER', 'registration number'],
]);

/**
 * Items that configuration cannot settle: they need a decision by the
 * operator, usually with legal advice. Reported as open until the matching
 * variable records the decision.
 */
const REVIEW_DECISIONS = Object.freeze([
  ['LEGAL_DPO_ASSESSMENT', ['not_required', 'appointed'], 'Article 37: whether large-scale systematic monitoring requires a Data Protection Officer'],
  ['LEGAL_ARTICLE22_ASSESSMENT', ['no_significant_effects', 'safeguards_in_place'], 'Article 22: whether any automated decision has legal or similarly significant effects'],
  ['LEGAL_ARTICLE27_ASSESSMENT', ['not_applicable', 'representative_appointed'], 'Article 27: whether an EU representative is needed for a controller outside the EU'],
  ['PRIVACY_DPIA_STATUS', ['approved'], 'Article 35: the DPIA draft must be reviewed and approved before identity/risk features go live'],
  ['PRIVACY_LIA_STATUS', ['approved'], 'Article 6(1)(f): the legitimate-interests assessment must be reviewed and approved'],
  ['PRIVACY_ARTICLE14_APPROACH', ['notices_sent', 'exemption_documented'], 'Article 14: how people whose data comes from public listings are informed'],
]);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/**
 * Readiness report.
 *
 * `identityFeaturesEnabled` is whether actor identity, risk evidence or
 * integrity states are exposed. Pages that only aggregate listings need the
 * identity fields; identity and risk features additionally need every review
 * decision recorded.
 */
export function checkLegalReadiness(env = process.env, { identityFeaturesEnabled = false } = {}) {
  const value = (name) => String(env[name] ?? '').trim();
  const missing = [];
  const invalid = [];

  for (const [name, purpose] of ALWAYS_REQUIRED) {
    if (!value(name)) missing.push({ name, purpose });
  }
  if (value('PRIVACY_CONTACT_EMAIL') && !EMAIL.test(value('PRIVACY_CONTACT_EMAIL'))) {
    invalid.push({ name: 'PRIVACY_CONTACT_EMAIL', reason: 'not an email address' });
  }
  const operatorType = value('LEGAL_OPERATOR_TYPE');
  if (operatorType && !OPERATOR_TYPES.includes(operatorType)) {
    invalid.push({ name: 'LEGAL_OPERATOR_TYPE', reason: `must be one of ${OPERATOR_TYPES.join(', ')}` });
  }
  if (operatorType === 'organization') {
    for (const [name, purpose] of ORGANIZATION_REQUIRED) {
      if (!value(name)) missing.push({ name, purpose });
    }
  }

  const openReviewItems = [];
  for (const [name, accepted, question] of REVIEW_DECISIONS) {
    const decision = value(name);
    if (!accepted.includes(decision)) openReviewItems.push({ name, question, accepted });
  }

  const publicPagesReady = missing.length === 0 && invalid.length === 0;
  return Object.freeze({
    publicPagesReady,
    identityFeaturesReady: publicPagesReady && openReviewItems.length === 0,
    ready: identityFeaturesEnabled ? publicPagesReady && openReviewItems.length === 0 : publicPagesReady,
    missing: Object.freeze(missing),
    invalid: Object.freeze(invalid),
    openReviewItems: Object.freeze(openReviewItems),
  });
}

/** Human-readable report without any configured values: names and purposes only. */
export function formatReadinessReport(report) {
  const lines = [];
  lines.push(`public legal pages: ${report.publicPagesReady ? 'ready' : 'NOT READY'}`);
  lines.push(`identity/risk features: ${report.identityFeaturesReady ? 'ready' : 'NOT READY'}`);
  for (const item of report.missing) lines.push(`  missing ${item.name}: ${item.purpose}`);
  for (const item of report.invalid) lines.push(`  invalid ${item.name}: ${item.reason}`);
  for (const item of report.openReviewItems) lines.push(`  open review ${item.name}: ${item.question} (record one of: ${item.accepted.join(', ')})`);
  return lines.join('\n');
}
