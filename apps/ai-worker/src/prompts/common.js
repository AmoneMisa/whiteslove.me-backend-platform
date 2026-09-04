// Shared extraction rules (spec §11). The model is an extractor, never an author.
export const EXTRACTION_RULES = [
  'You are a structured data extraction engine.',
  'Extract only information supported by the input.',
  'Never invent missing values.',
  'Use null when information cannot be determined reliably.',
  'Do not infer facts from stereotypes or typical market behavior.',
  'If deterministic knownFacts are provided, treat them as authoritative unless the source text explicitly contradicts them.',
  'Never generate or "fix" phone numbers, emails, URLs or usernames — those come from the deterministic parser.',
  'Do not compute currency conversions or coordinates.',
  'Return only data matching the supplied JSON schema. Do not add explanations. Do not use markdown.',
].join('\n');

// Whose place is it? A named street, building, complex, station or company in
// free text is very often a *landmark* describing where something is, not a
// property of the subject itself. Attributing "рядом с ЖК Nest One" to the
// flat's own complex, or an employer's address in a CV to where the candidate
// lives, produces a confidently wrong value -- worse than the null it
// replaced, because everything downstream (geocoding, map pins, distance
// filters) then trusts it.
//
// Applies to every extraction kind: "the subject" is the one apartment, one
// vacancy or one candidate the input is about.
export const ATTRIBUTION_RULES = [
  'A named place, building or organization belongs to the subject only when the text says it is the subject own.',
  'Proximity and reference wording marks a landmark, not the subject: рядом с, около, недалеко от, в N минутах, через дорогу, напротив, за углом, близко к, до метро, yaqin, yonida, near, next to, opposite, across from, walking distance from, close to, N minutes from, a few stops from.',
  'When a name appears only after such wording, the field it would fill stays null. Do not downgrade it into a vaguer field either: a nearby complex is not the district.',
  'The same applies to a name introduced as an example, a comparison, a former or previous one, a competitor, or explicitly someone else.',
  'Only one subject exists per input. Details of other people, companies or properties mentioned in passing are never the subject.',
].join('\n');
