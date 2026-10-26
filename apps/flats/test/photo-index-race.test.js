import test from 'node:test';
import assert from 'node:assert/strict';
import {__photoAntifakeTest, isPhotoAnalysisComplete, isPropertyClusterMatch, PHOTO_ANALYSIS_VERSION} from '../src/listing/photo-antifake.js';

test('concurrent galleries publish all four identical images before looking for each other', async () => {
  const indexed = [];
  let writes = 0, release;
  const published = new Promise(resolve => {release = resolve;});
  const deps = {
    hashImage: async url => ({exactHash: url.split('/').at(-1), perceptualHash: 'e070305071f090b8'}),
    isChrome: async () => false,
    storeHash: async (listing, identity, url, hashes) => {
      indexed.push({hash: hashes.exactHash, source: identity.source, country: identity.country,
        source_id: identity.sourceId, photo_url: url, ...listing});
      writes++;
      // Force both listings to finish publishing at the same time. A lookup
      // before insert would deadlock this barrier and/or observe an empty index.
      if (writes === 8) release();
    },
    findExact: async (hash, identity) => {
      // The first lookup MUST follow this listing's four committed inserts.
      assert.equal(indexed.filter(row => row.source_id === identity.sourceId).length, 4);
      await published;
      return indexed.filter(row => row.hash === hash && row.source_id !== identity.sourceId)
        .map(row => ({row, matchType: 'exact', perceptualDistance: 0}));
    },
    findPerceptual: async () => [],
  };
  const listing = id => ({id, source: 'olx', country: 'UZ', city: 'Tashkent', rooms: 3,
    areaSqm: id === 'a' ? 69 : 68, price: 4776600, currency: 'UZS'});
  const images = id => Array.from({length: 4}, (_, i) => `https://photos.example/${id}/${i}`);
  const [a, b] = await Promise.all([
    __photoAntifakeTest.indexPhotoGallery(listing('a'), images('a'), deps),
    __photoAntifakeTest.indexPhotoGallery(listing('b'), images('b'), deps),
  ]);
  assert.equal(a.matches.length, 4);
  assert.equal(b.matches.length, 4);
  assert.ok(a.matches.every(match => match.matchType === 'exact'));
  for (const result of [a, b]) {
    const [group] = __photoAntifakeTest.groupMatches(result.matches);
    assert.equal(group.exactPhotoCount, 4);
    assert.equal(isPropertyClusterMatch(group), true);
  }
});

test('index writes and candidate lookup failures reject instead of becoming completed/no-match results', async () => {
  const deps = {hashImage: async () => ({exactHash: 'hash'}), isChrome: async () => false,
    storeHash: async () => {}, findExact: async () => [], findPerceptual: async () => []};
  for (const operation of ['storeHash', 'findExact', 'findPerceptual', 'isChrome']) {
    await assert.rejects(__photoAntifakeTest.indexPhotoGallery({id: 'a', source: 'olx', country: 'UZ'},
      ['https://photos.example/a'], {...deps, [operation]: async () => {throw new Error('database unavailable');}}), /database unavailable/);
  }
});

test('legacy empty results are rechecked by the existing scheduler even if photo URLs have not changed', () => {
  const old = {status: 'completed', fingerprint: 'same-gallery', matches: []};
  assert.equal(isPhotoAnalysisComplete(old, 'same-gallery'), false);
  const current = {...old, policyVersion: PHOTO_ANALYSIS_VERSION};
  assert.equal(isPhotoAnalysisComplete(current, 'same-gallery'), true);
  assert.equal(isPhotoAnalysisComplete(current, 'new-gallery'), false);
  assert.equal(isPhotoAnalysisComplete({...current, status: 'pending'}, 'same-gallery'), false);
});
