// One policy owns both the worker's due-row selection and the verifier's cache.
// If these values drift, the worker can repeatedly select rows that the verifier
// still considers fresh, starving genuinely due listings from the bounded batch.
// A confirmed-active advert is authoritative for one hour. All entry points,
// including a direct popup open, must reuse it instead of touching the source.
export const ACTIVE_AVAILABILITY_TTL_MS = 60 * 60_000;

export const UNKNOWN_AVAILABILITY_TTL_MS = Math.max(
  30_000,
  Number(process.env.LISTING_AVAILABILITY_UNKNOWN_TTL_MS) || 10 * 60_000,
);
