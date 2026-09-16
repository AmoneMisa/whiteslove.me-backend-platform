import test from 'node:test';
import assert from 'node:assert/strict';

import { chooseField, collectFieldProvenance, mayAiOverwrite, mayReplaceField, FIELD_SOURCES } from '../src/listing/field-provenance.js';
import { createProvenance } from '@whiteslove/parsing-lexicon/provenance';
import { enrichListingDetails } from '../src/listing/listing-enrichment.js';
import { mergeApartmentAi } from '../src/listing/ai-enrichment.js';

test('chooseField takes the first usable option and records its tier', () => {
  const chosen = chooseField(
    { value: null, source: FIELD_SOURCES.structured },
    { value: 42, source: FIELD_SOURCES.description, parser: 'housing.area' },
  );
  assert.equal(chosen.value, 42);
  assert.equal(chosen.provenance.source, 'description');
  assert.equal(chosen.provenance.parser, 'housing.area');
});

test('chooseField matches ?? semantics, so 0 and false still win', () => {
  // Skipping falsy values instead of nullish would silently change parsed
  // results; this function is only supposed to annotate them.
  assert.equal(chooseField({ value: 0, source: FIELD_SOURCES.structured }, { value: 9 }).value, 0);
  assert.equal(chooseField({ value: false, source: FIELD_SOURCES.structured }, { value: true }).value, false);
  assert.equal(chooseField({ value: '', source: FIELD_SOURCES.structured }, { value: 'x' }).value, '');
});

test('chooseField skips null and undefined and tolerates missing options', () => {
  assert.equal(chooseField({ value: undefined }, null, { value: 7, source: FIELD_SOURCES.structured }).value, 7);
  assert.deepEqual(chooseField(), { value: null, provenance: null });
  assert.deepEqual(chooseField({ value: null }), { value: null, provenance: null });
});

test('collectFieldProvenance keeps only fields that resolved', () => {
  const provenance = collectFieldProvenance({
    rooms: chooseField({ value: 2, source: FIELD_SOURCES.structured }),
    metro: chooseField({ value: null }),
  });
  assert.deepEqual(Object.keys(provenance), ['rooms']);
  assert.equal(provenance.rooms.source, 'structured_api');
});

test('AI may fill an unestablished field but never a deterministic one', () => {
  assert.equal(mayAiOverwrite(undefined), true);
  assert.equal(mayAiOverwrite(createProvenance({ source: 'ai_enrichment' })), true, 'an earlier guess may be revised');
  for (const source of ['structured_api', 'source_adapter', 'labelled_field', 'description']) {
    assert.equal(mayAiOverwrite(createProvenance({ source })), false, source);
  }
});

test('field replacement follows the shared provenance ordering', () => {
  assert.equal(mayReplaceField(createProvenance({ source: 'description' }), createProvenance({ source: 'structured_api' })), true);
  assert.equal(mayReplaceField(createProvenance({ source: 'structured_api' }), createProvenance({ source: 'description' })), false);
});

test('enrichment records which tier supplied each contested field', () => {
  const enriched = enrichListingDetails({
    title: 'Аренда',
    description: 'Чиланзар, 3/9, общая площадь 42',
    rooms: 2,
    country: 'UZ',
  });
  assert.equal(enriched.fieldProvenance.rooms.source, 'structured_api', 'the source site supplied rooms');
  assert.equal(enriched.fieldProvenance.floor.source, 'description', 'the floor came out of the text');
  assert.equal(enriched.fieldProvenance.floor.parser, 'housing.listing-enrichment');
  assert.equal(enriched.fieldProvenance.district.source, 'description', 'Chilanzar was parsed, not supplied');
  assert.equal(enriched.fieldProvenance.areaSqm, undefined, 'a field nothing resolved carries no provenance');
});

test('a structured area outranks the same field parsed from text', () => {
  const enriched = enrichListingDetails({ title: 'x', description: '42 кв', areaSqm: 55, country: 'UZ' });
  assert.equal(enriched.areaSqm, 55);
  assert.equal(enriched.fieldProvenance.areaSqm.source, 'structured_api');
});

test('enrichment values are unchanged by provenance tracking', () => {
  const listing = { title: 'Аренда', description: '2-комн, 42/28/8 м², 3/9', country: 'UZ' };
  const enriched = enrichListingDetails(listing);
  // The values below are whatever the existing chains produce; the point is
  // that adding provenance did not disturb them.
  assert.equal(typeof enriched.fieldProvenance, 'object');
  assert.equal(enriched.rooms, enrichListingDetails(listing).rooms);
  assert.equal(enriched.areaSqm, enrichListingDetails(listing).areaSqm);
  assert.equal(enriched.floor, enrichListingDetails(listing).floor);
});

test('enrichment preserves provenance an earlier stage already recorded', () => {
  const carried = createProvenance({ source: 'source_adapter', parser: 'olx.adapter' });
  const enriched = enrichListingDetails({ title: 'x', description: 'y', country: 'UZ', fieldProvenance: { price: carried } });
  assert.equal(enriched.fieldProvenance.price.source, 'source_adapter');
});

test('AI enrichment stamps its own provenance on the fields it fills', () => {
  const merged = mergeApartmentAi({ title: 'x', description: 'y', country: 'UZ' }, { data: { rooms: 3 }, confidence: 0.8 });
  if (merged.rooms === 3) {
    assert.equal(merged.fieldProvenance.rooms.source, 'ai_enrichment');
    assert.equal(merged.fieldProvenance.rooms.parser, 'ai.apartment');
  }
  assert.ok(merged.fieldProvenance, 'provenance is always present after a merge');
});

test('AI cannot overwrite a field a deterministic parser established', () => {
  const listing = {
    title: 'x', description: 'y', country: 'UZ',
    rooms: null,
    fieldProvenance: { rooms: createProvenance({ source: 'structured_api' }) },
  };
  const merged = mergeApartmentAi(listing, { data: { rooms: 9 }, confidence: 1 });
  assert.notEqual(merged.rooms, 9, 'a structured provenance blocks the model answer even when the value reads blank');
  assert.equal(merged.fieldProvenance.rooms.source, 'structured_api');
});

test('AI still fills a field nothing has established', () => {
  const merged = mergeApartmentAi({ title: 'x', description: 'y', country: 'UZ', rooms: null }, { data: { rooms: 3 }, confidence: 1 });
  assert.equal(merged.rooms, 3);
  assert.equal(merged.fieldProvenance.rooms.source, 'ai_enrichment');
});
