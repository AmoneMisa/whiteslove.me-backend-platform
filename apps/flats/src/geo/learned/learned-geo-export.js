import { createHash } from 'node:crypto';
import { markLearnedGeoExported, pendingLearnedGeo } from './learned-geo.js';

const OWNER = process.env.GEO_CATALOG_GITHUB_OWNER || 'AmoneMisa';
const REPO = process.env.GEO_CATALOG_GITHUB_REPO || 'geo-catalog';
const BRANCH = process.env.GEO_CATALOG_GITHUB_BRANCH || 'master';
const PATH = process.env.GEO_CATALOG_LEARNED_PATH || 'src/data/learned-addresses.js';
const LIMIT = Math.max(1, Math.min(5000, Number(process.env.GEO_CATALOG_EXPORT_LIMIT) || 1000));

function token() {
  return String(process.env.GEO_CATALOG_GITHUB_TOKEN || '').trim();
}

function githubHeaders() {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token()}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'flat-finder-geo-promoter/1.0',
  };
}

function stableId(lookupKey) {
  const digest = createHash('sha256').update(String(lookupKey)).digest('hex').slice(0, 24);
  return `learned:${digest}`;
}

function accuracyFor(row) {
  if (row.entity_type === 'address') return 'building';
  if (row.entity_type === 'street') return 'street';
  if (row.entity_type === 'residential_complex' || row.entity_type === 'poi' || row.entity_type === 'metro') return 'poi';
  if (['microdistrict', 'mahalla', 'local_area'].includes(row.entity_type)) return 'neighborhood';
  if (row.entity_type === 'district') return 'district';
  if (row.entity_type === 'city') return 'city';
  return 'approximate';
}

function rowToEntity(row) {
  const entity = {
    id: stableId(row.lookup_key),
    type: row.entity_type,
    country: row.country,
    canonicalName: row.canonical_name || row.query_text,
    lookupKey: row.lookup_key,
    center: { lat: Number(row.lat), lng: Number(row.lng) },
    accuracyM: row.accuracy_m == null ? undefined : Number(row.accuracy_m),
    accuracy: accuracyFor(row),
    source: 'osm',
  };

  for (const key of Object.keys(entity)) {
    if (entity[key] === undefined || entity[key] === null) delete entity[key];
  }
  return entity;
}

function existingLookupKeys(content) {
  const keys = new Set();
  for (const match of String(content).matchAll(/"lookupKey"\s*:\s*"([^"]+)"/gu)) keys.add(match[1]);
  for (const match of String(content).matchAll(/lookupKey\s*:\s*'([^']+)'/gu)) keys.add(match[1]);
  return keys;
}

function renderEntry(entity) {
  return JSON.stringify(entity, null, 2)
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

function appendEntities(content, entities) {
  if (!entities.length) return content;
  const marker = /Object\.freeze\(\[([\s\S]*?)\]\);\s*$/u;
  const match = String(content).match(marker);
  if (!match) throw new Error(`Unsupported ${PATH} format`);

  const currentBody = match[1].trim();
  const additions = entities.map(renderEntry).join(',\n');
  const body = currentBody
    ? `${currentBody.replace(/,?\s*$/u, '')},\n${additions}`
    : `\n${additions}\n`;
  return String(content).replace(marker, `Object.freeze([${body}]);\n`);
}

async function githubJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...githubHeaders(), ...(options.headers || {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`GitHub ${response.status}: ${data?.message || response.statusText}`);
  }
  return data;
}

export async function promoteLearnedGeo() {
  if (!token()) {
    return { skipped: true, reason: 'GEO_CATALOG_GITHUB_TOKEN is not configured', exported: 0 };
  }

  const rows = await pendingLearnedGeo(LIMIT);
  if (!rows.length) return { skipped: false, exported: 0, pending: 0 };

  const apiPath = PATH.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${encodeURIComponent(OWNER)}/${encodeURIComponent(REPO)}/contents/${apiPath}?ref=${encodeURIComponent(BRANCH)}`;
  const current = await githubJson(url);
  const content = Buffer.from(String(current.content || '').replace(/\s+/g, ''), 'base64').toString('utf8');
  const existing = existingLookupKeys(content);

  const alreadyPresent = rows.filter((row) => existing.has(row.lookup_key));
  const fresh = rows.filter((row) => !existing.has(row.lookup_key));

  if (fresh.length) {
    const nextContent = appendEntities(content, fresh.map(rowToEntity));
    await githubJson(`https://api.github.com/repos/${encodeURIComponent(OWNER)}/${encodeURIComponent(REPO)}/contents/${apiPath}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `chore(geo): promote ${fresh.length} learned coordinate${fresh.length === 1 ? '' : 's'}`,
        content: Buffer.from(nextContent, 'utf8').toString('base64'),
        sha: current.sha,
        branch: BRANCH,
      }),
    });
  }

  const exportedKeys = [...alreadyPresent, ...fresh].map((row) => row.lookup_key);
  const exported = await markLearnedGeoExported(exportedKeys);
  console.log(`[geo:promote] pending=${rows.length} added=${fresh.length} marked=${exported}`);
  return { skipped: false, pending: rows.length, added: fresh.length, exported };
}

export const __learnedGeoExportTest = {
  stableId,
  accuracyFor,
  existingLookupKeys,
  rowToEntity,
  appendEntities,
};
