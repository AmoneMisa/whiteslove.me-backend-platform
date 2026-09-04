import test from 'node:test';
import assert from 'node:assert/strict';

process.env.VISION_PROVIDERS = 'gemini';
process.env.GEMINI_API_KEY = 'test-key';

const { analyzePhotos } = await import('../src/services/vision.js');
const { emptyVisionResult, VISION_FIELDS } = await import('../src/schemas/vision.js');

// json_object obliges a model to emit valid JSON and nothing more -- a bare
// `"roomsVisible": 6` satisfies it completely, which is what the smaller
// models were sending. A json_schema response_format constrains the sampler,
// so the wrong shape stops being representable.

function stub({ onBody, rejectSchemaMode = false }) {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).startsWith('https://photos.example.com/')) {
      return new Response(Buffer.from('jpeg'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    const body = JSON.parse(options.body);
    onBody?.(body);
    if (rejectSchemaMode && body.response_format?.type === 'json_schema') {
      return new Response(
        JSON.stringify({ error: { message: "Invalid 'response_format': json_schema is not supported" } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }
    const vision = emptyVisionResult();
    vision.balcony = { value: true, confidence: 0.9, evidence: ['photo_1'] };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(vision) } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return () => { global.fetch = originalFetch; };
}

const photo = () => [`https://photos.example.com/${Math.random()}.jpg`];

test('the schema is enforced at decode time, not just requested in the prompt', async () => {
  const bodies = [];
  const restore = stub({ onBody: (body) => bodies.push(body) });
  try {
    await analyzePhotos(photo());
    const format = bodies[0].response_format;
    assert.equal(format.type, 'json_schema');
    assert.equal(format.json_schema.strict, true);
    // Every field constrained, and nothing outside the contract accepted.
    assert.deepEqual(Object.keys(format.json_schema.schema.properties).sort(), [...VISION_FIELDS].sort());
    assert.equal(format.json_schema.schema.additionalProperties, false);
    // The wrapper is what the models kept getting wrong, so it must be forced.
    assert.deepEqual(
      format.json_schema.schema.properties.balcony.required.sort(),
      ['confidence', 'evidence', 'value'],
    );
  } finally {
    restore();
  }
});

test('a provider that rejects schema mode still gets an answer', async () => {
  // freellmapi routes to whatever upstream is alive, so support varies per
  // request; losing the provider over an unsupported parameter would be worse
  // than sending the weaker constraint.
  const bodies = [];
  const restore = stub({ onBody: (body) => bodies.push(body), rejectSchemaMode: true });
  try {
    const result = await analyzePhotos(photo());
    assert.equal(result.data.balcony.value, true);
    assert.equal(bodies.length, 2, 'should retry once');
    assert.equal(bodies[0].response_format.type, 'json_schema');
    assert.equal(bodies[1].response_format.type, 'json_object');
  } finally {
    restore();
  }
});

test('the fallback is remembered, so the rejection is paid once', async () => {
  // Runs after the test above, which already recorded gemini as unsupported.
  const bodies = [];
  const restore = stub({ onBody: (body) => bodies.push(body), rejectSchemaMode: true });
  try {
    await analyzePhotos(photo());
    assert.equal(bodies.length, 1, 'should not re-attempt schema mode');
    assert.equal(bodies[0].response_format.type, 'json_object');
  } finally {
    restore();
  }
});
