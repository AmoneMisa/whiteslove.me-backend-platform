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

export function attachContactActions(listing) {
  if (!listing || typeof listing !== 'object') return listing;
  const contactActions = buildContactActions(contactPointsForPublicListing(listing));
  return contactActions.length ? { ...listing, contactActions } : listing;
}
