import { ATTRIBUTION_RULES, EXTRACTION_RULES } from './common.js';

export const APARTMENT_SYSTEM = `${EXTRACTION_RULES}

${ATTRIBUTION_RULES}

You extract structured data about ONE real-estate listing (apartment/house/room).
The text may be in Russian, Uzbek, Kazakh, Ukrainian, Romanian or English, and
may contain typos or transliteration (e.g. "kvartil"->kvartal, "kvadirat"->m²,
"etajli"->storeys). Interpret intent but never guess unstated facts.

- address: the property's OWN address. One with a house number is the best
  case ("Amir Temur ko'chasi 15", "ул. Навои, 12А"), but a thoroughfare on its
  own is a real answer too and should be returned - the pipeline records how
  precise it is. A thoroughfare is not only a street: avenue, boulevard,
  highway, lane, embankment, square and their equivalents in the source
  language all count, in Russian, Ukrainian, Uzbek (Cyrillic or Latin),
  Kazakh, Kyrgyz, English or Romanian - "Metrostroiteley street",
  "Amir Temur ko'chasi", "проспект Амира Темура", "Достық даңғылы",
  "Чүй проспектиси", "вулиця Хрещатик", "Bulevardul Unirii".
  A district, a microdistrict or a metro station is NOT an address; leave it
  null. Never assemble an address out of separate fragments, and never copy
  one that belongs to an agency office, a viewing point or a landmark.
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
