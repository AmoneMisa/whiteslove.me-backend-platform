import { parseHousingListingFields } from '@whiteslove/parsing-lexicon';

const fields = (text) => parseHousingListingFields(text);

export function parseDishwasher(text) { return fields(text).dishwasher ?? null; }
export function parseTerrace(text) { return fields(text).terrace ?? null; }
export function parsePrivateYard(text) { return fields(text).privateYard ?? null; }
