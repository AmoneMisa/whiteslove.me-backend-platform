// Shadow mode for the self-hosted apartment encoder (ml/apartment-encoder).
//
// With ENCODER_SHADOW=true every apartment extraction also asks the encoder about the same text, after the
// real answer is ready, and records how the encoder compares with what the deterministic parser already knew
// (knownFacts) and with what the provider chain answered. Nothing the encoder says is returned, merged or
// stored: it cannot change a result, and a slow or failing encoder cannot delay or fail one (the call is not
// awaited, has its own deadline, and every error is counted and swallowed). The point is to learn, on real
// traffic, which fields the encoder gets right before any of them is allowed to fill a listing.
//
// Read the outcome at /metrics under `encoderShadow`; per field, per source (parser | llm):
//   agree         both have a value and they match
//   disagree      both have a value and they differ
//   encoderOnly   the encoder has a value, the source has none  (what the encoder would add)
//   sourceOnly    the source has a value, the encoder has none
import { config } from '../config.js';
import { fetchJson } from '../util/httpProvider.js';
import { log } from '../util/logger.js';
import { metrics } from '../util/metrics.js';

const FLAGS = new Set([
  'newBuilding', 'balcony', 'airConditioner', 'gas', 'dishwasher', 'terrace', 'privateYard', 'tv', 'microwave', 'oven',
  'bidet', 'walkInCloset', 'bathtub', 'shower', 'euroLayout', 'furnished', 'petsAllowed', 'childrenAllowed',
  'communalSeparated', 'parking', 'elevator', 'heating', 'hotWater', 'internet', 'smokingAllowed', 'depositRequired',
  'commissionRequired',
]);
// Kinds of place the apartment schema has no field for: counted, so we know how often the encoder finds them.
const UNCOMPARED = ['MICRODISTRICT', 'LOCALITY', 'LANDMARK', 'NEARBY', 'METRO'];

const COMPLEX_MARKER = /^(?:жк|жр|ж\.\s?к\.|жилой\s+комплекс|жилий\s+комплекс|житловий\s+комплекс|complexul|complex)\s+/iu;
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** What the encoder says per comparable field: { field: value }. Empty fields are left out. */
export function encoderValues({ fields = {}, spans = null, price = null }, { minProb = config.encoderMinProb } = {}) {
  const out = {};
  for (const [field, { label, prob }] of Object.entries(fields)) {
    if (!FLAGS.has(field) || label === 'unsaid' || prob < minProb) continue;
    if (label === 'yes') out[field] = true;
    else if (label === 'no') out[field] = false;
  }
  const first = (entity) => text(spans?.[entity]?.[0]?.text);
  if (first('ADDRESS')) out.address = first('ADDRESS');
  if (first('DISTRICT')) out.district = first('DISTRICT');
  const complex = first('COMPLEX');
  if (complex) out.residenceComplex = complex.replace(COMPLEX_MARKER, '').trim() || null;
  if (price && number(price.amount) != null && !price.ambiguous) out.priceAmount = price.amount;
  const currency = text(price?.currency?.text);
  if (currency) out.priceCurrency = currency;
  // A deposit written as a plain amount is comparable; "2 месяца" or "без залога" needs the lexicon, later.
  const deposit = first('DEPOSIT');
  if (deposit && /^\d[\d\s.,]*$/.test(deposit)) out.depositAmount = Number(deposit.replace(/\s/g, '').replace(',', '.'));
  return out;
}

const norm = (value) => String(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** 'agree' | 'disagree' | 'encoderOnly' | 'sourceOnly' | null (neither has a value). */
export function compareValue(encoderValue, sourceValue) {
  const a = encoderValue ?? null;
  const b = sourceValue ?? null;
  if (a == null && b == null) return null;
  if (b == null) return 'encoderOnly';
  if (a == null) return 'sourceOnly';
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b ? 'agree' : 'disagree';
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= Math.max(0.5, Math.abs(b) * 0.005) ? 'agree' : 'disagree';
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 'disagree';
  // "Абая 5" and "ул. Абая 5" are the same address; so are "Chilonzor" and "Chilonzor tumani"
  return x === y || (Math.min(x.length, y.length) >= 3 && (x.includes(y) || y.includes(x))) ? 'agree' : 'disagree';
}

function bucket(field) {
  const fields = (metrics.encoderShadow.fields ??= {});
  return (fields[field] ??= {
    seen: 0,
    parser: { agree: 0, disagree: 0, encoderOnly: 0, sourceOnly: 0 },
    llm: { agree: 0, disagree: 0, encoderOnly: 0, sourceOnly: 0 },
  });
}

let logWindow = { startedAt: 0, count: 0 };
function mayLog() {
  const limit = config.encoderShadowLogPerMinute;
  if (!limit) return false;
  const now = Date.now();
  if (now - logWindow.startedAt > 60_000) logWindow = { startedAt: now, count: 0 };
  logWindow.count += 1;
  return logWindow.count <= limit;
}

/**
 * Records one comparison. `knownFacts` is what the parser already had, `data` the sanitized provider answer.
 * Returns the per-field outcomes (used by tests; the caller ignores it).
 */
export function recordShadow(prediction, { knownFacts = {}, data = {} } = {}) {
  const values = encoderValues(prediction);
  const outcomes = {};
  const fields = new Set([...Object.keys(values), 'address', 'district', 'residenceComplex', 'priceAmount', 'priceCurrency', 'depositAmount']);
  for (const field of fields) {
    const row = { encoder: values[field] ?? null, parser: knownFacts?.[field] ?? null, llm: data?.[field] ?? null };
    const parser = compareValue(row.encoder, row.parser);
    const llm = compareValue(row.encoder, row.llm);
    if (!parser && !llm) continue;
    const stat = bucket(field);
    stat.seen += 1;
    if (parser) stat.parser[parser] += 1;
    if (llm) stat.llm[llm] += 1;
    outcomes[field] = { parser, llm };
    if ((parser === 'disagree' || llm === 'disagree' || parser === 'encoderOnly') && typeof row.encoder !== 'boolean' && mayLog()) {
      log.info('encoder shadow', { field, ...row, parser, llm });
    }
  }
  for (const entity of UNCOMPARED) {
    if (prediction.spans?.[entity]?.length) {
      const stat = (metrics.encoderShadow.found ??= {});
      stat[entity] = (stat[entity] ?? 0) + 1;
    }
  }
  return outcomes;
}

/**
 * Fire and forget: never throws, never awaited by the caller, never touches the result. Skipped when the encoder
 * already answers for real (TEXT_PROVIDERS lists it) or when shadow mode is off.
 */
export function shadowEncoder(input, data) {
  if (!config.encoderShadow || !config.encoderUrl || config.textProviders.includes('encoder')) return;
  const body = String(input?.text ?? '');
  if (!body.trim()) return;
  metrics.encoderShadow.requests += 1;
  fetchJson(`${config.encoderUrl}/predict`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: body }),
  }, 'encoder-shadow', { bucket: 'textProviders', timeoutMs: config.encoderTimeoutMs })
    .then((prediction) => recordShadow(prediction, { knownFacts: input?.knownFacts, data }))
    .catch((error) => {
      metrics.encoderShadow.failures += 1;
      log.warn('encoder shadow failed', { error: String(error?.message || error).slice(0, 160) });
    });
}
