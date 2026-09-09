# OLX fetcher sidecar.
#
# OLX's WAF (AWS CloudFront) 403s plain HTTP clients from our server by TLS/JA3
# fingerprint, but lets a real Chrome fingerprint through even from the same IP.
# curl_cffi's `impersonate` replicates that fingerprint, so this tiny service can
# fetch the SEO-facing HTML listing pages (NOT the blocked /api/v1 endpoint) and
# hand the flat-finder Node backend the structured ad objects embedded in each
# page's `window.__PRERENDERED_STATE__`.
#
# The Node backend owns all normalization/filtering; this only does the fetch +
# extract. Callers are expected to rate-limit (the Node side throttles per host).
#
# It also exposes a generic /fetch/html endpoint that returns raw HTML for other
# WAF-protected housing sites (dom.ria.com, lun.ua, ...) that the generic custom.js
# scraper cannot reach with a plain Node fetch. That endpoint only impersonates a
# browser TLS fingerprint — it does not know page structure — so extraction of the
# returned HTML still happens in custom.js/owner-html.js. It is restricted to an
# explicit host allowlist so this sidecar can't be used as an open fetch proxy.

import html as html_lib
import os
import re
import json
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

from flask import Flask, request, jsonify
from curl_cffi import requests as cffi

app = Flask(__name__)

PORTALS = {
    "UZ": {
        "host": "https://www.olx.uz",
        "lang": "ru-RU,ru;q=0.9,uz;q=0.7,en;q=0.5",
        "paths": {
            "flat:longRent": "nedvizhimost/kvartiry/arenda-dolgosrochnaya",
            "flat:shortRent": "nedvizhimost/posutochno_pochasovo/kvartira",
            "flat:sale": "nedvizhimost/kvartiry/prodazha",
        },
    },
    "KZ": {
        "host": "https://www.olx.kz",
        "lang": "ru-RU,ru;q=0.9,kk;q=0.7,en;q=0.5",
        "paths": {
            "flat:longRent": "nedvizhimost/arenda-kvartiry",
            "flat:shortRent": "nedvizhimost/arenda-pochasovo-posutochno/kvartiry",
            "flat:sale": "nedvizhimost/prodazha-kvartiry",
        },
    },
    "UA": {
        "host": "https://www.olx.ua",
        "lang": "uk-UA,uk;q=0.9,ru;q=0.7,en;q=0.5",
        "paths": {
            "flat:longRent": "nedvizhimost/kvartiry/dolgosrochnaya-arenda-kvartir",
            "flat:shortRent": "nedvizhimost/posutochno-pochasovo/posutochno-pochasovo-kvartiry",
            "flat:sale": "nedvizhimost/kvartiry/prodazha-kvartir",
        },
    },
    "RO": {
        "host": "https://www.olx.ro",
        "lang": "ro-RO,ro;q=0.9,en;q=0.7",
        "paths": {
            "flat:longRent": "imobiliare/apartamente-garsoniere-de-inchiriat",
            "flat:shortRent": "cazare-turism/cazare-turism",
            "flat:sale": "imobiliare/apartamente-garsoniere-de-vanzare",
        },
    },
}

IMPERSONATE = os.environ.get("OLX_IMPERSONATE", "chrome124")
TIMEOUT = int(os.environ.get("OLX_TIMEOUT", "45"))
STATUS_TIMEOUT = max(3, min(30, int(os.environ.get("OLX_AVAILABILITY_TIMEOUT", "12"))))
ATTEMPTS = max(1, int(os.environ.get("OLX_ATTEMPTS", "1")))
RETRY_BACKOFF = float(os.environ.get("OLX_RETRY_BACKOFF", "1.5"))
LOOKBACK_DAYS = max(1, int(os.environ.get("OLX_LOOKBACK_DAYS", "21")))

# Hosts that other scrapers are allowed to fetch through /fetch/html. Keep this
# tight — it's a fetch-by-URL endpoint, so anything added here is effectively
# trusted to be a real housing site, not an SSRF target picked by a caller.
GENERIC_FETCH_HOSTS = {
    h.strip().lower()
    for h in os.environ.get(
        "GENERIC_FETCH_HOSTS",
        "dom.ria.com,www.dom.ria.com,lun.ua,www.lun.ua",
    ).split(",")
    if h.strip()
}
GENERIC_FETCH_TIMEOUT = int(os.environ.get("GENERIC_FETCH_TIMEOUT", "20"))

_STATE_RE = re.compile(
    r'window\.__PRERENDERED_STATE__\s*=\s*("(?:[^"\\]|\\.)*")\s*;',
    re.S,
)

_INACTIVE_PATTERNS = [
    re.compile(r"объявлен(?:ие|ия).{0,100}(?:не\s*актив|недоступ|удал[её]н|закрыт)", re.I),
    re.compile(r"(?:это\s+)?объявление.{0,100}(?:больше\s+не\s+доступно|снято)", re.I),
    re.compile(r"оголошенн(?:я|і).{0,100}(?:не\s*актив|недоступ|видален|видалено|закрит)", re.I),
    re.compile(r"anun(?:ț|t)(?:ul)?.{0,100}(?:nu\s+mai\s+este\s+disponibil|inactiv|șters|sters)", re.I),
]

# OLX sometimes keeps the original offer URL and returns HTTP 200 while rendering
# only its generic error shell. The old classifier saw the offer id in finalUrl
# and incorrectly marked that page active forever.
_GENERIC_ERROR_PATTERNS = [
    re.compile(r"ой[,.!\s]+что[-\s]*то\s+пошло\s+не\s+так", re.I),
    re.compile(r"щось\s+пішло\s+не\s+так", re.I),
    re.compile(r"ceva\s+nu\s+a\s+mers", re.I),
    re.compile(r"something\s+went\s+wrong", re.I),
]


def _extract_state(document):
    """Decode OLX's prerender state once and reuse it for list/detail checks."""
    m = _STATE_RE.search(document or "")
    if not m:
        return None
    try:
        state = json.loads(json.loads(m.group(1)))
    except (ValueError, TypeError):
        return None
    return state if isinstance(state, dict) else None


def extract_ads(html):
    """Return the list of ad objects from the page state, or None if not present."""
    state = _extract_state(html)
    if state is None:
        return None
    ads = (((state or {}).get("listing") or {}).get("listing") or {}).get("ads")
    return ads if isinstance(ads, list) else None


def _looks_like_offer_object(value, offer_id):
    if not isinstance(value, dict):
        return False

    offer_id = str(offer_id or "").strip()
    if not offer_id:
        return False

    identity_values = []
    for key in ("url", "link", "canonicalUrl", "canonical_url"):
        raw = value.get(key)
        if raw:
            identity_values.append(str(raw))

    raw_id = value.get("id")
    identity_matches = (
        any(offer_id in candidate for candidate in identity_values)
        or (raw_id is not None and str(raw_id) == offer_id)
    )
    if not identity_matches:
        return False

    title = str(value.get("title") or "").strip()
    if not title:
        return False

    detail_keys = {
        "price",
        "photos",
        "location",
        "map",
        "params",
        "description",
        "createdTime",
        "created_time",
    }
    return any(key in value for key in detail_keys)


def _state_has_live_offer(document, offer_id):
    """Require an actual offer payload, not merely the old ID surviving in the URL."""
    state = _extract_state(document)
    if state is None:
        return False

    stack = [state]
    while stack:
        current = stack.pop()
        if isinstance(current, dict):
            if _looks_like_offer_object(current, offer_id):
                return True
            stack.extend(current.values())
        elif isinstance(current, list):
            stack.extend(current)
    return False


def _ad_created_at(ad):
    value = (ad or {}).get("createdTime") or (ad or {}).get("created_time")
    if not value:
        return None
    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def apply_lookback_page_stop(ads):
    cutoff = datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)
    known_dates = []
    unknown_dates = 0

    for ad in ads:
        created_at = _ad_created_at(ad)
        if created_at is None:
            unknown_dates += 1
        else:
            known_dates.append(created_at)

    past_cutoff = (
        bool(known_dates)
        and unknown_dates == 0
        and max(known_dates) < cutoff
    )

    return (
        [] if past_cutoff else ads,
        {
            "pastCutoff": past_cutoff,
            "lookbackDays": LOOKBACK_DAYS,
            "unknownDateCount": unknown_dates,
            "newestKnownAt": max(known_dates).isoformat() if known_dates else None,
            "oldestKnownAt": min(known_dates).isoformat() if known_dates else None,
            "cutoffAt": cutoff.isoformat(),
        },
    )


def _visible_text(document):
    """Strip scripts/styles before matching status copy to avoid bundle strings."""
    text = re.sub(r"<script\b[^>]*>.*?</script>", " ", document or "", flags=re.I | re.S)
    text = re.sub(r"<style\b[^>]*>.*?</style>", " ", text, flags=re.I | re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", html_lib.unescape(text)).strip()


def classify_offer_response(status_code, document, requested_id, final_url):
    """Conservative availability classifier; network/WAF ambiguity stays unknown."""
    if status_code in (404, 410):
        return "inactive", f"http_{status_code}"
    if status_code in (401, 403, 408, 425, 429) or status_code >= 500:
        return "unknown", f"http_{status_code}"
    if status_code != 200:
        return "unknown", f"http_{status_code}"

    visible = _visible_text(document)
    for pattern in _INACTIVE_PATTERNS:
        if pattern.search(visible):
            return "inactive", "inactive_page"

    for pattern in _GENERIC_ERROR_PATTERNS:
        if pattern.search(visible):
            # A generic shell can be a transient OLX outage. Do not deactivate
            # on that response alone.
            return "unknown", "generic_error_page"

    offer_id = str(requested_id or "").strip()
    final = str(final_url or "")
    if offer_id and offer_id in final:
        if _state_has_live_offer(document, offer_id):
            return "active", "offer_payload"
        # OLX commonly preserves the old canonical URL for removed offers while
        # returning HTTP 200. Without the offer payload this is not a live ad.
        return "inactive", "missing_offer_payload"

    return "unknown", "unrecognized_page"


def _valid_offer_url(portal, value):
    try:
        parsed = urlparse(str(value or "").strip())
        expected = urlparse(portal["host"]).hostname or ""
        host = (parsed.hostname or "").lower()
        allowed = {expected.lower(), expected.lower().removeprefix("www.")}
        return parsed.scheme == "https" and host in allowed
    except ValueError:
        return False


@app.get("/health")
def health():
    return jsonify(ok=True)


@app.post("/olx/check")
def olx_check():
    code = (request.args.get("country") or "").upper()
    portal = PORTALS.get(code)
    if not portal:
        return jsonify(error=f"unknown country {code!r}"), 400

    payload = request.get_json(silent=True) or {}
    offer_id = str(payload.get("id") or "").strip()
    url = str(payload.get("url") or "").strip()
    if not offer_id or not _valid_offer_url(portal, url):
        return jsonify(error="invalid offer id or URL"), 400

    try:
        resp = cffi.get(
            url,
            impersonate=IMPERSONATE,
            timeout=STATUS_TIMEOUT,
            headers={"Accept-Language": portal["lang"]},
            allow_redirects=True,
        )
    except Exception as exc:
        return jsonify(
            country=code,
            id=offer_id,
            status="unknown",
            reason="fetch_error",
            error=str(exc)[:240],
        )

    status, reason = classify_offer_response(
        resp.status_code,
        resp.text if resp.status_code == 200 else "",
        offer_id,
        str(resp.url or ""),
    )
    return jsonify(
        country=code,
        id=offer_id,
        status=status,
        reason=reason,
        httpStatus=resp.status_code,
        finalUrl=str(resp.url or ""),
    )


@app.get("/olx/listings")
def olx_listings():
    code = (request.args.get("country") or "").upper()
    segment = (request.args.get("segment") or "flat:longRent")
    city = (request.args.get("city") or "").strip().lower()
    portal = PORTALS.get(code)

    if not portal:
        return jsonify(error=f"unknown country {code!r}"), 400

    path = portal["paths"].get(segment)
    if not path:
        return jsonify(error=f"unsupported OLX segment {segment!r}"), 400

    if city:
        if not re.fullmatch(r"[a-z0-9-]+", city):
            return jsonify(error=f"invalid OLX city slug {city!r}"), 400
        path = f"{path}/{city}"

    try:
        page = max(1, int(request.args.get("page", "1")))
    except (TypeError, ValueError):
        page = 1

    url = (
        f'{portal["host"]}/{path}/'
        f'?page={page}'
        f'&search%5Border%5D='
        f'created_at%3Adesc'
    )

    where = f"OLX {code} {segment} {city or 'all'}"
    last_err = None
    for attempt in range(ATTEMPTS):
        try:
            resp = cffi.get(
                url,
                impersonate=IMPERSONATE,
                timeout=TIMEOUT,
                headers={"Accept-Language": portal["lang"]},
            )
        except Exception as e:
            last_err = f"fetch error: {e}"
        else:
            if resp.status_code == 200:
                ads = extract_ads(resp.text)
                if ads is not None:
                    visible_ads, cutoff_meta = apply_lookback_page_stop(ads)
                    return jsonify(
                        country=code,
                        segment=segment,
                        city=city or None,
                        page=page,
                        rawCount=len(ads),
                        count=len(visible_ads),
                        ads=visible_ads,
                        **cutoff_meta,
                    )
                last_err = f"{where}: no __PRERENDERED_STATE__"
            else:
                last_err = f"{where} HTTP {resp.status_code}"
        if attempt + 1 < ATTEMPTS:
            time.sleep(RETRY_BACKOFF)
    return jsonify(error=last_err or f"{where}: failed"), 502


@app.get("/fetch/html")
def fetch_html():
    """Fetch an allowlisted, WAF-protected housing page and return raw HTML.

    Extraction stays in Node (custom.js / owner-html.js) — this only gets past
    the TLS-fingerprint block, the same problem OLX has.
    """
    url = (request.args.get("url") or "").strip()
    try:
        parsed = urlparse(url)
    except ValueError:
        return jsonify(error="invalid url"), 400

    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or host not in GENERIC_FETCH_HOSTS:
        return jsonify(error=f"host {host!r} is not allowlisted for /fetch/html"), 400

    try:
        resp = cffi.get(
            url,
            impersonate=IMPERSONATE,
            timeout=GENERIC_FETCH_TIMEOUT,
            headers={"Accept-Language": "uk-UA,uk;q=0.9,ru;q=0.7,en;q=0.5"},
            allow_redirects=True,
        )
    except Exception as exc:
        return jsonify(error=f"fetch error: {exc}"[:240]), 502

    # A redirect off the allowlisted host (e.g. to an internal address) must not
    # be followed transparently — allow_redirects already fetched it, so just
    # refuse to hand the body back rather than trusting an arbitrary final host.
    final_host = (urlparse(str(resp.url or "")).hostname or "").lower()
    if final_host not in GENERIC_FETCH_HOSTS:
        return jsonify(error=f"redirected off-allowlist to {final_host!r}"), 502

    if resp.status_code in (401, 403):
        return jsonify(error="blocked_automated_access", httpStatus=resp.status_code), 502
    if resp.status_code != 200:
        return jsonify(error=f"HTTP {resp.status_code}", httpStatus=resp.status_code), 502

    return jsonify(status=resp.status_code, finalUrl=str(resp.url or ""), html=resp.text)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "4020")))
