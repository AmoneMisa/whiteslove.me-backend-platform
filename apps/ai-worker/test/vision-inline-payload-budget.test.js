import test from 'node:test';
import assert from 'node:assert/strict';

// Inlining every photo as base64 makes a body big enough to be refused before
// the model sees it: Gemini behind the nginx relay answers HTTP 413 "Request
// Entity Too Large". The request carries as many photos as fit the budget and
// drops the tail, because an oversized body loses the listing every photo.
process.env.VISION_PROVIDERS = 'gemini';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.AI_MAX_INLINE_REQUEST_BYTES = '200000';

const { emptyVisionResult } = await import('../src/schemas/vision.js');
const { analyzePhotos } = await import('../src/services/vision.js');

const PHOTO_BYTES = 60_000; // ~80KB once base64-encoded

function stubFetch(onBody) {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).startsWith('https://photos.example.com/')) {
      return new Response(Buffer.alloc(PHOTO_BYTES, 1), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    }
    onBody(JSON.parse(options.body));
    const vision = emptyVisionResult();
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(vision) } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return () => { global.fetch = originalFetch; };
}

function imageParts(body) {
  return body.messages[0].content.filter((part) => part.type === 'image_url');
}

test('photos are dropped once the request budget is spent', async () => {
  let body;
  const restore = stubFetch((sent) => { body = sent; });
  try {
    const urls = Array.from({ length: 8 }, (_, i) => `https://photos.example.com/${i}.jpg`);
    const result = await analyzePhotos(urls);
    assert.equal(result.provider, 'gemini');

    const images = imageParts(body);
    // Two ~80KB images fit in the 200KB budget; the third would exceed it.
    assert.equal(images.length, 2);
    for (const image of images) assert.match(image.image_url.url, /^data:image\/jpeg;base64,/);

    const payload = images.reduce((total, image) => total + image.image_url.url.length, 0);
    assert.ok(payload <= 200000, `payload ${payload} exceeded the budget`);
  } finally {
    restore();
  }
});

test('a photo that cannot be downloaded does not lose the others', async () => {
  let body;
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const href = String(url);
    if (href === 'https://photos.example.com/0.jpg') return new Response('gone', { status: 404 });
    if (href.startsWith('https://photos.example.com/')) {
      return new Response(Buffer.alloc(PHOTO_BYTES, 1), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    }
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(emptyVisionResult()) } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    await analyzePhotos([
      'https://photos.example.com/0.jpg',
      'https://photos.example.com/1.jpg',
      'https://photos.example.com/2.jpg',
    ]);
    assert.equal(imageParts(body).length, 2);
  } finally {
    global.fetch = originalFetch;
  }
});
