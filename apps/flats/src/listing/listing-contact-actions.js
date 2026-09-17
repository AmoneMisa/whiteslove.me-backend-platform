import { contactPointsFromListing } from './contact-points.js';
import { buildContactActions } from '../identity/contact-actions.js';

/**
 * Contact buttons for a listing, so a renter can reach the owner directly.
 *
 * Cheap enough for every feed page: the contact normalize-legacy.js already
 * parsed at ingest (`listing.contact`, E.164 or @username) is used as-is, and
 * the listing text is only re-parsed when no stored contact exists. A page of
 * listings therefore costs a few string checks, not a libphonenumber pass per
 * listing per request.
 *
 * Actions come from the shared builder, so hrefs are scheme-allowlisted and a
 * WhatsApp or Telegram link derived from a phone is marked `linkable`, not
 * presented as a confirmed account.
 */
export function contactPointsForPublicListing(listing) {
  const stored = typeof listing?.contact === 'string' ? listing.contact.trim() : '';
  if (/^\+[1-9]\d{6,14}$/u.test(stored)) return [{ type: 'phone', canonicalValue: stored, availability: 'declared' }];
  if (/^@[A-Za-z0-9_]{5,32}$/u.test(stored)) return [{ type: 'telegram', canonicalValue: stored.slice(1).toLowerCase(), availability: 'declared' }];
  return contactPointsFromListing(listing);
}

/**
 * Attaches `listingLine` and `contactListingCount` to a page of listings from
 * the stored lines the worker computes (platform.listing_lines), so the card
 * shows exactly the line the "Trusted ads" / "Hide danger" filters used.
 *
 * `contactListingCount` is how many other properties the same contact
 * advertises; the popup offers a tab for them when it is above zero.
 *
 * Best effort: if the lookup fails the feed is served without lines rather
 * than failing the search.
 */
export async function attachListingLines(listings, { loadLines, log = console.warn } = {}) {
  if (!Array.isArray(listings) || !listings.length) return listings;
  const ids = listings.map((listing) => Number(listing?.publicId)).filter((id) => Number.isSafeInteger(id) && id > 0);
  if (!ids.length) return listings;
  try {
    const stored = await loadLines(ids);
    return listings.map((listing) => {
      const entry = stored.get(Number(listing?.publicId));
      if (!entry) return listing;
      return {
        ...listing,
        listingLine: entry.line,
        ...(entry.otherProperties > 0 ? { contactListingCount: entry.otherProperties } : {}),
      };
    });
  } catch (error) {
    log(`[listing-line] skipped: ${error?.code ?? error?.name ?? 'error'}`);
    return listings;
  }
}

export function attachContactActions(listing) {
  if (!listing || typeof listing !== 'object') return listing;
  const contactActions = buildContactActions(contactPointsForPublicListing(listing));
  return contactActions.length ? { ...listing, contactActions } : listing;
}
