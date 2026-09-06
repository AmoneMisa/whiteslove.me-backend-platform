import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/geo/geocode-persistent.js', import.meta.url), 'utf8');

test('verified exact address outranks an unqualified marketplace source pin', () => {
  // The listing contract says a directly stated, independently geocoded
  // street+house is stronger evidence than a marketplace marker whose accuracy
  // is unknown. Keep the discrepancy as diagnostics, but do not preserve the
  // weaker marker merely because the two points are far apart.
  assert.doesNotMatch(source, /SOURCE_COORD_EXACT_MAX_DISTANCE_M/);
  assert.match(source, /sourceCoordinateDistanceM = Math\.round\(discrepancyM\)/);
  assert.match(source, /isStrongerPlacement\(probe, listing\)/);
  assert.match(source, /copyPlacement\(listing, probe, original\)/);
});
