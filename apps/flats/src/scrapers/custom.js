// Generic custom-source adapter.
//
// Lets a user point the app at an arbitrary real-estate URL (a listing page, a
// search results page, or an RSS/Atom feed) and pulls listings out of whatever
// structured data the page exposes:
//   1. schema.org JSON-LD  (<script type="application/ld+json">)
//   2. RSS / Atom feed items
//   3. conservative SSR card extraction for allowlisted housing catalogues
//
// It deliberately does NOT try to scrape login-walled, JS-rendered, or bot-
// protected platforms (Facebook, Instagram, Airbnb, Booking, Agoda, …): those
// return nothing useful server-side, so we surface a clear error instead.
//
// SSRF-safe: only http/https, and every requested/redirected host must resolve
// exclusively to public IPs (no loopback / private / link-local ranges).

import dns from 'node:dns/promises';
import net from 'node:net';
import { makeListing } from '../listing/normalize.js';
import { parseHousingSeller } from '@whiteslove/parsing-lexicon/housing-structured';
import { fetchChannel } from './telegram.js';
import { extractKnownOwnerHtml } from './owner-html.js';

const FETCH_TIMEOUT_MS = 12_000;
const DOMZA_FETCH_TIMEOUT_MS = 20_000;
const DOMZA_DETAIL_CONCURRENCY = 6;
const MAX_REDIRECTS = 5;
const MAX_BYTES = 4 * 1024 * 1024; // cap the response we'll parse (4 MB)
const MAX_ITEMS = 40;

// A realistic browser UA — many sites 403 an obvious bot UA outright.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

class SourceError extends Error {}

// ---- SSRF guard ------------------------------------------------------------

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;
    if (a === 127) return true; // loopback
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  const lc = ip.toLowerCase();
  if (lc === '::1' || lc === '::') return true; // loopback / unspecified
  if (lc.startsWith('fe80')) return true; // link-local
  if (lc.startsWith('fc') || lc.startsWith('fd')) return true; // unique local
  // IPv4-mapped IPv6 (::ffff:a.b.c.d)
  const mapped = lc.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);
  return false;
}

// Parse + validate the URL, then confirm every resolved address is public.
async function assertSafeUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new SourceError('Invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new SourceError('Only http(s) URLs are supported');
  }
  const host = u.hostname;
  // A literal IP in the URL is checked directly; a hostname is resolved.
  let addrs;
  if (net.isIP(host)) {
    addrs = [host];
  } else {
    try {
      const recs = await dns.lookup(host, { all: true });
      addrs = recs.map((r) => r.address);
    } catch {
      throw new SourceError('Could not resolve host');
    }
  }
  if (!addrs.length) throw new SourceError('Could not resolve host');
  if (addrs.some(isPrivateIp)) {
    throw new SourceError('URL resolves to a private address');
  }
  return u;
}

async function fetchText(u, timeoutMs = FETCH_TIMEOUT_MS) {
  const startedAt = Date.now();
  let current = u;
  let res = null;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) throw new SourceError('Source timed out');

    try {
      res = await fetch(current.href, {
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en,ru;q=0.8',
        },
        // Never let fetch follow a redirect before we validate its destination.
        redirect: 'manual',
        signal: AbortSignal.timeout(remainingMs),
      });
    } catch (e) {
      if (e.name === 'TimeoutError') throw new SourceError('Source timed out');
      throw new SourceError('Could not reach source');
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      try {
        await res.body?.cancel?.();
      } catch {}
      if (!location) throw new SourceError('Source returned an invalid redirect');
      if (redirectCount >= MAX_REDIRECTS) {
        throw new SourceError('Source redirected too many times');
      }
      current = await assertSafeUrl(new URL(location, current).href);
      continue;
    }
    break;
  }

  if (!res) throw new SourceError('Could not reach source');
  if (res.status === 401 || res.status === 403) {
    throw new SourceError('Source blocked automated access');
  }
  if (!res.ok) throw new SourceError(`Source returned HTTP ${res.status}`);

  // Read with a byte cap so a huge page can't blow up memory.
  const reader = res.body?.getReader?.();
  if (!reader) return (await res.text()).slice(0, MAX_BYTES);
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    chunks.push(value);
    if (total >= MAX_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      break;
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

// ---- extraction ------------------------------------------------------------

// Flatten JSON-LD graphs (@graph / arrays) into a flat list of typed nodes.
function flattenLd(node, out) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const n of node) flattenLd(n, out);
    return;
  }
  if (typeof node !== 'object') return;
  if (Array.isArray(node['@graph'])) flattenLd(node['@graph'], out);
  if (node['@type']) out.push(node);
}

const LISTING_TYPES = new Set([
  'realestatelisting',
  'apartment',
  'house',
  'singlefamilyresidence',
  'residence',
  'accommodation',
  'lodgingbusiness',
  'hotel',
  'product',
  'offer',
  'place',
]);

function ldType(node) {
  const t = node['@type'];
  const arr = Array.isArray(t) ? t : [t];
  return arr.map((x) => String(x).toLowerCase());
}

function firstOffer(node) {
  let o = node.offers ?? node;
  if (Array.isArray(o)) o = o[0];
  return o && typeof o === 'object' ? o : {};
}

function collectImages(node) {
  const raw = node.image ?? node.photo ?? node.images;
  const out = [];
  const add = (v) => {
    if (!v) return;
    if (typeof v === 'string') out.push(v);
    else if (typeof v === 'object' && v.url) out.push(v.url);
  };
  if (Array.isArray(raw)) raw.forEach(add);
  else add(raw);
  return out.filter((s) => /^https?:\/\//i.test(s));
}

function numFrom(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function structuredAddress(node, country) {
  const raw = node.address ?? {};
  const address = raw && typeof raw === 'object' ? raw : {};
  const locality = String(address.addressLocality ?? node.addressLocality ?? '').trim();
  const region = String(address.addressRegion ?? node.addressRegion ?? '').trim();

  // Domza uses schema.org addressLocality for the Tashkent district and
  // addressRegion for the city (e.g. "Яккасарайский район" / "город Ташкент").
  // Preserve that structured district instead of letting it become the city.
  const localityIsDistrict = country.code === 'UZ' &&
    /(?:район|tumani|tuman|district)/iu.test(locality);

  return {
    city: localityIsDistrict ? (region || locality) : (locality || region),
    district: localityIsDistrict ? locality : null,
  };
}

function sellerText(node, offer) {
  const names = [
    node.name,
    node.headline,
    node.description,
    node.seller?.name,
    node.provider?.name,
    node.author?.name,
    offer.seller?.name,
    offer.offeredBy?.name,
  ];
  return names.map((value) => String(value || '')).filter(Boolean).join(' ');
}

function mapLdNode(node, country, sourceUrl, idx) {
  const offer = firstOffer(node);
  const price = numFrom(offer.price ?? offer.lowPrice ?? node.price);
  const currency = offer.priceCurrency ?? node.priceCurrency ?? country.currency;
  const address = structuredAddress(node, country);
  const geo = node.geo ?? {};
  const area =
    numFrom(node.floorSize?.value ?? node.floorSize) ?? numFrom(node.area?.value);
  const url =
    (typeof node.url === 'string' && node.url) ||
    (typeof offer.url === 'string' && offer.url) ||
    sourceUrl;
  const agency = parseHousingSeller(sellerText(node, offer)).type === 'agency';

  return makeListing({
    id: `custom-${hash(sourceUrl + '|' + url + '|' + idx)}`,
    source: 'custom',
    country: country.code,
    title: node.name ?? node.headline ?? 'Listing',
    description: node.description ?? '',
    propertyType: ldType(node).includes('house') ? 'house' : 'flat',
    // Generic structured data is not owner-only. Preserve an explicit agency
    // signal and otherwise let makeListing/shared lexicon infer the seller.
    byAgency: agency ? true : undefined,
    price,
    currency,
    rooms: numFrom(node.numberOfRooms ?? node.numberOfBedroomsTotal),
    areaSqm: area,
    city: String(address.city || ''),
    district: address.district || null,
    lat: numFrom(geo.latitude),
    lng: numFrom(geo.longitude),
    photos: collectImages(node),
    url,
    createdAt: node.datePosted ?? node.dateCreated ?? null,
  });
}

function extractJsonLd(html, country, sourceUrl) {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const nodes = [];
  let m;
  while ((m = re.exec(html))) {
    let json;
    try {
      json = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    flattenLd(json, nodes);
  }
  const listings = [];
  let idx = 0;
  for (const node of nodes) {
    if (!ldType(node).some((t) => LISTING_TYPES.has(t))) continue;
    // A bare Offer with no price/name is noise; require something usable.
    if (!node.name && !node.offers && node.price == null) continue;
    listings.push(mapLdNode(node, country, sourceUrl, idx++));
    if (listings.length >= MAX_ITEMS) break;
  }
  return listings;
}

// Minimal RSS/Atom item extraction.
function extractFeed(xml, country, sourceUrl) {
  const isFeed = /<rss[\s>]|<feed[\s>]/i.test(xml);
  if (!isFeed) return [];
  const items = [];
  const itemRe = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
  let m;
  while ((m = itemRe.exec(xml)) && items.length < MAX_ITEMS) {
    const block = m[0];
    const title = tag(block, 'title') || 'Listing';
    const link =
      tag(block, 'link') || attr(block, 'link', 'href') || sourceUrl;
    const desc =
      tag(block, 'description') || tag(block, 'summary') || tag(block, 'content') || '';
    const date = tag(block, 'pubDate') || tag(block, 'updated') || null;
    const decodedTitle = decodeXml(title);
    const decodedDesc = decodeXml(desc);
    items.push(
      makeListing({
        id: `custom-${hash(sourceUrl + '|' + link + '|' + items.length)}`,
        source: 'custom',
        country: country.code,
        title: decodedTitle,
        description: decodedDesc,
        propertyType: 'flat',
        byAgency: parseHousingSeller(`${decodedTitle} ${decodedDesc}`).type === 'agency' ? true : undefined,
        price: null,
        currency: country.currency,
        city: '',
        lat: null,
        lng: null,
        url: link.trim(),
        createdAt: date ? safeDate(date) : null,
      }),
    );
  }
  return items;
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  if (!m) return '';
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

function attr(block, name, a) {
  const m = block.match(new RegExp(`<${name}\\b[^>]*\\b${a}=["']([^"']+)["']`, 'i'));
  return m ? m[1] : '';
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function safeDate(s) {
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// Tiny stable hash for deterministic ids (djb2).
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// ---- Domza -----------------------------------------------------------------

function isDomzaHost(u) {
  return u.hostname.replace(/^www\./, '').toLowerCase() === 'domza.uz';
}

function isDomzaCatalogUrl(u) {
  return isDomzaHost(u) && /^\/offers\/?$/i.test(u.pathname);
}

function extractDomzaOfferUrls(html, sourceUrl) {
  const urls = [];
  const seen = new Set();
  const hrefRe = /href=["']([^"']+)["']/gi;
  let match;

  while ((match = hrefRe.exec(html)) && urls.length < MAX_ITEMS) {
    let url;
    try {
      url = new URL(decodeXml(match[1]), sourceUrl);
    } catch {
      continue;
    }

    if (!isDomzaHost(url)) continue;
    if (!/^\/offers\/[^/?#]+\/?$/i.test(url.pathname)) continue;
    url.search = '';
    url.hash = '';

    const key = url.href.replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(key);
  }

  return urls;
}

async function concurrentMap(values, concurrency, mapper) {
  const results = new Array(values.length);
  let cursor = 0;

  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= values.length) return;
      try {
        results[index] = await mapper(values[index], index);
      } catch {
        // One stale/removed offer must not fail the whole Domza crawl.
        results[index] = [];
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

async function scrapeDomzaCatalog(safe, country) {
  const body = await fetchText(safe, DOMZA_FETCH_TIMEOUT_MS);
  const offerUrls = extractDomzaOfferUrls(body, safe.href);
  if (!offerUrls.length) {
    throw new SourceError('No Domza offer links found in the catalog');
  }

  const groups = await concurrentMap(
    offerUrls,
    DOMZA_DETAIL_CONCURRENCY,
    async (url) => {
      const detailUrl = await assertSafeUrl(url);
      const detailBody = await fetchText(detailUrl, DOMZA_FETCH_TIMEOUT_MS);
      return extractJsonLd(detailBody, country, detailUrl.href)
        .filter((listing) => /^https:\/\/(?:www\.)?domza\.uz\/offers\//i.test(listing.url || ''));
    },
  );

  const listings = groups.flat().slice(0, MAX_ITEMS);
  if (!listings.length) {
    throw new SourceError('Domza offer pages did not expose readable RealEstateListing JSON-LD');
  }
  return listings;
}

// ---- public API ------------------------------------------------------------

// Identify well-known social platforms so we can use a dedicated reader instead
// of the generic JSON-LD/feed path (which those sites don't expose).
function detectPlatform(u) {
  const h = u.hostname.replace(/^www\./, '').toLowerCase();
  if (h === 't.me' || h === 'telegram.me') return 'telegram';
  if (h === 'facebook.com' || h.endsWith('.facebook.com') || h === 'fb.com') return 'facebook';
  return 'generic';
}

// t.me/<channel> or t.me/s/<channel>[/123] -> read the public channel preview.
async function scrapeTelegramUrl(u, country) {
  const seg = u.pathname.split('/').filter(Boolean);
  const channel = seg[0] === 's' ? seg[1] : seg[0];
  if (!channel) throw new SourceError('Not a Telegram channel URL');
  const listings = await fetchChannel(channel, country).catch(() => []);
  if (!listings.length) {
    throw new SourceError('No readable listings — the channel is private or empty');
  }
  return listings.slice(0, MAX_ITEMS);
}

// Fetch + parse a single custom-source URL. Recognizes common social platforms
// and routes them to a dedicated reader; otherwise falls back to reading any
// structured data (JSON-LD), RSS/Atom feeds, and (only for explicitly
// allowlisted housing sites) conservative server-rendered listing-card
// extraction. Domza's catalog keeps listing JSON-LD on individual offer pages,
// so we discover those links first and parse the detail pages in parallel.
export async function scrapeCustomUrl(url, country) {
  const safe = await assertSafeUrl(url);
  const platform = detectPlatform(safe);
  if (platform === 'telegram') return scrapeTelegramUrl(safe, country);
  if (platform === 'facebook') {
    // Dedicated scheduled Facebook ingestion is handled by social-fetcher.
    // Generic user-entered Facebook URLs remain unsupported here.
    throw new SourceError(
      'Facebook groups require the dedicated social fetcher — not supported as a generic custom URL',
    );
  }
  if (isDomzaCatalogUrl(safe)) {
    return scrapeDomzaCatalog(safe, country);
  }

  const body = await fetchText(safe);
  let listings = extractJsonLd(body, country, safe.href);
  if (!listings.length) listings = extractFeed(body, country, safe.href);
  if (!listings.length) listings = extractKnownOwnerHtml(body, country, safe.href);

  if (!listings.length) {
    throw new SourceError(
      'No listings found — the page has no readable structured data, feed, or supported housing catalogue cards',
    );
  }
  return listings.slice(0, MAX_ITEMS);
}
