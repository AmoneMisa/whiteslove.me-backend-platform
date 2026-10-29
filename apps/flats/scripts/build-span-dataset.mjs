// Builds token-tagging training data (PRICE / CURRENCY / ADDRESS / METRO spans)
// from raw listing rows pulled with a read-only query:
//
//   node scripts/build-span-dataset.mjs <raw.jsonl> [outDir]
//
// Text is redacted first and alignment runs on the redacted string, so the
// character offsets match what the model will see. Rows where every entity is
// unalignable are dropped; entities that are unalignable in an otherwise usable
// row are listed in `ignore` and masked out of the loss.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { redactContacts } from '../../ai-worker/src/util/privacy.js';
import { lines } from '../src/ml/jsonl.js';
import { splitOf } from '../src/ml/encoder-dataset.js';
import { lexiconEntries, lexiconPlaceNames } from '../src/ml/lexicon-names.js';
import { ENTITIES, alignSpans, ambiguousStations, citySkeletons, districtIndex, placeKinds, stationGroups, stationSkeletons, toCodePointOffsets } from '../src/ml/span-align.js';

const [rawFile, outDir = './span-dataset'] = process.argv.slice(2);
if (!rawFile) {
  console.error('usage: build-span-dataset.mjs <raw.jsonl> [outDir]');
  process.exit(64);
}

// Pass 1: which station names exist at all. A row that stores no station, or one
// station, can still mention others; knowing the full set lets the aligner tell
// "another station" (neutral) and "a district that is also a station" (ignored)
// from plain text.
const metroNames = [];
const districtNames = []; // district / area / kvartal: the same idea for localities
for await (const line of lines(rawFile)) {
  if (!line.startsWith('{')) continue;
  const row = JSON.parse(line);
  if (row.metro) metroNames.push(row.metro);
  // the column says how big a place is: `district` holds districts, `area` and `kvartal` smaller places
  for (const [name, kind] of [[row.district, 'DISTRICT'], [row.area, 'LOCALITY'], [row.kvartal, 'LOCALITY']]) if (name) districtNames.push({ name, kind });
}
const known = lexiconPlaceNames();
const stations = stationSkeletons(metroNames, 8, known.metro);
const districts = districtIndex(districtNames, 300); // names common enough to label wherever they are written; lexicon districts were tried and cost precision, see README
const groups = stationGroups(known.metroGroups);
// a station that is also a district, or a country ("Узбекистан" in a list of streets), counts only next to "метро"
const countryNames = lexiconEntries().filter((e) => e.type === 'country').flatMap((e) => e.names);
const ambiguous = ambiguousStations(known.metroGroups, [...known.districts, ...countryNames]);
const cities = citySkeletons(lexiconEntries()); // so "районе Одессы" is not a district
const kinds = placeKinds(lexiconEntries()); // the lexicon's own types: district, microdistrict, mahalla, local area
console.log(`lexicon: ${known.metro.length} station names, ${known.districts.length} district names`);
console.log(`stations: ${stations.size} distinct names from ${metroNames.length} stored values`);
console.log(`districts: ${[...districts.values()].reduce((n, list) => n + list.length, 0)} distinct names from ${districtNames.length} stored values`);

const buckets = { train: [], val: [], test: [] };
const count = Object.fromEntries(ENTITIES.map((e) => [e, { found: 0, ignore: 0, absent: 0 }]));
let read = 0;
let kept = 0;
for await (const line of lines(rawFile)) {
  if (!line.startsWith('{')) continue; // psql echoes "SET" for the leading statements
  read += 1;
  const row = JSON.parse(line);
  const text = redactContacts(`${row.title || ''}\n${row.description || ''}`.trim());
  const { spans, ignore, neutral } = alignSpans(text, row, { stations, districts, stationGroups: groups, ambiguousStations: ambiguous, placeKinds: kinds, cities });
  for (const e of ENTITIES) {
    count[e][spans.some((s) => s.label === e) ? 'found' : ignore.includes(e) ? 'ignore' : 'absent'] += 1;
  }
  if (ignore.length === ENTITIES.length) continue;
  const id = `${row.source}:${row.source_id}`;
  buckets[splitOf(id)].push({
    id, text, spans: toCodePointOffsets(text, spans), neutral: toCodePointOffsets(text, neutral), ignore,
  });
  kept += 1;
}

await mkdir(outDir, { recursive: true });
console.log(`read ${read} rows, kept ${kept}`);
console.table(count);
for (const [name, items] of Object.entries(buckets)) {
  await writeFile(join(outDir, `${name}.jsonl`), items.map((x) => JSON.stringify(x)).join('\n') + '\n');
  console.log(`${name}: ${items.length}`);
}
