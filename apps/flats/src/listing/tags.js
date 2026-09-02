// Derives human-friendly tags for a listing card from its title + description.
// The multilingual keyword dictionary lives in @whiteslove/parsing-lexicon
// (housing-card-fields) so it stays consistent with the rest of the housing
// text-classification lexicon; only card-specific composition stays here.
import { matchHousingListingKeywordTags } from '@whiteslove/parsing-lexicon/housing-card-fields';

const DEAL_TAGS = { sale: 'for sale', longRent: 'long-term rent', shortRent: 'short-term rent' };
const AUDIENCE_TAGS = { women: 'girls only', men: 'men only', family: 'family' };

export function extractTags({
  title = '',
  description = '',
  byAgency,
  rooms,
  dealType,
  audience,
  district = null,
  nearby = [],
  residenceComplex = null,
  petsAllowed = null,
  childrenAllowed = null,
  roomOnly = false,
  deposit = null,
  commission = null,
  commissionPercent = null,
}) {
  const text = `${title} ${description}`.toLowerCase();
  const tags = [];

  if (rooms) tags.push(`${rooms} rooms`);
  if (dealType && DEAL_TAGS[dealType]) tags.push(DEAL_TAGS[dealType]);
  if (audience && AUDIENCE_TAGS[audience]) tags.push(AUDIENCE_TAGS[audience]);
  tags.push(byAgency ? 'agency' : 'owner');

  // Location context the user asked to surface: residential complex, district,
  // and nearby landmarks / orientation points.
  if (residenceComplex) tags.push(`ЖК ${residenceComplex}`);
  if (district) tags.push(district);
  for (const n of nearby ?? []) tags.push(n);

  // Tenant conditions + costs.
  if (roomOnly) tags.push('room only');
  if (petsAllowed === true) tags.push('pets ok');
  if (childrenAllowed === true) tags.push('children ok');
  if (deposit === true) tags.push('deposit');
  if (commission === false) tags.push('no commission');
  else if (commission === true)
    tags.push(commissionPercent ? `commission ${commissionPercent}%` : 'commission');

  tags.push(...matchHousingListingKeywordTags(text));

  // De-duplicate while preserving order, cap to keep cards tidy.
  return [...new Set(tags)].slice(0, 12);
}
