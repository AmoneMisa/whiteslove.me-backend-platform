import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TEXT_PROVIDERS = 'gemini';
process.env.GEMINI_API_KEY = 'test-key';

const { extract } = await import('../src/services/extract.js');

// CV, vacancies and apartment text extraction all go through this path. The
// JSON Schema for each kind was shown to the model inside the user payload and
// never enforced -- the same arrangement that had smaller vision models
// returning every answer in the wrong shape.

function stub({ onBody, rejectSchemaMode = false, answer }) {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    onBody?.(body);
    if (rejectSchemaMode && body.response_format?.type === 'json_schema') {
      return new Response(
        JSON.stringify({ error: { message: "Invalid 'response_format': json_schema is unsupported" } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return () => { global.fetch = originalFetch; };
}

test('a candidate extraction enforces the candidate schema at decode time', async () => {
  const bodies = [];
  const restore = stub({ onBody: (b) => bodies.push(b), answer: { confidence: 0.9 } });
  try {
    await extract('candidate', { text: 'Frontend developer, 5 years', knownFacts: {} });
    const format = bodies[0].response_format;
    assert.equal(format.type, 'json_schema');
    assert.equal(format.json_schema.strict, true);
    assert.equal(format.json_schema.name, 'candidate');
    assert.equal(format.json_schema.schema.additionalProperties, false);
  } finally {
    restore();
  }
});

test('a vacancy extraction enforces the vacancy schema', async () => {
  const bodies = [];
  const restore = stub({ onBody: (b) => bodies.push(b), answer: { confidence: 0.9 } });
  try {
    await extract('vacancy', { text: 'Hiring a backend engineer', knownFacts: {} });
    assert.equal(bodies[0].response_format.json_schema.name, 'vacancy');
  } finally {
    restore();
  }
});

test('the schema still travels in the payload, for models that read it', async () => {
  // Constrained decoding shapes the answer; the prompt copy is what tells the
  // model what the fields mean.
  const bodies = [];
  const restore = stub({ onBody: (b) => bodies.push(b), answer: { confidence: 0.9 } });
  try {
    await extract('apartment', { text: 'kvartira', knownFacts: {} });
    const userMessage = JSON.parse(bodies[0].messages[1].content);
    assert.ok(userMessage.schema, 'schema should still be shown to the model');
  } finally {
    restore();
  }
});

test('a provider that rejects schema mode still returns an extraction', async () => {
  const bodies = [];
  const restore = stub({ onBody: (b) => bodies.push(b), rejectSchemaMode: true, answer: { confidence: 0.9 } });
  try {
    await extract('apartment', { text: 'kvartira', knownFacts: {} });
    assert.equal(bodies.length, 2, 'should retry once');
    assert.equal(bodies[0].response_format.type, 'json_schema');
    assert.equal(bodies[1].response_format.type, 'json_object');
  } finally {
    restore();
  }
});
