import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { attachContactActions, contactPointsForPublicListing } from '../src/listing/listing-contact-actions.js';

const hrefs = (listing) => (listing.contactActions ?? []).map((item) => item.href).filter(Boolean);

test('a stored phone becomes call and message buttons', () => {
  const listing = attachContactActions({ id: '1', contact: '+998901234567', description: 'no number in text' });
  assert.ok(hrefs(listing).includes('tel:+998901234567'));
  assert.ok(hrefs(listing).includes('https://wa.me/998901234567'));
  const whatsapp = listing.contactActions.find((item) => item.channel === 'whatsapp');
  assert.equal(whatsapp.availability, 'linkable', 'a WhatsApp account is not claimed from a phone number');
  assert.equal(whatsapp.derivedFromPhone, true);
});

test('a stored Telegram username becomes a profile link', () => {
  const listing = attachContactActions({ id: '2', contact: '@Owner_Flat' });
  assert.ok(hrefs(listing).includes('https://t.me/owner_flat'));
});

test('the stored contact is used without re-parsing the text', () => {
  const points = contactPointsForPublicListing({ contact: '+998901234567', description: 'call +998 91 111 11 11' });
  assert.deepEqual(points.map((point) => point.canonicalValue), ['+998901234567']);
});

test('without a stored contact the text is parsed', () => {
  const listing = attachContactActions({ id: '3', country: 'UZ', description: 'Звоните +998 90 123 45 67' });
  assert.ok(hrefs(listing).includes('tel:+998901234567'));
});

test('a listing without any contact is returned unchanged', () => {
  const listing = { id: '4', description: '3 rooms, 65 m2, 450$' };
  assert.equal(attachContactActions(listing), listing);
  assert.equal(attachContactActions(null), null);
});

test('a malformed stored contact never becomes a link', () => {
  const listing = attachContactActions({ id: '5', contact: 'javascript:alert(1)' });
  assert.ok(hrefs(listing).every((href) => /^(tel:|mailto:|https:|tg:|viber:)/u.test(href)));
});

test('feed and single-listing responses both carry contact buttons', async () => {
  const routes = await readFile(new URL('../src/routes/listing-routes.js', import.meta.url), 'utf8');
  const detail = await readFile(new URL('../src/routes/listing-public.js', import.meta.url), 'utf8');
  assert.match(routes, /listings = listings\.map\(attachContactActions\)/u);
  assert.match(detail, /attachListingLines\(\[attachContactActions\(prepared\)\]/u);
});
