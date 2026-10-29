// Builds apartment-encoder training data (JSONL splits) from raw listing rows.
//
// Two steps, so the database is only ever read, in one streaming pass, and no
// Node/pg client is needed on the server:
//
//   1. node scripts/export-encoder-dataset.mjs --sql > query.sql
//      psql -At -f query.sql > raw.jsonl        (one JSON object per line)
//   2. node scripts/export-encoder-dataset.mjs raw.jsonl ./encoder-dataset
//
// Contacts are redacted with the ai-worker's privacy helper before text is
// written to the splits. Only rows with field provenance are kept: without it
// an empty field cannot be told apart from one the pipeline never looked at.
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { redactContacts } from '../../ai-worker/src/util/privacy.js';
import { lines } from '../src/ml/jsonl.js';
import { BOOL_TARGETS, ENUM_TARGETS, buildEncoderRow, splitOf } from '../src/ml/encoder-dataset.js';

const FIELDS = [...BOOL_TARGETS, ...Object.keys(ENUM_TARGETS), 'fieldProvenance'];

if (process.argv[2] === '--sql') {
  const list = FIELDS.map((f) => `'${f}'`).join(', ');
  console.log(`SET default_transaction_read_only = on;
SET max_parallel_workers_per_gather = 0;
SET statement_timeout = '30min';
SELECT jsonb_build_object(
  'source', source, 'source_id', source_id, 'title', title, 'description', description,
  'data', (SELECT jsonb_object_agg(key, value) FROM jsonb_each(data) WHERE key IN (${list}))
)
FROM flats.listings
WHERE length(description) >= 20 AND data ? 'fieldProvenance';`);
  process.exit(0);
}

const [rawFile, outDir = './encoder-dataset'] = process.argv.slice(2);
if (!rawFile) {
  console.error('usage: export-encoder-dataset.mjs --sql | <raw.jsonl> [outDir]');
  process.exit(64);
}

const buckets = { train: [], val: [], test: [] };
let read = 0;
for await (const line of lines(rawFile)) {
  if (!line.startsWith('{')) continue; // psql echoes "SET" for the leading statements
  read += 1;
  const row = JSON.parse(line);
  const listing = { ...row.data, source: row.source, sourceId: row.source_id, title: row.title, description: row.description };
  const example = buildEncoderRow(listing, { redact: redactContacts });
  if (example) buckets[splitOf(example.id)].push(example);
}

await mkdir(outDir, { recursive: true });
console.log(`read ${read} rows`);
for (const [name, items] of Object.entries(buckets)) {
  await writeFile(join(outDir, `${name}.jsonl`), items.map((x) => JSON.stringify(x)).join('\n') + '\n');
  console.log(`${name}: ${items.length}`);
}
