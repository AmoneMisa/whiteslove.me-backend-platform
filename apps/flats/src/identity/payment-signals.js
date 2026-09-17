/**
 * Payment-related risk evidence (§27).
 *
 * Deposits, commissions and a month paid up front are how renting works in
 * every market this service covers, so none of them is evidence on its own.
 * Each signal here needs a *combination* the honest case does not produce:
 * payment together with "before viewing", identity documents requested before
 * any viewing, a fee for merely looking at a flat.
 *
 * Text matching returns the reason code and the offset of the match, never the
 * matched text itself. A listing that asks for a card number may contain one,
 * and evidence rows must not become a store of other people's card numbers.
 *
 * `\b` is ASCII-only in JavaScript and never fires next to Cyrillic, so word
 * boundaries are Unicode lookarounds throughout.
 */

export const PAYMENT_RISK_REASONS = Object.freeze([
  'payment_before_verification',
  'payment_destination_changed',
  'application_fee_harvesting_pattern',
  'premature_identity_data_request',
  'third_party_credit_check_risk',
  'payment_pressure',
]);

/** Characters either side of a match searched for its qualifying context.
 * Roughly one sentence: far enough to catch "send the deposit today, before the
 * viewing", near enough not to pair unrelated sentences of a long listing. */
export const CONTEXT_WINDOW = 90;

/** Distinct properties before a per-listing fee becomes an actor pattern. */
export const MIN_INDEPENDENT_PROPERTIES = 3;

const L = '[\\p{L}\\p{N}]';
/** Word-start match with an open ending, so stems cover inflections. */
const stems = (...parts) => new RegExp(`(?<!${L})(?:${parts.join('|')})`, 'giu');
/** Whole-word match. */
const words = (...parts) => new RegExp(`(?<!${L})(?:${parts.join('|')})(?!${L})`, 'giu');

const PAYMENT = stems(
  'prepay', 'pre-pay', 'deposit', 'transfer', 'send (?:the )?money', 'pay(?:ment)?',
  'предоплат', 'аванс', 'задат', 'залог', 'переве(?:д|ст)', 'скин(?:ь|уть) (?:на карту|деньги)', 'оплат',
  'oldindan to.lov', 'to.lov', 'zakalat', 'avans', 'pul o.tkaz', 'o.tkazib',
  'передоплат', 'завдат',
);

const BEFORE_VIEWING = stems(
  'before (?:the )?(?:viewing|showing|visit)', 'without (?:a )?(?:viewing|visit)', 'to (?:reserve|hold|book) (?:the )?(?:flat|apartment|room)', 'sight unseen',
  'до просмотра', 'без просмотра', 'для брони', 'чтобы (?:забронировать|закрепить)', 'бронь', 'до показа',
  'ko.rishdan oldin', 'ko.rmasdan', 'bron qilish', 'bron uchun',
  'до перегляду', 'без перегляду',
);

const IDENTITY_DOCUMENT = stems(
  'passport', 'id (?:card )?(?:photo|scan)', 'photo of (?:your )?id', 'driver.?s licen',
  'паспорт', 'фото (?:паспорта|документ)', 'скан (?:паспорта|документ)', 'id.?карт',
  'pasport', 'hujjat (?:rasmi|nusxa)',
);

const VIEWING_STAGE = stems(
  'before (?:the )?(?:viewing|showing|visit|meeting)', 'first send', 'send (?:me )?(?:a )?(?:photo|scan)',
  'до просмотра', 'до встречи', 'сначала (?:отправ|скин|пришл)', 'пришлите', 'скиньте',
  'ko.rishdan oldin', 'uchrashuvdan oldin', 'avval yubor',
);

/** Never legitimately needed by a landlord at any stage. */
const ALWAYS_SENSITIVE = words(
  'card number', 'cvv', 'cvc', 'sms code', 'code from (?:the )?sms', 'one.time code',
  'номер карты', 'код из смс', 'смс.?код', 'cvv.?код',
  'karta raqam', 'sms kod',
);

const VIEWING_FEE = stems(
  'viewing fee', 'fee (?:for|to) (?:view|see)', 'pay (?:to|for) (?:the )?viewing', 'application fee',
  'оплата (?:за )?просмотр', 'плата за (?:просмотр|показ)', 'платный просмотр', 'за показ',
  'ko.rish uchun to.lov', 'ko.rish pulli',
);

const CREDIT_CHECK = stems(
  'credit (?:check|report|score)', 'background check (?:fee|site|link)',
  'кредитн(?:ая|ую|ой) (?:истори|проверк)', 'проверк[аиу] кредитн',
  'kredit tarix',
);

const PRESSURE = stems(
  'urgent', 'only today', 'today only', 'many (?:people|applicants|interested)', 'someone else will', 'last chance',
  'срочно', 'только сегодня', 'много желающих', 'другие желающие', 'уйдёт', 'уйдет', 'последний шанс',
  'shoshilinch', 'faqat bugun', 'xohlovchilar ko.p',
  'терміново', 'тільки сьогодні',
);

const LINK = /https?:\/\/|(?<![\p{L}\p{N}])www\./giu;

function matchesOf(pattern, text) {
  pattern.lastIndex = 0;
  return [...text.matchAll(pattern)].map((match) => ({ index: match.index, end: match.index + match[0].length }));
}

function hasNear(pattern, text, anchor, window = CONTEXT_WINDOW) {
  const from = Math.max(0, anchor.index - window);
  const to = Math.min(text.length, anchor.end + window);
  pattern.lastIndex = 0;
  return pattern.test(text.slice(from, to));
}

/**
 * Payment signals in one piece of text: a listing, or a message from the
 * advertiser. Each finding carries the offset of its anchor and nothing else
 * from the text.
 */
export function detectPaymentSignals(text) {
  const source = String(text ?? '').normalize('NFKC');
  if (!source.trim()) return Object.freeze({ findings: Object.freeze([]), evidenceOnly: true });

  const findings = new Map();
  const add = (reasonCode, anchor) => {
    if (!findings.has(reasonCode)) findings.set(reasonCode, { reasonCode, polarity: 'risk', dimension: 'payment_risk', independentCount: 1, detail: { offset: anchor.index } });
  };

  const payments = matchesOf(PAYMENT, source);
  for (const anchor of payments) {
    // A deposit on its own is ordinary. Paid before anyone has seen the flat,
    // it is the core advance-fee pattern.
    if (hasNear(BEFORE_VIEWING, source, anchor)) add('payment_before_verification', anchor);
    if (hasNear(PRESSURE, source, anchor)) add('payment_pressure', anchor);
  }

  for (const anchor of matchesOf(ALWAYS_SENSITIVE, source)) add('premature_identity_data_request', anchor);
  for (const anchor of matchesOf(IDENTITY_DOCUMENT, source)) {
    // A passport at contract signing is normal. Asked for up front, it is not.
    if (hasNear(VIEWING_STAGE, source, anchor)) add('premature_identity_data_request', anchor);
  }

  for (const anchor of matchesOf(CREDIT_CHECK, source)) {
    // A landlord checking credit is ordinary; the risk is sending the tenant to
    // a third party to pay for it, which is how these sites harvest data.
    if (hasNear(PAYMENT, source, anchor) || hasNear(LINK, source, anchor)) add('third_party_credit_check_risk', anchor);
  }

  const fees = matchesOf(VIEWING_FEE, source);
  if (fees.length) {
    // Recorded per listing; it becomes the harvesting pattern only across
    // independent properties, in assessApplicationFeePattern.
    findings.set('viewing_fee_requested', { reasonCode: 'viewing_fee_requested', polarity: 'risk', dimension: 'payment_risk', independentCount: 1, detail: { offset: fees[0].index }, perListingOnly: true });
  }

  return Object.freeze({ findings: Object.freeze([...findings.values()]), evidenceOnly: true });
}

/**
 * The same property asking for payment to different recipients over time.
 *
 * `observations` are `{ propertyClusterId, recipientKey, observedAt }`, where
 * recipientKey is a keyed hash of the recipient -- never the card or account
 * number itself.
 */
export function assessPaymentDestinations(observations) {
  const byProperty = new Map();
  for (const row of observations ?? []) {
    if (!row?.propertyClusterId || !row?.recipientKey) continue;
    const key = String(row.propertyClusterId);
    const bucket = byProperty.get(key) ?? new Set();
    bucket.add(String(row.recipientKey));
    byProperty.set(key, bucket);
  }
  const changed = [...byProperty.entries()].filter(([, recipients]) => recipients.size > 1);
  if (!changed.length) return Object.freeze({ findings: Object.freeze([]), evidenceOnly: true });
  return Object.freeze({
    findings: Object.freeze([{
      polarity: 'risk',
      reasonCode: 'payment_destination_changed',
      dimension: 'payment_risk',
      independentCount: changed.length,
      detail: { properties: changed.length, maxRecipients: Math.max(...changed.map(([, recipients]) => recipients.size)) },
    }]),
    evidenceOnly: true,
  });
}

/**
 * Viewing fees requested across independent properties. One listing asking a
 * fee may be a misunderstanding or a local custom; the same actor doing it on
 * several unrelated properties is a pattern.
 */
export function assessApplicationFeePattern(listings, options = {}) {
  const minimum = options.minimumProperties ?? MIN_INDEPENDENT_PROPERTIES;
  const properties = new Set();
  for (const row of listings ?? []) {
    if (!row?.viewingFeeRequested) continue;
    properties.add(String(row.propertyClusterId ?? `${row.source} ${row.sourceId}`));
  }
  if (properties.size < minimum) return Object.freeze({ findings: Object.freeze([]), evidenceOnly: true });
  return Object.freeze({
    findings: Object.freeze([{
      polarity: 'risk',
      reasonCode: 'application_fee_harvesting_pattern',
      dimension: 'payment_risk',
      independentCount: properties.size,
      detail: { properties: properties.size },
    }]),
    evidenceOnly: true,
  });
}
