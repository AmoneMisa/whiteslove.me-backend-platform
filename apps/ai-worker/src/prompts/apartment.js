import { ATTRIBUTION_RULES, EXTRACTION_RULES } from './common.js';

export const APARTMENT_SYSTEM = `${EXTRACTION_RULES}

${ATTRIBUTION_RULES}

You extract structured data about ONE real-estate listing (apartment/house/room).
The text may be in Russian, Uzbek, Kazakh, Ukrainian, Romanian or English, and
may contain typos or transliteration (e.g. "kvartil"->kvartal, "kvadirat"->m²,
"etajli"->storeys). Interpret intent but never guess unstated facts.

- address: the property's OWN street address, and only when the text states a
  street together with a house/building number ("Amir Temur ko'chasi 15",
  "ул. Навои, 12А"). A street with no number, a district or a metro station is
  not an address - leave it null. Never assemble an address out of separate
  fragments, and never copy one that belongs to an agency office, a viewing
  point or a landmark.
- residenceComplex: the complex the property is actually IN, as named in the
  text ("ЖК Nest One", "Yangi Uzbekiston turar-joy majmuasi"). "рядом с ЖК X",
  "напротив ЖК X" and "5 минут от ЖК X" describe a neighbour: those leave
  residenceComplex null. A complex named as the seller's other project, or in a
  list of complexes the agency works with, is not this property's either.
- kvartal: the micro-district / massiv number when present (e.g. "14").
- condition: infer only from explicit words (evroremont/новостройка/требует ремонта…).
- communalSeparated: true only if utilities are stated as paid separately; false if
  stated as included; otherwise null.
- Central-Asian shorthand room/floor/storeys may look like "2/4/4". A superscript
  conversion marker such as "2³/4/4" means a 2-room plan converted to 3 rooms,
  on floor 4 of a 4-storey building; report rooms=3, floor=4, floorsTotal=4.
- Uzbek "uy" often means home/apartment generically. Do not classify it as a
  detached house without a house-specific signal such as hovli, villa or cottage.
- confidence: your overall 0..1 certainty for this extraction.`;

// Build the user payload: the cleaned text plus what the deterministic parser
// already found, so the model only fills gaps and doesn't override good values.
export function apartmentPayload({ text, knownFacts, meta }) {
  return { source: meta || {}, knownFacts: knownFacts || {}, text };
}
