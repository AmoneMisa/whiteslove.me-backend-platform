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

test('the index is created once, an existing one is recognised (HEAD has no body), and a lost race counts as success', async () => {
  const { ensureCandidateIndex } = await import('../server/utils/hiring/hiringElastic.ts')
  const original = globalThis.fetch
  const calls = []
  const answer = (status, body = '') => new Response(body, { status, headers: { 'content-type': 'application/json' } })
  try {
    // exists: HEAD answers 200 with an empty body; nothing else may be sent
    globalThis.fetch = async (url, init = {}) => { calls.push(`${init.method || 'GET'}`); return answer(200) }
    await ensureCandidateIndex()
    assert.deepEqual(calls, ['HEAD'])

    // missing: HEAD 404, then one PUT, even when three callers arrive together
    calls.length = 0
    globalThis.fetch = async (url, init = {}) => {
      calls.push(`${init.method || 'GET'}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
      return init.method === 'HEAD' ? answer(404) : answer(200, '{"acknowledged":true}')
    }
    await Promise.all([ensureCandidateIndex(), ensureCandidateIndex(), ensureCandidateIndex()])
    assert.deepEqual(calls, ['HEAD', 'PUT'])

    // another process won the race: the PUT is refused as already existing, which is fine
    calls.length = 0
    globalThis.fetch = async (url, init = {}) => {
      calls.push(`${init.method || 'GET'}`)
      return init.method === 'HEAD'
        ? answer(404)
        : answer(400, '{"error":{"root_cause":[{"type":"resource_already_exists_exception"}],"type":"resource_already_exists_exception"}}')
    }
    await ensureCandidateIndex()
    assert.deepEqual(calls, ['HEAD', 'PUT'])

    // any other refusal is still an error
    globalThis.fetch = async (url, init = {}) => (init.method === 'HEAD' ? answer(404) : answer(400, '{"error":{"type":"mapper_parsing_exception"}}'))
    await assert.rejects(ensureCandidateIndex(), /mapper_parsing_exception/)
  } finally {
    globalThis.fetch = original
  }
})
