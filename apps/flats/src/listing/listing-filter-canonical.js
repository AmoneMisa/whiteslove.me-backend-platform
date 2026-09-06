import {copyResolvedSearchGeometry} from '../geo/search-filter-geometry.js';

export function canonicalListingFilters(input = {}) {
  if (input.dealType === 'longRent' && input.roomOnly === true) {
    return copyResolvedSearchGeometry(input, {
      ...input,
      dealType: 'roomRent',
      roomOnly: null,
    });
  }
  if (input.dealType === 'roomRent' && input.roomOnly === true) {
    return copyResolvedSearchGeometry(input, {
      ...input,
      roomOnly: null,
    });
  }
  return input;
}
