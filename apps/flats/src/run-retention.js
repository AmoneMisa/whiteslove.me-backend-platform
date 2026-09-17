import { pool } from './infrastructure/database/pool.js';
import { runRetention, RETENTION_POLICY_VERSION } from './privacy/retention-policy.js';

// Applies the retention policy (§53). Refuses unless
// PRIVACY_RETENTION_POLICY_APPROVED equals the policy version, so it does
// nothing until the operator has approved this exact draft.

try {
  const result = await runRetention(pool);
  if (!result.ok) {
    console.log(`retention: not run (${result.error}); approve version ${RETENTION_POLICY_VERSION} to enable`);
  } else {
    for (const entry of result.report) {
      console.log(`retention: ${entry.dataClass} deleted=${entry.deleted} batches=${entry.batches}${entry.exhausted ? ' (budget exhausted, resumes next run)' : ''}`);
    }
  }
} catch (error) {
  // Code only: a failed DELETE can echo row values in its detail.
  console.error(`retention: failed (${error?.code ?? error?.name ?? 'error'})`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
