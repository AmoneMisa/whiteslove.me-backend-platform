import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

import {readInstalledPackageVersion} from '../src/geo/geo-catalog-version.js';

const installedManifest = JSON.parse(readFileSync(
  new URL('../node_modules/@whiteslove/geo-catalog/package.json', import.meta.url),
  'utf8',
));

test('geo-catalog does not export ./package.json, so a direct require throws', () => {
  // Guards the reason this helper exists; if the package ever exports its
  // manifest, the helper still works, but this documents the failure mode.
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    "import {createRequire} from 'node:module'; createRequire(import.meta.url)('@whiteslove/geo-catalog/package.json');",
  ], {cwd: new URL('..', import.meta.url), encoding: 'utf8'});
  if (installedManifest.exports?.['./package.json']) return;
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
});

test('reads the installed geo-catalog version through its exported entry point', () => {
  assert.equal(readInstalledPackageVersion('@whiteslove/geo-catalog'), installedManifest.version);
});

test('snapshot sync reads the geo-catalog version without importing its package.json subpath', () => {
  // Importing the module itself needs GEO_CATALOG_DECRYPTION_KEY, so check the source.
  const source = readFileSync(new URL('../src/geo/geo-city-snapshot-sync.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /['"]@whiteslove\/geo-catalog\/package\.json['"]/);
  assert.match(source, /readInstalledPackageVersion\('@whiteslove\/geo-catalog'\)/);
});
