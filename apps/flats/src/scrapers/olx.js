// OLX adapter.
//
// OLX fronts its site with an AWS WAF that 403s plain HTTP clients from our
// server by TLS/JA3 fingerprint (both the private /api/v1 endpoint AND the HTML
// pages), while letting a real Chrome fingerprint through even from the same IP.
// So the country snapshot is fetched through the `olx-fetcher` sidecar
// (Python + curl_cffi, which impersonates Chrome). It returns the ad objects
// embedded in each real-estate page's `window.__PRERENDERED_STATE__`, which we
// map here. If OLX_FETCHER_URL is unset the source is disabled and yields
// nothing (the other sources still work).
//
// The /api/v1 path below is kept ONLY for the manual single-listing reload
// (fetchOlxOffer); it will 403 from a blocked server until it is also routed
// through the sidecar.

import {makeListing} from '../normalize.js';
import {guessPropertyType} from '../textparse.js';
import {sleep, throttle} from '../ratelimit.js';
import {olxSegmentDealType} from '../olx-segment.js';

// Rate limiting: keep at least OLX_MIN_INTERVAL_MS (+ up to OLX_JITTER_MS random)
// between requests to the same OLX portal so we don't hammer it. Keyed per host,
// so different countries throttle independently.
const OLX_MIN_INTERVAL_MS = Number(process.env.OLX_MIN_INTERVAL_MS) || 900;
const OLX_JITTER_MS = Number(process.env.OLX_JITTER_MS) || 500;
// On HTTP 429 (Too Many Requests), back off this long before the caller retries.
const OLX_BACKOFF_MS = Number(process.env.OLX_BACKOFF_MS) || 5_000;
const OLX_PAGE_RETRIES =
    Number(process.env.OLX_PAGE_RETRIES) || 3;

const OLX_RETRY_BASE_MS =
    Number(process.env.OLX_RETRY_BASE_MS) || 1500;

function isHardOlxError(error) {
  const message =
      error?.message ??
      String(error);

  return /\b(?:401|403|429)\b/.test(message);
}
const OLX_SEGMENTS = [
  'flat:longRent',
  'flat:shortRent',
  'flat:sale',
];

const UA_HEADER =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Preferred UI language per portal, sent in Accept-Language so the response and
// the anti-bot check see a locale consistent with the host being requested.
const OLX_LANG = { RO: 'ro-RO,ro;q=0.9,en;q=0.7', UA: 'uk-UA,uk;q=0.9,ru;q=0.7,en;q=0.5', KZ: 'ru-RU,ru;q=0.9,kk;q=0.7,en;q=0.5', UZ: 'ru-RU,ru;q=0.9,uz;q=0.7,en;q=0.5' };

// OLX fronts its API with an anti-bot WAF that rejects requests missing the
// header set a real browser sends. A bare User-Agent gets an HTTP 403; sending
// the same-origin Referer/Origin, client hints and Sec-Fetch metadata that
// olx.<tld>'s own frontend sends clears the naive rules. (If the block is at the
// IP/TLS-fingerprint level this is not enough — an egress proxy is then needed.)
function browserHeaders(country) {
  const host = country.olxHost;
  return {
    'User-Agent': UA_HEADER,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': OLX_LANG[country.code] || 'en-US,en;q=0.9',
    Referer: `${host}/`,
    Origin: host,
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  };
}

// URL of the olx-fetcher sidecar. Unset -> OLX source disabled (yields nothing).
const OLX_FETCHER_URL = process.env.OLX_FETCHER_URL || '';

// One rate-limited page fetch via the sidecar. Node throttles here (1:1 with the
// sidecar's outbound OLX request), so we stay a polite client to OLX.
async function fetchStatePage(
    country,
    segment,
    page,
    citySlug = null,
) {
  await throttle(
      `olx:${country.olxHost}`,
      OLX_MIN_INTERVAL_MS,
      OLX_JITTER_MS,
  );

  const base =
      OLX_FETCHER_URL
          .replace(/\/$/, '');

  const params =
      new URLSearchParams({
        country:
        country.code,

        segment,

        page:
            String(page),
      });

  if (citySlug) {
    params.set(
        'city',
        citySlug,
    );
  }

  const res =
      await fetch(
          `${base}/olx/listings?${params}`,
          {
            // Above the sidecar's own curl_cffi timeout so its internal retry
            // can complete rather than being cut off here (see #4).
            signal:
                AbortSignal.timeout(
                    60_000,
                ),
          },
      );

  if (!res.ok) {
    let detail =
        `HTTP ${res.status}`;

    try {
      detail =
          (await res.json())
              ?.error ||
          detail;
    } catch {}

    throw new Error(
        `olx-fetcher ` +
        `${country.code}/` +
        `${segment}/` +
        `${citySlug || 'all'}: ` +
        detail,
    );
  }

  const data =
      await res.json();

  return Array.isArray(
      data?.ads,
  )
      ? data.ads
      : [];
}

// Find a listing parameter by key or human name. Web-state params look like
// { key, name, type, value, normalizedValue }. Returns the display `value`.
function stateParam(item, keyRe, nameRe) {
  for (const p of item.params ?? []) {
    if ((p.key && keyRe.test(p.key)) || (p.name && nameRe.test(p.name))) return p.value;
  }
  return null;
}

function stateRooms(item) {
  const raw = stateParam(item, /room|komnat|kimnat|xonali|kolichestvo/i, /комнат|кімнат|room|xonali|спал/i);
  let rooms = raw != null ? Number(String(raw).match(/\d+/)?.[0]) : null;
  if (!rooms) {
    // Fall back to the title, but only on an explicit room word — never a bare
    // "кв" (that is "кв.м" area, e.g. "72 кв.м" is 72 m², not 72 rooms).
    const t = (item.title || '').match(
      /(\d+)\s*[-хx]?\s*(?:camer|комнатн|комн|кімнат|кімн|room|bedroom|xonali|xona)/i,
    );
    rooms = t ? Number(t[1]) : null;
  }
  if (rooms != null && (rooms < 1 || rooms > 10)) rooms = null; // sanity cap
  return rooms || null;
}

function stateArea(item) {
  const raw = stateParam(item, /area|m2|total_area|ploshch|maydon|kvadrat/i, /площад|area|m²|кв\.?\s*м|maydon|майдон/i);
  const n = raw != null ? Number(String(raw).replace(',', '.').match(/\d+(?:\.\d+)?/)?.[0]) : null;
  return n || null;
}

async function scrapeSegment(
    country,
    segment,
    onChunk,
    {
      citySlug = null,
      forcedCity = null,

      maxPages =
          Number(
              process.env
                  .OLX_MAX_PAGES_PER_SEGMENT,
          ) || 40,

      budgetMs =
          Number(
              process.env
                  .OLX_SEGMENT_BUDGET_MS,
          ) || 90_000,

      partialExpected =
      false,
    } = {},
) {
  const out = [];
  const seen =
      new Set();

  const errors = [];

  const startedAt =
      Date.now();

  for (
      let page = 1;
      page <= maxPages;
      page++
  ) {
    if (
        page > 1 &&
        Date.now() -
        startedAt >=
        budgetMs
    ) {
      return {
        listings:
        out,

        complete:
            false,

        partialExpected,

        stopReason:
            'budget_exceeded',

        page,

        errors,

        error:
            `OLX ${country.code}/` +
            `${segment}/` +
            `${forcedCity || 'all'} ` +
            `budget exceeded after ` +
            `${budgetMs}ms`,
      };
    }

    let ads =
        null;

    let pageError =
        null;

    for (
        let attempt = 1;
        attempt <=
        OLX_PAGE_RETRIES;
        attempt++
    ) {
      try {
        ads =
            await fetchStatePage(
                country,
                segment,
                page,
                citySlug,
            );

        pageError =
            null;

        break;
      } catch (error) {
        pageError =
            error;

        if (
            isHardOlxError(
                error,
            )
        ) {
          break;
        }

        if (
            attempt <
            OLX_PAGE_RETRIES
        ) {
          await sleep(
              OLX_RETRY_BASE_MS *
              attempt,
          );
        }
      }
    }

    if (ads === null) {
      const message =
          pageError?.message ??
          String(pageError);

      if (
          isHardOlxError(
              pageError,
          )
      ) {
        return {
          listings:
          out,

          complete:
              false,

          partialExpected:
              false,

          stopReason:
              'blocked',

          page,

          errors: [
            ...errors,

            {
              page,
              error:
              message,
            },
          ],

          error:
          message,
        };
      }

      errors.push({
        page,

        error:
        message,
      });

      continue;
    }

    if (!ads.length) {
      return {
        listings:
        out,

        complete:
            errors.length ===
            0,

        partialExpected:
            false,

        stopReason:
            errors.length
                ? 'completed_with_gaps'
                : 'empty_page',

        errors,
      };
    }

    const fresh = [];

    for (
        const item
        of ads
        ) {
      if (
          item?.id == null
      ) {
        continue;
      }

      const id =
          String(
              item.id,
          );

      if (
          seen.has(id)
      ) {
        continue;
      }

      seen.add(id);

      const mapped =
          mapStateItem(
              item,
              country,
              segment,
          );

      /*
       * Городская OLX-страница уже
       * ограничена конкретным городом.
       *
       * Поэтому сохраняем canonical
       * значение вместо смеси:
       *
       * Чернівці / Черновцы /
       * Chernivtsi.
       */
      if (forcedCity) {
        mapped.city =
            forcedCity;
      }

      out.push(
          mapped,
      );

      fresh.push(
          mapped,
      );
    }

    if (fresh.length) {
      onChunk?.(
          fresh,
      );
    }

    if (
        ads.length < 40
    ) {
      return {
        listings:
        out,

        complete:
            errors.length ===
            0,

        partialExpected:
            false,

        stopReason:
            errors.length
                ? 'completed_with_gaps'
                : 'short_page',

        errors,
      };
    }
  }

  /*
   * Для targeted crawl maxPages —
   * нормальный лимит, а не ошибка.
   *
   * complete=false нужен,
   * чтобы нельзя было считать,
   * что мы увидели абсолютно весь OLX.
   */
  return {
    listings:
    out,

    complete:
        false,

    partialExpected,

    stopReason:
        'max_pages',

    page:
    maxPages,

    errors,

    error:
        `Reached maxPages=${maxPages}`,
  };
}

// Map one ad from a page's __PRERENDERED_STATE__ (a richer shape than /api/v1).
// The structured pieces we can get cheaply are passed to makeListing; the rest
// (floor, audience, tags, ...) is parsed from title/description there. The
// category segment is authoritative for dealType, including dedicated daily-rent
// categories whose individual titles may omit "daily" wording.
// Note: web-state ads carry real coordinates + city/district, so they need no
// geocoding downstream.
function mapStateItem(item, country, segment = null) {
  const rp = item.price?.regularPrice ?? {};
  const paramText = (item.params ?? [])
    .map((p) => `${p.name ?? ''} ${Array.isArray(p.value) ? p.value.join(' ') : p.value ?? ''}`)
    .join(' ');
  return makeListing({
    id: item.id,
    source: 'olx',
    country: country.code,
    title: item.title,
    description: item.description ?? '',
    propertyType: guessPropertyType(`${item.title || ''} ${paramText}`),
    byAgency: Boolean(item.isBusiness),
    price: rp.value ?? null,
    currency: normalizeCurrency(rp.currencyCode) ?? country.currency,
    rooms: stateRooms(item),
    areaSqm: stateArea(item),
    city: item.location?.cityName ?? item.location?.regionName ?? '',
    district: item.location?.districtName ?? null,
    lat: item.map?.lat ?? null,
    lng: item.map?.lon ?? null,
    photos: Array.isArray(item.photos) ? item.photos.filter(Boolean) : [],
    dealType: olxSegmentDealType(segment),
    url: item.url ?? country.olxHost,
    createdAt: item.createdTime ?? null,
  });
}

function paramMap(item) {
  const map = {};
  for (const pr of item.params ?? []) map[pr.key] = pr;
  return map;
}

function allPhotos(item) {
  return (item.photos ?? [])
    .map((p) => p.link?.replace('{width}', '800').replace('{height}', '600'))
    .filter(Boolean);
}

// OLX Uzbekistan quotes prices in "у.е." (conventional units) under the code
// "UYE" — a USD equivalent. Map it to USD so display-currency conversion works.
function normalizeCurrency(code) {
  if (!code) return null;
  const c = String(code).toUpperCase();
  if (c === 'UYE' || c === 'У.Е.' || c === 'УЕ') return 'USD';
  return code;
}

function detectAgency(item) {
  // Top-level boolean on every OLX portal: true = business/agency account.
  if (typeof item.business === 'boolean') return item.business;
  return Boolean(item.shop) || item.user?.is_business === true;
}

function mapItem(item, country) {
  const params = paramMap(item);
  const priceParam = params.price?.value;
  // Rooms: prefer OLX's structured `rooms` param. Fall back to the title, but
  // only match an explicit room word — NEVER a bare "кв" (that is "кв.м" area or
  // "квартал" block, e.g. "72 кв.м" is 72 m², not 72 rooms). Allow the Russian
  // "2х-комнатная" / "2-комн" filler between the number and the word.
  const roomsFromTitle = (item.title || '').match(
    /(\d+)\s*[-хx]?\s*(?:camer|комнатн|комн|кімнат|кімн|room|bedroom|xonali|xona)/i,
  );
  let rooms =
    Number(params.rooms?.value?.key) ||
    Number((params.rooms?.value?.label || '').match(/\d+/)?.[0]) ||
    (roomsFromTitle ? Number(roomsFromTitle[1]) : null) ||
    null;
  // Sanity cap: dwellings realistically have 1–10 rooms; larger is a mis-parse.
  if (rooms != null && (rooms < 1 || rooms > 10)) rooms = null;
  const area =
    Number(params.m?.value?.key) ||
    Number((params.m?.value?.label || '').match(/\d+/)?.[0]) ||
    null;

  // Classification is intrinsic listing data. Never copy the currently
  // selected UI filter into a row: doing that turned every result from a
  // `propertyType=house` scrape into a house (including apartments). Include
  // OLX category/parameter labels when available, as titles alone are often
  // too terse to identify the dwelling type.
  const categoryText = [
    item.category?.name,
    item.category?.label,
    ...Object.values(params).flatMap((param) => [param?.name, param?.value?.label]),
  ].filter(Boolean).join(' ');
  const propertyType = guessPropertyType(`${item.title || ''} ${categoryText}`);

  return makeListing({
    id: item.id,
    source: 'olx',
    country: country.code,
    title: item.title,
    description: item.description ?? '',
    propertyType,
    byAgency: detectAgency(item),
    price: priceParam?.value ?? null,
    currency: normalizeCurrency(priceParam?.currency) ?? country.currency,
    rooms,
    areaSqm: area,
    city: item.location?.city?.name ?? item.location?.region?.name ?? '',
    lat: item.map?.lat ?? null,
    lng: item.map?.lon ?? null,
    photos: allPhotos(item),
    url: item.url ?? country.olxHost,
    createdAt: item.created_time ?? null,
  });
}

// Re-fetch a single OLX offer by id (used by the manual "reload this listing"
// action). OLX exposes each offer at /api/v1/offers/{id}/. Returns a freshly
// mapped listing, or null if the offer no longer exists.
export async function fetchOlxOffer(country, id) {
  const url = `${country.olxHost}/api/v1/offers/${encodeURIComponent(id)}/`;
  const res = await olxFetch(country, url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`OLX ${country.code} offer HTTP ${res.status}`);
  const json = await res.json();
  const item = json?.data;
  if (!item || typeof item !== 'object') return null;
  return mapItem(item, country);
}

// One rate-limited GET to an OLX portal. Honors a 429 by backing off (Retry-After
// if the portal sends it, else OLX_BACKOFF_MS) before surfacing the error so the
// caller can decide whether to retry.
async function olxFetch(country, url) {
  await throttle(`olx:${country.olxHost}`, OLX_MIN_INTERVAL_MS, OLX_JITTER_MS);
  const res = await fetch(url, {
    headers: browserHeaders(country),
    signal: AbortSignal.timeout(12_000),
  });
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : OLX_BACKOFF_MS);
    throw new Error(`OLX ${country.code} HTTP 429`);
  }
  return res;
}

// Scrape one country's real-estate snapshot via the fetcher sidecar. The caller
// (index.js) neutralizes UI filters, so we fetch the whole category newest-first
// and let applyFilters narrow it in memory afterwards — `filters` is unused here.
// `onChunk(pageListings)` (optional) is called after each page so the caller can
// stream partial results into the cache and the UI count can climb during a scrape.
const OLX_UA_CITIES_PER_RUN =
    Math.max(
        4,
        Number(
            process.env
                .OLX_UA_CITIES_PER_RUN,
        ) || 8,
    );

const OLX_UA_CITY_MAX_PAGES =
    Math.max(
        1,
        Number(
            process.env
                .OLX_UA_CITY_MAX_PAGES,
        ) || 5,
    );

const OLX_UA_CITY_BUDGET_MS =
    Math.max(
        10_000,
        Number(
            process.env
                .OLX_UA_CITY_BUDGET_MS,
        ) || 30_000,
    );

const OLX_UA_NATIONAL_MAX_PAGES =
    Math.max(
        1,
        Number(
            process.env
                .OLX_UA_NATIONAL_MAX_PAGES,
        ) || 5,
    );

const OLX_UA_NATIONAL_BUDGET_MS =
    Math.max(
        10_000,
        Number(
            process.env
                .OLX_UA_NATIONAL_BUDGET_MS,
        ) || 30_000,
    );

const OLX_UA_PRIORITY_CITIES =
    new Set([
      'Chernivtsi',
      'Lutsk',
      'Uzhhorod',
      'Mukachevo',
    ]);

let uaCityCursor =
    null;

function selectUaOlxCities(
    country,
) {
  const all =
      Array.isArray(
          country.olxCities,
      )
          ? country.olxCities
          : [];

  if (!all.length) {
    return [];
  }

  if (
      all.length <=
      OLX_UA_CITIES_PER_RUN
  ) {
    return all;
  }

  const priority =
      all.filter(
          (item) =>
              OLX_UA_PRIORITY_CITIES
                  .has(
                      item.city,
                  ),
      );

  const rotating =
      all.filter(
          (item) =>
              !OLX_UA_PRIORITY_CITIES
                  .has(
                      item.city,
                  ),
      );

  const remainingSlots =
      Math.max(
          0,
          OLX_UA_CITIES_PER_RUN -
          priority.length,
      );

  if (
      !Number.isInteger(
          uaCityCursor,
      )
  ) {
    /*
     * После restart не начинаем
     * каждый раз с одного города.
     */
    uaCityCursor =
        rotating.length
            ? Math.floor(
                Date.now() /
                3_600_000,
            ) %
            rotating.length
            : 0;
  }

  const selected = [
    ...priority,
  ];

  for (
      let index = 0;
      index <
      remainingSlots &&
      index <
      rotating.length;
      index++
  ) {
    selected.push(
        rotating[
        (
            uaCityCursor +
            index
        ) %
        rotating.length
            ],
    );
  }

  if (
      rotating.length
  ) {
    uaCityCursor =
        (
            uaCityCursor +
            remainingSlots
        ) %
        rotating.length;
  }

  return [
    ...new Map(
        selected.map(
            (item) => [
              item.city,
              item,
            ],
        ),
    ).values(),
  ];
}

export async function scrapeOlx(
    country,
    _filters,
    onChunk,
) {
  if (!OLX_FETCHER_URL) {
    return {
      listings: [],

      complete:
          false,

      partialExpected:
          false,

      errors: [
        {
          error:
              'OLX_FETCHER_URL is not configured',

          stopReason:
              'fetcher_disabled',
        },
      ],
    };
  }

  /*
   * Для остальных стран пока
   * сохраняем существующий crawler.
   */
  if (
      country.code !== 'UA'
  ) {
    const listings = [];
    const errors = [];

    let complete =
        true;

    for (
        const segment
        of OLX_SEGMENTS
        ) {
      const result =
          await scrapeSegment(
              country,
              segment,
              onChunk,
          );

      listings.push(
          ...result.listings,
      );

      if (
          !result.complete
      ) {
        complete =
            false;

        if (
            Array.isArray(
                result.errors,
            ) &&
            result.errors.length
        ) {
          for (
              const item
              of result.errors
              ) {
            errors.push({
              segment,

              page:
              item.page,

              error:
              item.error,

              stopReason:
              result.stopReason,
            });
          }
        } else {
          errors.push({
            segment,

            page:
            result.page,

            error:
                result.error ??
                'Incomplete OLX scrape',

            stopReason:
            result.stopReason,
          });
        }
      }
    }

    return {
      listings:
          dedupeOlx(
              listings,
          ),

      complete,

      partialExpected:
          false,

      errors,
    };
  }

  /*
   * Украина:
   *
   * 1. короткий country-wide crawl;
   * 2. несколько конкретных городов;
   * 3. города ротируются между runs;
   * 4. проблемные малые города
   *    проходят каждый раз.
   */
  const listings = [];
  const errors = [];

  /*
   * Catch-all нужен для городов,
   * которых ещё нет в olxCities.
   */
  for (
      const segment
      of OLX_SEGMENTS
      ) {
    const result =
        await scrapeSegment(
            country,
            segment,
            onChunk,
            {
              maxPages:
              OLX_UA_NATIONAL_MAX_PAGES,

              budgetMs:
              OLX_UA_NATIONAL_BUDGET_MS,

              /*
               * Мы намеренно не читаем
               * всю Украину до конца.
               */
              partialExpected:
                  true,
            },
        );

    listings.push(
        ...result.listings,
    );

    /*
     * Реальные page errors сохраняем.
     * Сам expected max_pages —
     * не source error.
     */
    for (
        const item
        of result.errors ??
    []
        ) {
      errors.push({
        scope:
            'national',

        segment,

        page:
        item.page,

        error:
        item.error,

        stopReason:
        result.stopReason,
      });
    }
  }

  const selectedCities =
      selectUaOlxCities(
          country,
      );

  for (
      const target
      of selectedCities
      ) {
    for (
        const segment
        of OLX_SEGMENTS
        ) {
      const result =
          await scrapeSegment(
              country,
              segment,
              onChunk,
              {
                citySlug:
                target.slug,

                forcedCity:
                target.city,

                maxPages:
                OLX_UA_CITY_MAX_PAGES,

                budgetMs:
                OLX_UA_CITY_BUDGET_MS,

                partialExpected:
                    true,
              },
          );

      listings.push(
          ...result.listings,
      );

      for (
          const item
          of result.errors ??
      []
          ) {
        errors.push({
          scope:
              'city',

          city:
          target.city,

          citySlug:
          target.slug,

          segment,

          page:
          item.page,

          error:
          item.error,

          stopReason:
          result.stopReason,
        });
      }
    }
  }

  console.log(
      `[olx] UA targeted cities: ` +
      selectedCities
          .map(
              (item) =>
                  item.city,
          )
          .join(', '),
  );

  return {
    listings:
        dedupeOlx(
            listings,
        ),

    /*
     * Один run намеренно не является
     * полным обходом всего OLX UA.
     *
     * Поэтому markMissingAfterCompleteCrawl
     * не должен деактивировать объявления,
     * города которых были в другой ротации.
     */
    complete:
        false,

    /*
     * Это штатная progressive rotation,
     * а не ошибка источника.
     */
    partialExpected:
        errors.length === 0,

    processedCities:
        selectedCities.map(
            (item) =>
                item.city,
        ),

    errors,
  };
}

function dedupeOlx(listings) {
  return [
    ...new Map(
        listings.map(item => [
          `${item.country}:${item.id}`,
          item,
        ]),
    ).values(),
  ];
}