// Text provider backed by the self-hosted apartment encoder (ml/apartment-encoder).
//
// It speaks the same contract as the LLM providers -- returns an object shaped
// like apartmentJsonSchema -- so extract.js, Zod validation and the flats-side
// merge (mayAiOverwrite, location gates) apply unchanged. It only knows the
// flag/enum fields it was trained on; everything else is null, which the
// merge treats as "not found". It is a PARTIAL provider (text-providers.js):
// put it ahead of an LLM provider and runText lets that provider fill the
// fields the encoder left null, the encoder's values taking precedence:
//   TEXT_PROVIDERS=encoder,freellmapi
// Other kinds (vacancy, candidate, translation) fail without benching it, so
// the chain falls through to the next provider.
import { config } from '../config.js';
import { fetchJson } from '../util/httpProvider.js';
import { apartmentJsonSchema } from '../schemas/apartment.js';

const LABEL_VALUE = { yes: true, no: false };

/** Maps the encoder's per-field predictions onto the apartment output shape. */
export function encoderToApartment(
  { fields = {}, confidence = 0, spans = null },
  { minProb = config.encoderMinProb, allowed = config.encoderFields } = {},
) {
  const out = Object.fromEntries(Object.keys(apartmentJsonSchema.properties).map((key) => [key, null]));
  out.amenities = [];
  const allowAll = allowed.includes('*');
  for (const [field, { label, prob }] of Object.entries(fields)) {
    if (!(field in out) || label === 'unsaid' || prob < minProb) continue;
    if (!allowAll && !allowed.includes(field)) continue;
    out[field] = label in LABEL_VALUE ? LABEL_VALUE[label] : label;
  }
  // The address comes from the span tagger (serve.py --spans-model), not a flag head.
  // Opt-in: 'address' must be listed in ENCODER_FIELDS (it is not by default). The
  // flats merge still checks it against the location dictionary and its address filters.
  const address = spans?.ADDRESS?.[0]?.text;
  if (address && (allowAll || allowed.includes('address'))) out.address = address;
  out.confidence = confidence;
  return out;
}

export async function encoder({ kind, payload }) {
  if (kind !== 'apartment') throw new Error('ENCODER_UNSUPPORTED_KIND');
  if (!config.encoderUrl) {
    throw Object.assign(new Error('ENCODER_NOT_CONFIGURED'), { code: 'TEXT_PROVIDER_NOT_CONFIGURED' });
  }
  const prediction = await fetchJson(`${config.encoderUrl}/predict`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: payload?.text ?? '' }),
  }, 'encoder', { bucket: 'textProviders', timeoutMs: config.encoderTimeoutMs });
  return encoderToApartment(prediction);
}
