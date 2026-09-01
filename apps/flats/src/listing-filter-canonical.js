export function canonicalListingFilters(input = {}) {
  if (input.dealType === 'longRent' && input.roomOnly === true) {
    return {
      ...input,
      dealType: 'roomRent',
      roomOnly: null,
    };
  }
  if (input.dealType === 'roomRent' && input.roomOnly === true) {
    return {
      ...input,
      roomOnly: null,
    };
  }
  return input;
}
