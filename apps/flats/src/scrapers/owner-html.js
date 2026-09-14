import { resolveHousingIntent } from '@whiteslove/parsing-lexicon/housing-intent';
import { parseHousingSeller } from '@whiteslove/parsing-lexicon/housing-structured';
import { resolveHousingPropertyType } from '@whiteslove/parsing-lexicon/housing';
import { makeListing } from '../listing/normalize.js';
import { parseHousingPrice as parsePriceFromText } from '@whiteslove/parsing-lexicon/housing-money';
import { moneyCurrencyPattern } from '@whiteslove/parsing-lexicon/currency';
import { canonicalCity } from '@whiteslove/parsing-lexicon/geography';
import {
  parseHousingRoomsFromText as parseRoomsFromText,
  parseHousingAreaFromText as parseAreaFromText,
} from '@whiteslove/parsing-lexicon/housing-text';

// Hosts whose entire curated catalogue is owner/direct by source contract.
const OWNER_HOSTS = new Set([
  'rentli.uz',
  'easy-house.in.ua',
  'norieltor.com.ua',
  'dom.ria.com',
  'bezmakler.com.ua',
  'dobalux.com',
  'proprietaripebune.ro',
  'proprietar-direct.ro',
  'directfaracomision.ro',
  'garsoniera.ro',
  'publi24.ro',
  'ostona.app',
  'turar.uz',
  'kn.kz',
  'krisha.kz',
  'kvarto.app',
  'myhouse.kg',
  'sutochno.kg',
]);

// Public SSR catalogues that mix owners, agencies, developers, or aggregators.
// Dedicated owner-filter URLs on these hosts are still enforced downstream by
// the queue task's ownerOnly policy; the host itself must never imply owner.
const MIXED_HOSTS = new Set([
  'uybor.uz',
  'house.kg',
  'lalafo.kg',
  'lun.ua',
  'rieltor.ua',
  'x-estate.com',
  'blagovist.ua',
  'imobiliare.ro',
  'anuntul.ro',
  'lajumate.ro',
  'imobiliare-anunturi.ro',
  // m2bomber runs the same template across every locale it operates in.
  'ro.m2bomber.com',
  'ua.m2bomber.com',
  'kz.m2bomber.com',
  'uz.m2bomber.com',
]);

// Hosts whose listing cards live in <div class="..."> wrappers rather than
// <article>/<li>, keyed by the card's marker class. Kept separate from
// structuredBlocks() so the generic scan never has to guess arbitrary div
// boundaries (unreliable/noisy for hosts we haven't inspected).
const DIV_CARD_HOSTS = new Map([
  ['ro.m2bomber.com', 'item-card-long'],
  ['ua.m2bomber.com', 'item-card-long'],
  ['kz.m2bomber.com', 'item-card-long'],
  ['uz.m2bomber.com', 'item-card-long'],
  ['blagovist.ua', 'search-item'],
  ['rieltor.ua', 'catalog-card'],
  ['myhouse.kg', 'it-grid-item'],
]);

// Hosts whose listing cards are themselves an <a class="..."> wrapper (the
// whole card is a link), keyed by the card's marker class. Unlike the div
// hosts above, these close cleanly with a matching </a>, so they're parsed
// as real balanced blocks instead of the div hosts' next-marker heuristic.
const ANCHOR_CARD_HOSTS = new Map([
  ['ostona.app', 'card'],
]);

// Hosts whose listing cards carry no stable CSS class (e.g. build-hashed
// CSS-in-JS utility classes that regenerate every deploy) but do link to each
// listing through a stable, semantic href pattern. Keyed by a regex matched
// against each <a href="...">; parsed with the same next-marker heuristic as
// DIV_CARD_HOSTS since (unlike ANCHOR_CARD_HOSTS) the card itself isn't the
// anchor tag.
const HREF_CARD_HOSTS = new Map([
  ['uybor.uz', /^\/listings\/\d+(?:[/?#]|$)/i],
  // x-estate.com's React catalogue also uses build-hashed styled-components
  // classes (e.g. "OfferItem__OfferItemContainerLink-sc-1h65yyr-1 fliOdX"),
  // only the /offers/<hex-id> card href stays stable across deploys.
  ['x-estate.com', /^\/offers\/[0-9a-f]+(?:[/?#]|$)/i],
]);

const HOUSING_RE = /(apartament|garsonier|studio|квартир|квартира|будин|житл|пәтер|uy\b|xona|хона|chirie|rent|оренд|аренд|ijara|жалдау)/iu;
// Sourced from the lexicon's own currency term list (money-lexicon.js) rather
// than a hand-copied set of symbols/codes, so a currency form the lexicon
// already knows about (e.g. "у.е.", a common CIS-market USD stand-in) can
// never silently go missing here the way a hand-maintained list did before.
// "млн"/"mln" are added separately since they're a magnitude word, not a
// currency term.
const PRICE_RE = new RegExp(`(?:${moneyCurrencyPattern()}|\\bмлн\\b|\\bmln\\b)`, 'iu');
const BLOCK_END_RE = /<\/(?:article|li|section|div|a|p|h[1-6])>/giu;

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

// Some cards (e.g. m2bomber's "price-currency", blagovist.ua's "m-dollar"/
// "m-euro") render the same price re-quoted in every supported currency as
// visible toggle-button text (e.g. "L $ €", or "1 200 $ (1$=44.81 грн.)"),
// which would otherwise confuse price/currency parsing on the flattened text.
const CURRENCY_TOGGLE_RE = /<div\b[^>]*\bclass=["'][^"']*(?:price-currency|m-dollar|m-euro)[^"']*["'][^>]*>[\s\S]*?<\/div>/giu;

// Agency catalogues (e.g. blagovist.ua) commonly print an internal reference
// code next to the card ("Код объекта: G-305826"). That code is an arbitrary
// listing id, not a price, but a bare multi-digit id can otherwise outrank
// the real (currency-suffixed) price in the shared lexicon's bare-amount
// fallback once anything breaks the explicit-currency match — e.g. a
// regulatory disclaimer asterisk right after the amount ("53 800* грн.").
const LISTING_CODE_RE = /(?:код\s*об[ъ'’ʼ]?[еє]кта|object\s*code)\s*:?\s*\S+/giu;

function stripHtml(fragment) {
  return decodeHtml(
    String(fragment || '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
      .replace(CURRENCY_TOGGLE_RE, ' ')
      .replace(BLOCK_END_RE, '\n')
      .replace(/<br\s*\/?>/giu, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .replace(LISTING_CODE_RE, ' ')
    .trim();
}

function hash(value) {
  let h = 5381;
  for (const char of String(value || '')) {
    h = ((h << 5) + h + char.codePointAt(0)) >>> 0;
  }
  return h.toString(36);
}

function absoluteUrl(raw, sourceUrl) {
  if (!raw || /^(?:javascript:|mailto:|tel:|#)/i.test(raw)) return null;
  try {
    return new URL(decodeHtml(raw), sourceUrl).href;
  } catch {
    return null;
  }
}

function firstHref(fragment, sourceUrl) {
  const match = String(fragment || '').match(/<a\b[^>]*href=["']([^"']+)["']/iu);
  return absoluteUrl(match?.[1], sourceUrl);
}

function images(fragment, sourceUrl) {
  const result = [];
  const re = /<img\b[^>]*(?:src|data-src)=["']([^"']+)["'][^>]*>/giu;
  let match;
  while ((match = re.exec(String(fragment || ''))) && result.length < 12) {
    const url = absoluteUrl(match[1], sourceUrl);
    if (url && /^https?:\/\//i.test(url) && !result.includes(url)) result.push(url);
  }
  return result;
}

// Some catalogues tag each card with its own city explicitly (dobalux.com
// renders <a class="card-city-link">Київ</a> per card), which is both cheap
// to read and far more reliable than inferring a city from free text.
const CARD_CITY_LINK_RE = /<a\b[^>]*\bclass=["'][^"']*\bcard-city-link\b[^"']*["'][^>]*>([^<]+)<\/a>/iu;

function cityFromCardLink(fragment) {
  const match = String(fragment || '').match(CARD_CITY_LINK_RE);
  return match ? decodeHtml(match[1]).trim() : null;
}

// Ukrainian catalogues commonly render a card's address as
// "<Район> ,  м. <Місто>" (norieltor.com.ua and others). The comma before
// "м." is what distinguishes this from an unrelated "м. <metro station>"
// mention elsewhere in the same card (e.g. "м. Харківська, (1000 м)" for a
// subway stop), so it is required, not optional. The capture stops at the
// first non-letter (space, comma, digit) rather than running to the next
// comma: once whitespace-normalized to one line, that city is immediately
// followed by more card text with nothing but a space between them (e.g.
// "м. Київ м. Харківська" for the metro-station mention above), so a wider
// capture would swallow that trailing text as part of the city name.
const UA_CITY_MARKER_RE = /,\s*м\.\s*(\p{Lu}[\p{L}''’-]*)/u;

function cityFromUaMarker(text) {
  const match = String(text || '').match(UA_CITY_MARKER_RE);
  return match ? match[1].trim() : null;
}

// Some catalogues encode the city directly in a URL path segment: either the
// card's own href (ro.m2bomber.com: "/obj/<id>/view/flat-rent/ramnicu-valcea-
// <ids>/...") or the search page's own URL (anuntul.ro: ".../particular-
// bucuresti/", imobiliare-anunturi.ro: ".../bucuresti/proprietar"). Testing
// every short run of path tokens against the lexicon's own (small) city
// catalog is cheap — a URL path has a handful of tokens, nothing like
// scanning free text against a country's full district/street dictionary.
function cityFromUrlPath(pathname, countryCode) {
  const tokens = String(pathname || '').split(/[/-]+/u).filter(Boolean);
  for (let start = 0; start < tokens.length; start += 1) {
    for (let len = Math.min(3, tokens.length - start); len >= 1; len -= 1) {
      const candidate = tokens.slice(start, start + len).join('-');
      if (/^\d+$/.test(candidate)) continue;
      const canonical = canonicalCity(candidate, countryCode);
      if (canonical) return canonical;
    }
  }
  return null;
}

function cityFromUrl(url, countryCode) {
  try {
    return cityFromUrlPath(new URL(url).pathname, countryCode);
  } catch {
    return null;
  }
}

function heading(fragment, fallbackText) {
  const raw = String(fragment || '');
  const headingMatch = raw.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/iu);
  // Some catalogues (e.g. m2bomber) put the card title in a plain link with a
  // "title" class instead of a heading tag.
  const titleLinkMatch = raw.match(/<a\b[^>]*\bclass=["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/iu);
  const value =
    stripHtml(headingMatch?.[1] || '')
    || stripHtml(titleLinkMatch?.[1] || '')
    || String(fallbackText || '').split('\n')[0];
  return value.trim().slice(0, 120) || 'Listing';
}

function plausibleCard(text, country) {
  if (!text || text.length < 18 || text.length > 2200) return false;
  // "3-room" (a hyphen, not whitespace, between the digit and the word) is
  // common English card copy (e.g. ostona.app); accept either separator.
  if (!HOUSING_RE.test(text) && !/(?:\d+)[\s-]*(?:rooms?|camere|комнат|кімнат|xona|хона)/iu.test(text)) {
    return false;
  }
  if (!PRICE_RE.test(text)) return false;
  if (resolveHousingIntent(text)?.listingKind === 'propertyWanted') return false;
  const parsed = parsePriceFromText(text, country?.currency || '');
  return parsed?.amount != null;
}

function toListing(fragment, text, country, sourceUrl, index, ownerHost, sourceDealType, city) {
  const parsedPrice = parsePriceFromText(text, country?.currency || '');
  const url = firstHref(fragment, sourceUrl) || sourceUrl;
  const agency = !ownerHost && parseHousingSeller(text).type === 'agency';
  return makeListing({
    id: `owner-${hash(`${sourceUrl}|${url}|${text.slice(0, 320)}|${index}`)}`,
    source: 'custom',
    country: country.code,
    title: heading(fragment, text),
    description: text,
    propertyType: resolveHousingPropertyType(text),
    // The catalogue's declared deal type is source evidence, not a verdict:
    // normalization still lets explicit short-stay wording in the card win.
    dealType: sourceDealType ?? null,
    // Owner-only hosts keep their source contract. Mixed hosts only set true
    // when an explicit realtor/agency signal exists; otherwise normalization is
    // free to apply shared seller semantics instead of us inventing an owner.
    byAgency: ownerHost ? false : (agency ? true : undefined),
    commission: ownerHost ? false : undefined,
    commissionPercent: ownerHost ? 0 : undefined,
    price: parsedPrice.amount,
    currency: parsedPrice.currency || country.currency,
    rooms: parseRoomsFromText(text),
    areaSqm: parseAreaFromText(text),
    city: city || '',
    lat: null,
    lng: null,
    photos: images(fragment, sourceUrl),
    url,
    createdAt: null,
  });
}

function structuredBlocks(html) {
  const blocks = [];
  for (const tag of ['article', 'li']) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'giu');
    let match;
    while ((match = re.exec(html))) blocks.push(match[0]);
  }
  return blocks;
}

// The page's last card has no following marker to bound it, so it falls back
// to a fixed-size window instead. Landing that cutoff mid-tag (e.g. inside a
// long image srcset — routine on catalogues with multi-resolution photo
// carousels) leaves a dangling unclosed tag that stripHtml's </tag> regex can
// never match, so the whole trailing fragment survives as unstrippable raw
// markup and reliably fails plausibleCard — silently dropping the last card
// on every page. Retreat to the last complete '>' at or before the cap so the
// slice always ends on a clean tag boundary instead.
//
// The cap itself has to be generous: a card's real title/price/address text
// routinely sits tens of thousands of raw characters into the card on hosts
// whose cards open with a large multi-resolution photo-gallery block (e.g.
// rieltor.ua — observed real cards run ~35-37KB, with the first visible text
// only starting around raw offset ~20KB). A too-small cap silently drops the
// text-bearing tail of the page's last card even after the tag-boundary fix
// above, since there's simply nothing usable within the window. 60000 covers
// every host's card size seen so far with margin; plausibleCard's own 2200-
// char post-strip cap still bounds how much of that ever becomes a listing.
const LAST_BLOCK_CAP = 60_000;

function lastBlockEnd(html, start, cap) {
  const limit = Math.min(html.length, start + cap);
  const lastClose = html.lastIndexOf('>', limit);
  return lastClose > start ? lastClose + 1 : limit;
}

// Cards on DIV_CARD_HOSTS aren't wrapped in a single well-nested tag, so
// instead of balanced parsing we slice the page at each card's marker <div>
// up to the next one — good enough once fed through stripHtml + plausibleCard.
function divBlocks(html, cardClass) {
  const marker = new RegExp(
    `<div\\b[^>]*\\bclass=["'][^"']*(?<![\\w-])${cardClass}(?![\\w-])[^"']*["']`,
    'giu',
  );
  const starts = [];
  let match;
  while ((match = marker.exec(html))) starts.push(match.index);

  const blocks = [];
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : lastBlockEnd(html, starts[i], LAST_BLOCK_CAP);
    blocks.push(html.slice(starts[i], end));
  }
  return blocks;
}

// Cards on HREF_CARD_HOSTS have no stable class to key off, only a stable
// href pattern (which can appear more than once per card, e.g. one <a> around
// the thumbnail and another around the title). Slicing marker-to-marker still
// works: a marker whose next sibling marker is the *same* listing produces a
// near-empty, plausibleCard-rejected block, and the one that reaches the next
// listing's first marker captures that card's real content.
function hrefMarkerBlocks(html, hrefPattern) {
  const marker = /<a\b[^>]*\bhref=["']([^"']+)["']/giu;
  const starts = [];
  let match;
  while ((match = marker.exec(html))) {
    if (hrefPattern.test(decodeHtml(match[1]))) starts.push(match.index);
  }

  const blocks = [];
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : lastBlockEnd(html, starts[i], LAST_BLOCK_CAP);
    blocks.push(html.slice(starts[i], end));
  }
  return blocks;
}

// Cards on ANCHOR_CARD_HOSTS are the <a> tag itself, closing cleanly with a
// matching </a> (no nested anchors inside), so a non-greedy match up to the
// next </a> pairs correctly — unlike DIV_CARD_HOSTS' unbounded div wrappers.
function anchorBlocks(html, cardClass) {
  const re = new RegExp(
    `<a\\b[^>]*\\bclass=["'][^"']*(?<![\\w-])${cardClass}(?![\\w-])[^"']*["'][^>]*>[\\s\\S]*?<\\/a>`,
    'giu',
  );
  const blocks = [];
  let match;
  while ((match = re.exec(html))) blocks.push(match[0]);
  return blocks;
}

function textWindows(html) {
  const text = stripHtml(html);
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const windows = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!PRICE_RE.test(lines[index])) continue;
    const start = Math.max(0, index - 5);
    const end = Math.min(lines.length, index + 5);
    const chunk = lines.slice(start, end).join('\n');
    if (chunk.length <= 2200) windows.push(chunk);
  }
  return windows;
}

export function extractKnownOwnerHtml(html, country, sourceUrl, sourceDealType = null) {
  let host;
  try {
    host = new URL(sourceUrl).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return [];
  }
  const ownerHost = OWNER_HOSTS.has(host);
  if (!ownerHost && !MIXED_HOSTS.has(host)) return [];

  // Catalogues whose URL scopes the whole page to one city (anuntul.ro:
  // ".../particular-bucuresti/", imobiliare-anunturi.ro: ".../bucuresti/
  // proprietar") apply that city to every card that has no more specific
  // per-card signal of its own. Computed once — it's a handful of cheap
  // lexicon lookups against a single short URL, not a per-card cost.
  const pageCity = cityFromUrl(sourceUrl, country?.code);

  const listings = [];
  const seen = new Set();
  const add = (fragment, text) => {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!plausibleCard(normalized, country)) return;
    const key = normalized.toLocaleLowerCase().slice(0, 420);
    if (seen.has(key)) return;
    seen.add(key);
    const cardHref = firstHref(fragment, sourceUrl);
    const city = cityFromCardLink(fragment)
      || (cardHref && cityFromUrl(cardHref, country?.code))
      || cityFromUaMarker(normalized)
      || pageCity;
    listings.push(
      toListing(fragment, normalized, country, sourceUrl, listings.length, ownerHost, sourceDealType, city),
    );
  };

  // Every card on the page is read. Result volume is not a crawl boundary
  // (AGENTS.md); how far the catalogue is traversed is the crawler's decision,
  // not this extractor's.
  const divCardClass = DIV_CARD_HOSTS.get(host);
  const anchorCardClass = ANCHOR_CARD_HOSTS.get(host);
  const hrefCardPattern = HREF_CARD_HOSTS.get(host);
  if (divCardClass) {
    for (const block of divBlocks(String(html || ''), divCardClass)) {
      add(block, stripHtml(block));
    }
  } else if (anchorCardClass) {
    for (const block of anchorBlocks(String(html || ''), anchorCardClass)) {
      add(block, stripHtml(block));
    }
  } else if (hrefCardPattern) {
    for (const block of hrefMarkerBlocks(String(html || ''), hrefCardPattern)) {
      add(block, stripHtml(block));
    }
  } else {
    for (const block of structuredBlocks(String(html || ''))) {
      add(block, stripHtml(block));
    }
  }

  // Text windows are a last-resort path for catalogues without semantic card
  // wrappers. Running them after even one structured card creates overlapping
  // duplicates around price lines, so never mix the two extraction modes.
  if (listings.length === 0) {
    for (const window of textWindows(String(html || ''))) {
      add('', window);
    }
  }

  return listings;
}
