import { createProvenance, shouldReplaceProvenance, isDeterministic } from '@whiteslove/parsing-lexicon/provenance';

/**
 * Which tier supplied each parsed listing field.
 *
 * enrichListingDetails picks values with `??` chains whose order already
 * encodes a priority -- a source site's own metadata before a value parsed out
 * of the description, and so on. That priority was implicit in the order of
 * the operands and invisible afterwards, so nothing downstream could tell a
 * structured value from a guess, and AI enrichment had no principled rule for
 * what it was allowed to overwrite.
 *
 * `chooseField` makes the same choice the `??` chain made -- first operand
 * that is neither null nor undefined -- while recording which one won.
 */

export const FIELD_SOURCES = Object.freeze({
  /** The source site's own structured metadata. */
  structured: 'structured_api',
  /** A per-source adapter that knows that site's markup. */
  adapter: 'source_adapter',
  /** An explicitly labelled field inside the text ("Площадь: 42"). */
  labelled: 'labelled_field',
  /** Parsed out of free-text title/description. */
  description: 'description',
  /** Produced by a model. */
  ai: 'ai_enrichment',
});

/**
 * First option with a usable value, plus its provenance.
 *
 * Matches `??` semantics exactly: only null and undefined are skipped, so a
 * legitimate 0 or false still wins. Changing that would silently alter values
 * this function is only supposed to annotate.
 */
export function chooseField(...options) {
  for (const option of options) {
    if (!option) continue;
    const { value } = option;
    if (value === null || value === undefined) continue;
    return {
      value,
      provenance: createProvenance({
        source: option.source ?? FIELD_SOURCES.description,
        ...(option.parser ? { parser: option.parser } : {}),
        ...(option.confidence === undefined ? {} : { confidence: option.confidence }),
        ...(option.observedAt ? { observedAt: option.observedAt } : {}),
      }),
    };
  }
  return { value: null, provenance: null };
}

/** Collects chooseField results into `{ field: provenance }`. */
export function collectFieldProvenance(entries) {
  const provenance = {};
  for (const [field, chosen] of Object.entries(entries)) {
    if (chosen?.provenance) provenance[field] = chosen.provenance;
  }
  return Object.freeze(provenance);
}

/**
 * Whether an AI-produced value may be written over what is already stored.
 *
 * The rule the whole tier ordering exists for: AI enrichment may fill a field
 * nothing deterministic established, and may replace an earlier AI guess, but
 * must never overwrite a structured, adapter, labelled or description-parsed
 * value however confident it claims to be.
 */
export function mayAiOverwrite(existingProvenance) {
  if (!existingProvenance) return true;
  return !isDeterministic(existingProvenance);
}

/** Shared guard for any incoming field value carrying its own provenance. */
export function mayReplaceField(existingProvenance, incomingProvenance) {
  return shouldReplaceProvenance(existingProvenance, incomingProvenance);
}
