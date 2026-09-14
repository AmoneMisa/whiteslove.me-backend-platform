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
//
// A handful of hosts (dom.ria.com, lun.ua) front themselves with a WAF that
// 403s a plain Node fetch by TLS/JA3 fingerprint — the same problem OLX has.
// Those go through the olx-fetcher sidecar's generic /fetch/html endpoint
// (curl_cffi, Chrome impersonation) instead of the raw Node request below.
//
// A different set of hosts (domza.uz, uybor.uz) rebuilt their catalogue as a
// client-rendered SPA: a plain fetch gets an empty shell because the listing
// cards are populated by a client-side data fetch after mount. Those go
// through the housing-browser-fetcher sidecar's /fetch/html endpoint instead,
// which loads the page in a real headless browser and waits for that fetch to
// settle before handing back the rendered DOM.

import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { makeListing } from '../listing/normalize.js';
import { parseHousingSeller } from '@whiteslove/parsing-lexicon/housing-structured';
import { fetchChannel } from './telegram.js';
import { extractKnownOwnerHtml } from './owner-html.js';

const FETCH_TIMEOUT_MS = 12_000;
const DOMZA_FETCH_TIMEOUT_MS = 20_000;
const DOMZA_DETAIL_CONCURRENCY = 6;
const MAX_REDIRECTS = 5;
const MAX_BYTES = 4 * 1024 * 1024; // cap the response we'll parse (4 MB)
// There is deliberately no result cap here. MAX_BYTES bounds transport, not
// crawl depth: a fetched page is parsed to exhaustion and every listing it
// yields is returned. See AGENTS.md — a result count must never bound a
// successful crawl, and crawl depth belongs to the shared crawler, not here.

// Hosts known to WAF-block a plain server fetch, routed through the curl_cffi
// sidecar instead. Keep in sync with GENERIC_FETCH_HOSTS in
// services/olx-fetcher/app.py.
const CFFI_FETCH_HOSTS = new Set([
  'dom.ria.com', 'www.dom.ria.com',
  'lun.ua', 'www.lun.ua',
  'proprietar-direct.ro',
  'publi24.ro', 'www.publi24.ro',
  'imobiliare.ro', 'www.imobiliare.ro',
  'lajumate.ro',
]);
const CFFI_FETCHER_URL = process.env.OLX_FETCHER_URL || '';

// Hosts whose catalogue is client-rendered, routed through the
// housing-browser-fetcher sidecar's generic /fetch/html endpoint instead.
// Keep in sync with PLAYWRIGHT_FETCH_HOSTS in
// services/housing-browser-fetcher/app.py. domza.uz is deliberately NOT
// listed here: only its catalogue page is client-rendered (its offer detail
// pages still server-render JSON-LD), so scrapeDomzaCatalog calls the sidecar
// directly for that one fetch instead of routing every domza.uz request
// (hundreds of per-offer detail fetches) through a real browser.
const PLAYWRIGHT_FETCH_HOSTS = new Set([
  'uybor.uz', 'www.uybor.uz',
  // x-estate.com's real catalogue lives at /offers, rendered client-side by a
  // React bundle into an empty #root — a plain fetch sees no cards at all.
  'x-estate.com', 'www.x-estate.com',
]);
const PLAYWRIGHT_FETCHER_URL = process.env.HOUSING_BROWSER_FETCHER_URL || '';
// Rendering a real browser is much slower than curl_cffi; give the sidecar
// room to load the page, wait for its data fetch to settle, and respond.
const PLAYWRIGHT_FETCH_TIMEOUT_FLOOR_MS = 35_000;

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
  Object.defineProperty(u, '__validatedAddress', {
    configurable: true,
    value: addrs[0],
  });
  return u;
}

function requestSource(u, timeoutMs) {
  const transport = u.protocol === 'https:' ? https : http;
  const address = u.__validatedAddress;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(response);
    };
    const request = transport.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: `${u.pathname}${u.search}`,
      method: 'GET',
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en,ru;q=0.8',
        'Accept-Encoding': 'identity',
      },
      servername: u.hostname,
      // Node's autoSelectFamily (Happy Eyeballs) requests options.all: true,
      // which expects an array of records back instead of a bare
      // (address, family) pair - answering with the old two-arg shape makes
      // Node read `undefined` as the address and fail every request with
      // ERR_INVALID_IP_ADDRESS, regardless of whether the host is reachable.
      lookup: (_host, options, callback) => {
        const family = net.isIPv6(address) ? 6 : 4;
        if (options?.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
    }, (response) => {
      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        if (total >= MAX_BYTES) return;
        const value = Buffer.from(chunk).subarray(0, MAX_BYTES - total);
        total += value.length;
        chunks.push(value);
      });
      response.on('end', () => finish(null, {
        status: response.statusCode || 0,
        headers: response.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
      response.on('error', (error) => finish(error));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Source timed out')));
    request.on('error', (error) => finish(error));
    request.end();
  });
}

// Fetch a WAF-protected host's HTML through the curl_cffi sidecar instead of
// the raw Node request, which gets 403'd by TLS/JA3 fingerprinting.
async function fetchViaCffiSidecar(u, timeoutMs) {
  if (!CFFI_FETCHER_URL) {
    throw new SourceError('Source blocked automated access');
  }
  const base = CFFI_FETCHER_URL.replace(/\/$/, '');
  const params = new URLSearchParams({ url: u.href });
  let res;
  try {
    res = await fetch(`${base}/fetch/html?${params}`, {
      signal: AbortSignal.timeout(Math.max(timeoutMs, 20_000)),
    });
  } catch {
    throw new SourceError('Could not reach source');
  }
  if (!res.ok) {
    if (res.status === 502) {
      let detail = '';
      try { detail = (await res.json())?.error || ''; } catch {}
      if (detail === 'blocked_automated_access') {
        throw new SourceError('Source blocked automated access');
      }
    }
    throw new SourceError('Could not reach source');
  }
  const data = await res.json();
  if (typeof data?.html !== 'string') throw new SourceError('Could not reach source');
  return data.html;
}

// Fetch a client-rendered host's HTML through the housing-browser-fetcher
// sidecar instead of the raw Node request, which only ever sees the
// pre-render SPA shell.
async function fetchViaPlaywrightSidecar(u, timeoutMs) {
  if (!PLAYWRIGHT_FETCHER_URL) {
    throw new SourceError('Source requires JS rendering, which is not configured');
  }
  const base = PLAYWRIGHT_FETCHER_URL.replace(/\/$/, '');
  const params = new URLSearchParams({ url: u.href });
  let res;
  try {
    res = await fetch(`${base}/fetch/html?${params}`, {
      signal: AbortSignal.timeout(Math.max(timeoutMs, PLAYWRIGHT_FETCH_TIMEOUT_FLOOR_MS)),
    });
  } catch {
    throw new SourceError('Could not reach source');
  }
  if (!res.ok) throw new SourceError('Could not reach source');
  const data = await res.json();
  if (typeof data?.html !== 'string') throw new SourceError('Could not reach source');
  return data.html;
}

async function fetchText(u, timeoutMs = FETCH_TIMEOUT_MS) {
  if (CFFI_FETCH_HOSTS.has(u.hostname.toLowerCase())) {
    return fetchViaCffiSidecar(u, timeoutMs);
  }
  if (PLAYWRIGHT_FETCH_HOSTS.has(u.hostname.toLowerCase())) {
    return fetchViaPlaywrightSidecar(u, timeoutMs);
  }

  const startedAt = Date.now();
  let current = u;
  let res = null;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) throw new SourceError('Source timed out');

    try {
      current = await assertSafeUrl(current.href);
      res = await requestSource(current, remainingMs);
    } catch (e) {
      if (e?.message === 'Source timed out') throw new SourceError('Source timed out');
      throw new SourceError('Could not reach source');
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      // The node client is already manual, equivalent to fetch's redirect: 'manual'.
      const location = typeof res.headers.get === 'function'
        ? res.headers.get('location')
        : res.headers.location;
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
  if (res.status < 200 || res.status >= 300) {
    throw new SourceError(`Source returned HTTP ${res.status}`);
  }

  // Read with a byte cap so a huge page can't blow up memory.
  return res.text;
}

// ---- extraction ------------------------------------------------------------

// Flatten JSON-LD graphs (@graph / arrays) into a flat list of typed nodes.
// Also descends into schema.org's ItemList/ListItem wrapping — a common way
// paginated catalogues (e.g. rentli.uz) nest each listing inside
// itemListElement[].item instead of exposing it as a top-level node. Only
// itemListElement/item are followed (not every nested property) so a
// listing's own nested Offer/PostalAddress nodes are never mistaken for
// separate top-level listings.
function flattenLd(node, out) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const n of node) flattenLd(n, out);
    return;
  }
  if (typeof node !== 'object') return;
  if (Array.isArray(node['@graph'])) flattenLd(node['@graph'], out);
  if (node.itemListElement) flattenLd(node.itemListElement, out);
  if (String(node['@type'] || '').toLowerCase() === 'listitem' && node.item) {
    flattenLd(node.item, out);
  }

  // Some catalogues (e.g. parklane.ua) wrap every real per-unit listing
  // inside a single page-level SEO node instead of exposing them as sibling
  // top-level nodes: RealEstateListing.mainEntity -> ItemList.itemListElement
  // (a lone Product, not an array) -> Product.offers.offers[] -> each unit as
  // its own Offer/Apartment node. Once a wrapper's nested listings have been
  // followed, the wrapper itself must NOT also be pushed as a listing: it has
  // no per-unit price/url of its own, only the page's generic title/URL (the
  // root) or an AggregateOffer lowPrice/highPrice summary (the Product) that
  // isn't any single unit's actual price.
  if (node.mainEntity) {
    flattenLd(node.mainEntity, out);
    return;
  }
  if (Array.isArray(node.offers?.offers)) {
    flattenLd(node.offers.offers, out);
    return;
  }

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

function mapLdNode(node, country, sourceUrl, idx, sourceDealType) {
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
    dealType: sourceDealType ?? null,
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

export function extractJsonLd(html, country, sourceUrl, sourceDealType) {
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
    listings.push(mapLdNode(node, country, sourceUrl, idx++, sourceDealType));
  }
  return listings;
}

// Minimal RSS/Atom item extraction.
function extractFeed(xml, country, sourceUrl, sourceDealType) {
  const isFeed = /<rss[\s>]|<feed[\s>]/i.test(xml);
  if (!isFeed) return [];
  const items = [];
  const itemRe = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
  let m;
  while ((m = itemRe.exec(xml))) {
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
        dealType: sourceDealType ?? null,
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

// ---- Next.js __NEXT_DATA__ catalogues --------------------------------------

// Hosts whose catalogue is a Next.js page that embeds its full result page as
// getServerSideProps JSON in <script id="__NEXT_DATA__">, rather than
// schema.org JSON-LD or SSR card markup. Keyed to the property path (relative
// to props.pageProps) holding the array of listing items.
const NEXT_DATA_HOSTS = new Map([
  ['atlanta.ua', 'realtyList.data'],
]);

function readPath(object, path) {
  return path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), object);
}

function numFromNextData(value) {
  if (value == null) return null;
  const n = Number(String(value).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// atlanta.ua quotes every listing's price in USD (confirmed against the
// rendered page — the site shows "$ <amount>" and a separate UAH toggle that
// isn't part of this JSON), with no currency field of its own in the data.
function mapAtlantaItem(item, country, sourceUrl, idx, sourceDealType) {
  const rooms = numFromNextData(item.preview?.rooms_count?.value);
  const url = (() => {
    try {
      return item.url ? new URL(item.url, sourceUrl).href : sourceUrl;
    } catch {
      return sourceUrl;
    }
  })();
  // makeListing has no dedicated floor/totalFloors input field — like the
  // rest of this pipeline, floor is read back out of free text by the shared
  // normalizer. The preview's own "19/24" floor value is folded into the
  // description text (in its native "поверх/поверховість" phrasing) so that
  // still happens here instead of being silently dropped.
  const floorsValue = item.preview?.floors?.value;
  const description = [item.shortDescription, floorsValue ? `Поверх/Поверховість: ${floorsValue}` : '']
    .filter(Boolean)
    .join('. ');

  return makeListing({
    id: `custom-${hash(sourceUrl + '|' + url + '|' + idx)}`,
    source: 'custom',
    country: country.code,
    title: item.title ?? 'Listing',
    description,
    propertyType: 'flat',
    dealType: sourceDealType ?? null,
    price: numFromNextData(item.price?.rentPrice),
    currency: 'USD',
    rooms,
    areaSqm: numFromNextData(item.preview?.square_total?.value),
    city: String(item.preview?.address?.value || '').split(',').pop()?.trim() || '',
    lat: numFromNextData(item.coords?.coord_x),
    lng: numFromNextData(item.coords?.coord_y),
    photos: Array.isArray(item.galleryDataAll) ? item.galleryDataAll.filter((s) => /^https?:\/\//i.test(s)) : [],
    url,
    createdAt: null,
  });
}

const NEXT_DATA_MAPPERS = new Map([
  ['atlanta.ua', mapAtlantaItem],
]);

export function extractNextData(html, country, sourceUrl, sourceDealType) {
  let host;
  try {
    host = new URL(sourceUrl).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return [];
  }
  const dataPath = NEXT_DATA_HOSTS.get(host);
  const mapper = NEXT_DATA_MAPPERS.get(host);
  if (!dataPath || !mapper) return [];

  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return [];
  let payload;
  try {
    payload = JSON.parse(match[1]);
  } catch {
    return [];
  }
  const items = readPath(payload?.props?.pageProps, dataPath);
  if (!Array.isArray(items)) return [];

  const listings = [];
  items.forEach((item, idx) => {
    const listing = mapper(item, country, sourceUrl, idx, sourceDealType);
    if (listing.price != null) listings.push(listing);
  });
  return listings;
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

  while ((match = hrefRe.exec(html))) {
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

async function scrapeDomzaCatalog(safe, country, sourceDealType) {
  // Domza's catalogue is client-rendered — a plain fetch sees an empty SPA
  // shell with zero offer links. Only this one request needs a real browser;
  // each offer's own detail page below still server-renders JSON-LD.
  const body = await fetchViaPlaywrightSidecar(safe, DOMZA_FETCH_TIMEOUT_MS);
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
      return extractJsonLd(detailBody, country, detailUrl.href, sourceDealType)
        .filter((listing) => /^https:\/\/(?:www\.)?domza\.uz\/offers\//i.test(listing.url || ''));
    },
  );

  const listings = groups.flat();
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
  const listings = await fetchChannel({name: channel}, country);
  if (!listings.length) {
    throw new SourceError('No readable listings — the channel is private or empty');
  }
  return listings;
}

// Fetch + parse a single custom-source URL. Recognizes common social platforms
// and routes them to a dedicated reader; otherwise falls back to reading any
// structured data (JSON-LD), RSS/Atom feeds, and (only for explicitly
// allowlisted housing sites) conservative server-rendered listing-card
// extraction. Domza's catalog keeps listing JSON-LD on individual offer pages,
// so we discover those links first and parse the detail pages in parallel.
//
// `dealType` is the curated source's declared contract (e.g. a daily-rental
// catalogue). It is handed to makeListing as evidence rather than applied
// afterwards, so shared normalization can arbitrate it against the text —
// explicit short-stay wording still wins, and an off-topic "продам" in a card
// no longer turns a rental catalogue entry into a sale.
export async function scrapeCustomUrl(url, country, { dealType = null } = {}) {
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
    return scrapeDomzaCatalog(safe, country, dealType);
  }

  const body = await fetchText(safe);
  let listings = extractJsonLd(body, country, safe.href, dealType);
  if (!listings.length) listings = extractFeed(body, country, safe.href, dealType);
  if (!listings.length) listings = extractNextData(body, country, safe.href, dealType);
  if (!listings.length) listings = extractKnownOwnerHtml(body, country, safe.href, dealType);

  if (!listings.length) {
    throw new SourceError(
      'No listings found — the page has no readable structured data, feed, or supported housing catalogue cards',
    );
  }
  return listings;
}
