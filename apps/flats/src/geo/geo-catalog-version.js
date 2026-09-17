import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const PACKAGE_NAME = '@whiteslove/geo-catalog';

// The package's "exports" map doesn't list ./package.json, so
// require('@whiteslove/geo-catalog/package.json') throws
// ERR_PACKAGE_PATH_NOT_EXPORTED. Resolve the exported entry point instead and
// walk up to the package's own manifest.
export function readInstalledPackageVersion(name = PACKAGE_NAME, resolve = import.meta.resolve) {
  let dir = dirname(fileURLToPath(resolve(name)));
  for (;;) {
    const manifestPath = join(dir, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.name === name) return manifest.version;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Cannot locate package.json for ${name}`);
    dir = parent;
  }
}
