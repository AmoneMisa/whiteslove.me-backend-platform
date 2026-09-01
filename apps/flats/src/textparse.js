// Compatibility facade: keep the public textparse API while moving shared
// housing semantics into @whiteslove/parsing-lexicon.
export * from './textparse-legacy.js';
export { looksCommercialHousing as looksCommercial } from '@whiteslove/parsing-lexicon/housing-commercial';
export {
  parseHousingRoomsFromText as parseRoomsFromText,
  parseHousingResidentialComplex as parseResidentialComplex,
  parseHousingAreaFromText as parseAreaFromText,
  parseHousingFloorFromText as parseFloor,
} from '@whiteslove/parsing-lexicon/housing-text';

import { parseHousingListingFields } from '@whiteslove/parsing-lexicon';

const fields = (text) => parseHousingListingFields(text);

export function classifyPets(text) { return fields(text).petsAllowed ?? null; }
export function classifyChildren(text) { return fields(text).childrenAllowed ?? null; }
export function parseBedrooms(text) { return fields(text).bedrooms ?? null; }
export function parseBathrooms(text) { return fields(text).bathrooms ?? null; }
export function parseYear(text) { return fields(text).buildingYear ?? null; }
export function parseBalcony(text) { return fields(text).balcony ?? null; }
export function parseAirConditioner(text) { return fields(text).airConditioner ?? null; }
export function parseFurnished(text) { return fields(text).furnished ?? null; }
export function parseGasSupply(text) { return fields(text).gas ?? null; }
export function parseNewBuilding(text) { return fields(text).newBuilding ?? null; }
export function parseCommunalSeparated(text) { return fields(text).communalSeparated ?? null; }
export function parseParking(text) { return fields(text).parking ?? null; }
export function parseElevator(text) { return fields(text).elevator ?? null; }
export function parseHeating(text) { return fields(text).heating ?? null; }
export function parseHotWater(text) { return fields(text).hotWater ?? null; }
export function parseInternet(text) { return fields(text).internet ?? null; }
export function parseSmoking(text) { return fields(text).smokingAllowed ?? null; }
export function parseNegotiable(text) { return fields(text).negotiable ?? null; }
