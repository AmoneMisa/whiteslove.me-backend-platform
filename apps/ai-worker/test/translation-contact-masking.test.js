import test from 'node:test';
import assert from 'node:assert/strict';

import { maskContacts } from '../src/util/privacy.js';

process.env.FREE_TRANSLATOR_ENABLED = 'true';
process.env.FREE_TRANSLATOR_MAX_BYTES = '500';
const { extract } = await import('../src/services/extract.js');

test('contacts are replaced by numbered placeholders and restored', () => {
  const mask = maskContacts('Звоните +998 90 123 45 67 или пишите @owner_flat, mail dev@example.com, https://t.me/owner_flat');
  assert.equal(mask.count, 4);
  assert.doesNotMatch(mask.text, /998|owner_flat|dev@example|t\.me/u, 'nothing identifying leaves the worker');
  assert.match(mask.text, /\[\[1\]\]/u);
  const translated = mask.text.replace('Звоните', 'Call').replace('или пишите', 'or write');
  assert.equal(
    mask.restore(translated),
    'Call +998 90 123 45 67 or write @owner_flat, mail dev@example.com, https://t.me/owner_flat',
  );
});

test('placeholders with spaces added by a translator are still restored', () => {
  const mask = maskContacts('Tel +998901234567');
  assert.equal(mask.restore('Phone [ [ 1 ] ]'), 'Phone +998901234567');
});

test('a contact whose placeholder the translator dropped is appended, never lost', () => {
  // Handles are masked before phones, so @owner_flat is [[1]] and the phone [[2]].
  const mask = maskContacts('Tel +998901234567, @owner_flat');
  assert.equal(mask.restore('Phone [[2]]'), 'Phone +998901234567\n@owner_flat');
});

test('text without contacts is untouched and unknown placeholders are left alone', () => {
  const mask = maskContacts('3 rooms near the metro');
  assert.equal(mask.count, 0);
  assert.equal(mask.text, '3 rooms near the metro');
  assert.equal(maskContacts('Tel +998901234567').restore('see [[9]]'), 'see [[9]]\n+998901234567');
});

test('the free translator receives masked text and the reply gets contacts back', async () => {
  const originalFetch = global.fetch;
  let sentText = '';
  global.fetch = async (url) => {
    sentText = new URL(String(url)).searchParams.get('q') ?? '';
    return new Response(JSON.stringify({ responseStatus: 200, responseData: { translatedText: 'Позвоните [[1]], квартира свободна' } }));
  };
  try {
    const result = await extract('translation', { text: 'アパート空いています 電話 +998901234567', knownFacts: { targetLanguage: 'Russian' } });
    assert.ok(sentText, 'the free translator was called');
    assert.doesNotMatch(sentText, /998901234567/u, 'the phone number never reaches the translator URL');
    assert.match(sentText, /\[\[1\]\]/u);
    assert.equal(result.data.translatedText, 'Позвоните +998901234567, квартира свободна');
  } finally {
    global.fetch = originalFetch;
  }
});

test('the LLM prompt tells providers to keep placeholders', async () => {
  const { TRANSLATION_SYSTEM } = await import('../src/prompts/translation.js');
  assert.match(TRANSLATION_SYSTEM, /Keep placeholder tokens such as \[\[1\]\] exactly/u);
});
