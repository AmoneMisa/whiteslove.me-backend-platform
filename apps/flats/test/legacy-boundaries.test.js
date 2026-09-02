import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));

function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function relative(file) {
  return path.relative(srcRoot, file).replaceAll('\\', '/');
}

function consumersOf(pattern, excluded = []) {
  const consumers = [];
  for (const file of jsFiles(srcRoot)) {
    if (excluded.includes(relative(file))) continue;
    const source = readFileSync(file, 'utf8');
    if (pattern.test(source)) consumers.push(relative(file));
  }
  return consumers;
}

test('workforce hiring routes and persistence stay outside the flats service', () => {
  assert.deepEqual(consumersOf(/hiring-(?:routes|db)\.js/), []);
  assert.throws(() => readFileSync(path.join(srcRoot, 'hiring-routes.js'), 'utf8'), {code: 'ENOENT'});
  assert.throws(() => readFileSync(path.join(srcRoot, 'hiring-db.js'), 'utf8'), {code: 'ENOENT'});
});

test('retired legacy scraper registry stays absent from runtime imports', () => {
  assert.deepEqual(consumersOf(/scrapers\/index\.js/), []);
});

test('HTTP route modules never import custom scraper execution helpers', () => {
  for (const name of ['listing-routes.js', 'listing-item-routes.js', 'app.js', 'server.js']) {
    const source = readFileSync(path.join(srcRoot, name), 'utf8');
    assert.doesNotMatch(source, /scrapers\/custom\.js/, `${name} must not execute custom fetches`);
    assert.doesNotMatch(source, /\bvalidateSource\b/, `${name} must use the queue adapter`);
    assert.doesNotMatch(source, /\bscrapeCustom\b/, `${name} must use the queue adapter`);
  }
});

test('custom scraper exposes only the worker-facing fetch operation', () => {
  const source = readFileSync(path.join(srcRoot, 'scrapers/custom.js'), 'utf8');
  assert.match(source, /export async function scrapeCustomUrl\(/);
  assert.doesNotMatch(source, /export async function validateSource\(/);
  assert.doesNotMatch(source, /export async function scrapeCustom\(/);
});

test('listing freshness policy is imported directly instead of re-exported by normalize', () => {
  const normalize = readFileSync(path.join(srcRoot, 'normalize.js'), 'utf8');
  const legacyFilter = readFileSync(path.join(srcRoot, 'legacy-listing-filter.js'), 'utf8');
  const telegram = readFileSync(path.join(srcRoot, 'scrapers/telegram.js'), 'utf8');
  const social = readFileSync(path.join(srcRoot, 'scrapers/social.js'), 'utf8');

  assert.doesNotMatch(normalize, /export\s*\{\s*MAX_AGE_MS\s*\}/);
  assert.match(legacyFilter, /from '\.\/listing-policy\.js'/);
  assert.match(telegram, /from '\.\.\/listing-policy\.js'/);
  assert.match(social, /from '\.\.\/listing-policy\.js'/);
});
test('retired text parser facade stays absent from flats runtime', () => {
  assert.deepEqual(consumersOf(/textparse\\.js/), []);
  assert.throws(() => readFileSync(path.join(srcRoot, 'textparse.js'), 'utf8'), {code: 'ENOENT'});
});

test('listing normalization consumes aggregate package-owned fields', () => {
  const source = readFileSync(path.join(srcRoot, 'normalize-legacy.js'), 'utf8');
  assert.match(source, /parseHousingListingFields\(combined, \{country\}\)/);
  assert.doesNotMatch(source, /from '\.\/textparse\.js'/);
});

test('source adapters consume package-owned housing semantics', () => {
  for (const name of [
    'queueTasks.js',
    'legacy-listing-filter.js',
    'scrapers/custom.js',
    'scrapers/olx.js',
    'scrapers/owner-html.js',
    'scrapers/social.js',
    'scrapers/telegram.js',
  ]) {
    const source = readFileSync(path.join(srcRoot, name), 'utf8');
    assert.doesNotMatch(
      source,
      /\b(?:classifyAgency|guessPropertyType|looksHousingWanted)\b/,
      name + ' must consume package-owned housing semantics',
    );
  }
});