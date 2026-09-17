import { checkLegalReadiness, formatReadinessReport } from './privacy/legal-readiness.js';

// Deployment check for legal identity and open legal-review decisions (§56).
//
// Prints variable names and purposes only, never their values. Exits non-zero
// when IDENTITY_FEATURES_ENABLED=true and anything required for identity or
// risk features is missing, so such a deployment cannot go out on blank or
// invented legal facts. Without identity features it reports and exits 0:
// today's listing aggregation predates this check and must keep deploying.

const identityFeaturesEnabled = String(process.env.IDENTITY_FEATURES_ENABLED ?? '').trim() === 'true';
const report = checkLegalReadiness(process.env, { identityFeaturesEnabled });

console.log(formatReadinessReport(report));

if (identityFeaturesEnabled && !report.ready) {
  console.error('legal readiness: identity/risk features are enabled but legal requirements are unmet');
  process.exitCode = 1;
}
