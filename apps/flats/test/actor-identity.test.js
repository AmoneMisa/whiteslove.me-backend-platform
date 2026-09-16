import test from 'node:test';
import assert from 'node:assert/strict';

import { contactPointsFromListing, observedRoleForListing } from '../src/listing/contact-points.js';
import {
  upsertContactPoints, linkActorContactPoints, recordActorRoles,
  findActorsByContactPoints, createActors, __actorIdentityTest,
} from '../src/infrastructure/database/actorIdentityRepository.js';

/** Records what the repository would send, so the batch shape is testable
 * without a database. */
function fakeClient(rows = []) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      return { rows, rowCount: rows.length };
    },
  };
}

const observedAt = new Date('2026-03-01T00:00:00.000Z');

// --- extraction -------------------------------------------------------------

test('a valid phone in listing text becomes an E.164 contact point', () => {
  const [contact] = contactPointsFromListing(
    { title: 'Сдам квартиру', description: 'Тел: +998 90 123 45 67', country: 'UZ' },
    { observedAt },
  );
  assert.equal(contact.type, 'phone');
  assert.equal(contact.canonicalValue, '+998901234567', 'stored canonical, so the unique index is usable');
  assert.equal(contact.availability, 'declared', 'published is not verified');
  assert.equal(contact.publiclyAccessible, true);
  assert.equal(contact.origin, 'listing_text');
});

test('numbers that are not contacts are not stored as contacts', () => {
  // Floor counts, areas and cadastral numbers have contact-like digit counts.
  const found = contactPointsFromListing(
    { title: '3/9, 42 м²', description: 'Кадастр 10:09:0123456:789, цена 5000000', country: 'UZ' },
    { observedAt },
  );
  assert.deepEqual(found.filter((item) => item.type === 'phone'), [], 'only valid numbers are kept');
});

test('a telegram handle is lowercased and stripped of its @', () => {
  const [contact] = contactPointsFromListing({ title: 'x', description: 'Пишите @RealtorAndrey', country: 'UZ' }, { observedAt });
  assert.equal(contact.type, 'telegram');
  assert.equal(contact.canonicalValue, 'realtorandrey');
  assert.equal(contact.rawValue, '@RealtorAndrey');
});

test('the same contact written twice yields one contact point', () => {
  const found = contactPointsFromListing(
    { title: '+998901234567', description: 'звоните +998 90 123 45 67', country: 'UZ' },
    { observedAt },
  );
  assert.equal(found.filter((item) => item.type === 'phone').length, 1);
});

test('a contact already normalised onto the listing is picked up', () => {
  const found = contactPointsFromListing({ title: 'x', description: 'y', contact: '+998901234567', country: 'UZ' }, { observedAt });
  assert.equal(found.length, 1, 'promoting stored data does not require re-parsing the text');
  assert.equal(found[0].canonicalValue, '+998901234567');
});

test('a listing with no contact yields nothing', () => {
  assert.deepEqual(contactPointsFromListing({ title: 'Квартира', description: 'Хорошая', country: 'UZ' }), []);
  assert.deepEqual(contactPointsFromListing(null), []);
});

test('the observed role is only as specific as the data supports', () => {
  assert.equal(observedRoleForListing({ by_agency: true }), 'agency');
  assert.equal(observedRoleForListing({ byAgency: false }), 'unknown', 'no role is guessed from free text');
  assert.equal(observedRoleForListing({}), 'unknown');
});

// --- batch shape ------------------------------------------------------------

test('a batch of contacts is one statement, not one per contact', async () => {
  const client = fakeClient([{ id: 1, type: 'phone', canonical_value: '+998901234567' }]);
  await upsertContactPoints([
    { type: 'phone', canonicalValue: '+998901234567', observedAt },
    { type: 'telegram', canonicalValue: 'andrey', observedAt },
    { type: 'phone', canonicalValue: '+998901112233', observedAt },
  ], client);
  assert.equal(client.calls.length, 1, 'three contacts, one round trip');
  assert.equal(client.calls[0].params[0].length, 3, 'passed as arrays for unnest');
});

test('a contact repeated inside one batch is deduplicated before ON CONFLICT', async () => {
  // Postgres raises "cannot affect row a second time" if one statement touches
  // the same conflict key twice, which a page listing an agency phone twice
  // would otherwise do.
  const client = fakeClient();
  await upsertContactPoints([
    { type: 'phone', canonicalValue: '+998901234567', observedAt },
    { type: 'phone', canonicalValue: '+998901234567', observedAt: new Date('2026-03-02T00:00:00.000Z') },
  ], client);
  assert.equal(client.calls[0].params[0].length, 1);
  assert.equal(client.calls[0].params[7][0].toISOString(), '2026-03-02T00:00:00.000Z', 'the newest sighting wins');
});

test('the upsert returns ids even for rows whose update was throttled', async () => {
  const client = fakeClient();
  await upsertContactPoints([{ type: 'phone', canonicalValue: '+998901234567', observedAt }], client);
  const sql = client.calls[0].text;
  assert.match(sql, /ON CONFLICT \(type, canonical_value\) DO UPDATE/);
  assert.match(sql, /WHERE platform\.contact_points\.last_seen_at < EXCLUDED\.last_seen_at/, 'no-op writes are skipped');
  assert.match(sql, /UNION ALL/, 'skipped rows still have their id returned');
});

test('unknown contact types and empty values never reach the database', async () => {
  const client = fakeClient();
  const ids = await upsertContactPoints([
    { type: 'carrier-pigeon', canonicalValue: 'x' },
    { type: 'phone', canonicalValue: '' },
    { type: 'phone' },
    null,
  ], client);
  assert.equal(client.calls.length, 0, 'nothing valid means no query at all');
  assert.equal(ids.size, 0);
});

test('empty input short-circuits every repository call', async () => {
  const client = fakeClient();
  assert.equal((await upsertContactPoints([], client)).size, 0);
  assert.equal((await findActorsByContactPoints([], client)).size, 0);
  assert.deepEqual(await createActors([], client), []);
  assert.equal(await linkActorContactPoints([], client), 0);
  assert.equal(await recordActorRoles([], client), 0);
  assert.equal(client.calls.length, 0);
});

test('reverse contact lookup is a single ANY query, not one per contact', async () => {
  const client = fakeClient([{ contact_point_id: 7, actor_id: 3 }, { contact_point_id: 7, actor_id: 4 }]);
  const byContact = await findActorsByContactPoints([7, 7, 8], client);
  assert.equal(client.calls.length, 1);
  assert.match(client.calls[0].text, /contact_point_id = ANY/);
  assert.deepEqual(client.calls[0].params[0], [7, 8], 'duplicate ids are collapsed');
  assert.deepEqual(byContact.get(7), [3, 4]);
});

test('links and roles are deduplicated and throttled the same way', async () => {
  const client = fakeClient();
  await linkActorContactPoints([
    { actorId: 1, contactPointId: 2, observedAt },
    { actorId: 1, contactPointId: 2, observedAt },
  ], client);
  assert.equal(client.calls[0].params[0].length, 1);
  assert.match(client.calls[0].text, /WHERE platform\.actor_contact_points\.last_seen_at </);

  const roleClient = fakeClient();
  await recordActorRoles([
    { actorId: 1, role: 'agency', observedAt },
    { actorId: 1, role: 'agency', observedAt },
    { actorId: 1, role: 'not-a-role', observedAt },
  ], roleClient);
  assert.equal(roleClient.calls[0].params[0].length, 1);
  assert.match(roleClient.calls[0].text, /ON CONFLICT \(actor_id, role\) DO UPDATE/);
});

test('roles accumulate rather than replace', async () => {
  const client = fakeClient();
  await recordActorRoles([{ actorId: 1, role: 'owner', observedAt }], client);
  const sql = client.calls[0].text;
  assert.doesNotMatch(sql, /SET role/, 'an actor seen as owner and later as agent has been both');
  assert.match(sql, /observation_count = platform\.actor_roles\.observation_count \+ 1/);
});

test('the dedupe helper keeps the first record and the newest sighting', () => {
  const { dedupe } = __actorIdentityTest;
  const merged = dedupe([
    { key: 'a', value: 1, observedAt: new Date('2026-01-01') },
    { key: 'a', value: 2, observedAt: new Date('2026-02-01') },
    { key: 'b', value: 3 },
  ], (item) => item.key);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].value, 1);
  assert.equal(merged[0].observedAt.toISOString(), new Date('2026-02-01').toISOString());
});
