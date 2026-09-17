import { parsePhoneNumbers, normalizeTelegramContact } from '@whiteslove/parsing-lexicon/contact';

/**
 * The stored form of a listing's contact, decided once at ingest.
 *
 *   phone     E.164 ("+998901234567"), read with the listing's country as the
 *             hint, so "90 123 45 67" on an Uzbek listing and
 *             "+998 90 123-45-67" on another become the same value
 *   Telegram  "@username" lower-cased; Telegram usernames are
 *             case-insensitive
 *   other     kept as written (trimmed): an unrecognised contact is still
 *             the advertiser's published contact and must not be dropped
 *
 * Everything keyed on the contact -- contact buttons, the purple "contact has
 * other listings" line, the contact-listings tab, and the cross-source dedupe
 * key, which is built from the phone's digits -- only matches the same person
 * across listings if every listing stores the same form.
 *
 * Phone parsing is the lexicon's; this only chooses the stored form.
 */
export function canonicalListingContact(contact, country) {
  if (contact == null) return null;
  // Some sources hand over a structured contact object; that shape is read
  // elsewhere (the dedupe key looks inside it) and is left untouched.
  if (typeof contact !== 'string') return contact;
  const text = contact.normalize('NFKC').trim();
  if (!text) return null;

  if (text.startsWith('@') || /(?:^|\/\/)(?:www\.)?(?:t\.me|telegram\.me)\//iu.test(text)) {
    const telegram = normalizeTelegramContact(text);
    const username = typeof telegram === 'string' ? telegram : telegram?.username;
    if (username) return `@${String(username).replace(/^@/u, '').toLowerCase()}`;
    return text;
  }

  const countryHint = typeof country === 'string' && /^[A-Za-z]{2}$/u.test(country) ? country.toUpperCase() : undefined;
  const phone = parsePhoneNumbers(text, countryHint ? { countryHint } : {}).find((item) => item.valid);
  return phone ? phone.number : text;
}
