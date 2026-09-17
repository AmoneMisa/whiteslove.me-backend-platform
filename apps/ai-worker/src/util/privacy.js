// Contacts are extracted deterministically by the caller and passed separately
// in knownFacts. They are not needed for semantic enrichment, so keep them out
// of the model prompt while preserving punctuation that matters to vacancies
// and listings (C#, C++, .NET, prices, floor notation, etc.).
export function redactContacts(text) {
  return String(text ?? '')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[EMAIL]')
    .replace(/(?:https?:\/\/|www\.)\S+/giu, '[URL]')
    .replace(/(?<![\p{L}\p{N}_])@[A-Za-z][A-Za-z0-9_]{3,31}\b/gu, '[TELEGRAM]')
    .replace(/(?<!\w)(?:\+?\d[\d\s().-]{7,}\d)(?!\w)/g, '[PHONE]');
}

// The same contact shapes redactContacts removes, in the order it applies
// them: an email or URL can contain an @handle or digits, so those go first.
const CONTACT_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
  /(?:https?:\/\/|www\.)\S+/giu,
  /(?<![\p{L}\p{N}_])@[A-Za-z][A-Za-z0-9_]{3,31}\b/gu,
  /(?<!\w)(?:\+?\d[\d\s().-]{7,}\d)(?!\w)/g,
];

/** Placeholder a translator is told to keep verbatim. Digits only inside
 * double brackets, so no language has a word to translate it into. */
const placeholder = (index) => `[[${index}]]`;
/** Translators sometimes add spaces inside the brackets; tolerate that. */
const PLACEHOLDER_RE = /\[\s*\[\s*(\d{1,4})\s*\]\s*\]/gu;

/**
 * Replaces contacts with numbered placeholders for text whose output a person
 * reads (translation), where contacts must come back, unlike redaction.
 *
 * Returns the masked text and restore(), which puts the originals back into
 * the translated text. A contact whose placeholder the translator dropped is
 * appended on its own line: losing an advertiser's phone number from the
 * translated listing would be worse than an extra line.
 */
export function maskContacts(text) {
  const values = [];
  let masked = String(text ?? '');
  for (const pattern of CONTACT_PATTERNS) {
    masked = masked.replace(pattern, (match) => {
      values.push(match);
      return placeholder(values.length);
    });
  }
  return {
    text: masked,
    count: values.length,
    restore(translated) {
      const seen = new Set();
      const restored = String(translated ?? '').replace(PLACEHOLDER_RE, (match, number) => {
        const index = Number(number);
        const value = values[index - 1];
        if (value === undefined) return match;
        seen.add(index);
        return value;
      });
      const missing = values.filter((_, i) => !seen.has(i + 1));
      return missing.length ? `${restored}\n${missing.join('\n')}` : restored;
    },
  };
}
