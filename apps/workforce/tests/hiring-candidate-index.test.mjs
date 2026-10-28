import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const { indexDefinition } = await import('../server/utils/hiring/hiringElastic.ts')
const source = await readFile(new URL('../server/utils/hiring/hiringElastic.ts', import.meta.url), 'utf8')
const mapping = indexDefinition().mappings.properties

test('no field has a multi-field inside a multi-field: Elasticsearch 8 and later refuse to create such an index', () => {
  for (const [name, definition] of Object.entries(mapping)) {
    for (const [sub, subDefinition] of Object.entries(definition.fields || {})) {
      assert.equal(subDefinition.fields, undefined, `${name}.${sub} must not have fields of its own`)
    }
  }
})

test('every field a search names exists in the mapping, as the field itself or one of its views', () => {
  const search = source.slice(source.indexOf('export async function searchCandidates'))
  const named = [...search.matchAll(/'([A-Za-z][A-Za-z.]*)(?:\^[\d.]+)?'/g)].map((match) => match[1])
    .filter((field) => Object.hasOwn(mapping, field.split('.')[0]) || /\.(?:text|latin)$/.test(field))
  assert.ok(named.length >= 10, `found the field names in the queries (${named.length})`)
  const resolves = (field) => {
    const [head, ...rest] = field.split('.')
    let definition = mapping[head]
    for (const part of rest) definition = definition?.fields?.[part]
    return Boolean(definition)
  }
  const missing = named.filter((field) => !resolves(field))
  assert.deepEqual(missing, [], `fields in queries that the mapping does not define: ${missing.join(', ')}`)
})

test('the keyword fields keep both views a query can use', () => {
  for (const field of ['city', 'district', 'professions', 'previousProfessions', 'features', 'skills']) {
    assert.equal(mapping[field].type, 'keyword')
    assert.equal(mapping[field].fields.text.analyzer, 'candidate_text')
    assert.equal(mapping[field].fields.latin.analyzer, 'candidate_latin')
  }
  assert.equal(mapping.name.fields.latin.analyzer, 'candidate_latin', 'a plain text field keeps its transliterated view')
})
