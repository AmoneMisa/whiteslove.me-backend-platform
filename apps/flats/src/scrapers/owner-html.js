import { resolveHousingIntent } from '@whiteslove/parsing-lexicon/housing-intent';
import { parseHousingSeller } from '@whiteslove/parsing-lexicon/housing-structured';
import { resolveHousingPropertyType } from '@whiteslove/parsing-lexicon/housing';
import { makeListing } from '../listing/normalize.js';
import { parseHousingPrice as parsePriceFromText } from '@whiteslove/parsing-lexicon/housing-money';
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
  'arendator.kg',
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
]);

const HOUSING_RE = /(apartament|garsonier|studio|квартир|квартира|будин|житл|пәтер|uy\b|xona|хона|chirie|rent|оренд|аренд|ijara|жалдау)/iu;
const PRICE_RE = /(?:\$|€|₴|₸|грн|uah|usd|eur|lei|ron|сум|so['’]?m|uzs|сом|kgs|тенге|kzt|\bмлн\b|\bmln\b)/iu;
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

// Some cards (e.g. m2bomber) render the same price re-quoted in every
// supported currency as visible toggle-button text (e.g. "L $ €"), which
// would otherwise confuse price/currency parsing on the flattened text.
const CURRENCY_TOGGLE_RE = /<div\b[^>]*\bclass=["'][^"']*price-currency[^"']*["'][^>]*>[\s\S]*?<\/div>/giu;

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
  if (!HOUSING_RE.test(text) && !/(?:\d+)\s*(?:rooms?|camere|комнат|кімнат|xona|хона)/iu.test(text)) {
    return false;
  }
  if (!PRICE_RE.test(text)) return false;
  if (resolveHousingIntent(text)?.listingKind === 'propertyWanted') return false;
  const parsed = parsePriceFromText(text, country?.currency || '');
  return parsed?.amount != null;
}

function toListing(fragment, text, country, sourceUrl, index, ownerHost) {
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
    city: '',
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
    while ((match = re.exec(html)) && blocks.length < 240) blocks.push(match[0]);
  }
  return blocks;
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
  while ((match = marker.exec(html)) && starts.length < 240) starts.push(match.index);

  const blocks = [];
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : Math.min(html.length, starts[i] + 4000);
    blocks.push(html.slice(starts[i], end));
  }
  return blocks;
}

function textWindows(html) {
  const text = stripHtml(html);
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const windows = [];
  for (let index = 0; index < lines.length && windows.length < 160; index += 1) {
    if (!PRICE_RE.test(lines[index])) continue;
    const start = Math.max(0, index - 5);
    const end = Math.min(lines.length, index + 5);
    const chunk = lines.slice(start, end).join('\n');
    if (chunk.length <= 2200) windows.push(chunk);
  }
  return windows;
}

export function extractKnownOwnerHtml(html, country, sourceUrl) {
  let host;
  try {
    host = new URL(sourceUrl).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return [];
  }
  const ownerHost = OWNER_HOSTS.has(host);
  if (!ownerHost && !MIXED_HOSTS.has(host)) return [];

  const listings = [];
  const seen = new Set();
  const add = (fragment, text) => {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!plausibleCard(normalized, country)) return;
    const key = normalized.toLocaleLowerCase().slice(0, 420);
    if (seen.has(key)) return;
    seen.add(key);
    listings.push(toListing(fragment, normalized, country, sourceUrl, listings.length, ownerHost));
  };

  const divCardClass = DIV_CARD_HOSTS.get(host);
  if (divCardClass) {
    for (const block of divBlocks(String(html || ''), divCardClass)) {
      add(block, stripHtml(block));
      if (listings.length >= 40) break;
    }
  } else {
    for (const block of structuredBlocks(String(html || ''))) {
      add(block, stripHtml(block));
      if (listings.length >= 40) break;
    }
  }

  // Text windows are a last-resort path for catalogues without semantic card
  // wrappers. Running them after even one structured card creates overlapping
  // duplicates around price lines, so never mix the two extraction modes.
  if (listings.length === 0) {
    for (const window of textWindows(String(html || ''))) {
      add('', window);
      if (listings.length >= 40) break;
    }
  }

  return listings;
}
