import test from 'node:test';
import assert from 'node:assert/strict';

import { isAgencyLikeListing } from '../src/listing-semantics.js';
import { confirmRepeatedOlxGenericError } from '../src/availability.js';

test('explicit commission makes a listing agency-like even when source account is not business', () => {
  assert.equal(isAgencyLikeListing({ byAgency: false, commission: true }), true);
  assert.equal(isAgencyLikeListing({ byAgency: false, commissionPercent: 50 }), true);
  assert.equal(isAgencyLikeListing({ byAgency: false, commission: false, commissionPercent: 0 }), false);
});

test('one OLX generic error remains unknown', () => {
  const result = confirmRepeatedOlxGenericError(
    { availability_status: 'active', availability_reason: 'offer_page', availability_checked_at: new Date() },
    { status: 'unknown', reason: 'generic_error_page' },
  );
  assert.deepEqual(result, { status: 'unknown', reason: 'generic_error_page' });
});

test('same OLX generic error on the next stale check becomes inactive', () => {
  const result = confirmRepeatedOlxGenericError(
    {
      availability_status: 'unknown',
      availability_reason: 'generic_error_page',
      availability_checked_at: new Date(Date.now() - 20 * 60_000),
    },
    { status: 'unknown', reason: 'generic_error_page' },
  );
  assert.deepEqual(result, { status: 'inactive', reason: 'repeated_generic_error_page' });
});
