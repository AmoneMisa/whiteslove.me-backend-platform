from urllib.parse import parse_qs, quote_plus, unquote, urlparse

from bs4 import BeautifulSoup
from flask import jsonify, request
from playwright.sync_api import sync_playwright

from app import (
    BROWSER_TIMEOUT_MS,
    THREADS_BASE_URL,
    THREADS_SCROLLS,
    _BROWSER_GATE,
    _browser_context,
    _clean_text,
    _http_get,
    _iso,
    _limit,
    _threads_dom_items,
    app,
)


def _threads_query(value):
    query = _clean_text(value)
    if len(query) < 2 or len(query) > 160:
        raise ValueError("Threads search query must be 2-160 characters")
    return query


def _wait_for_threads_results(page):
    """Give the logged-out SPA a moment to hydrate before reading post anchors."""
    try:
        page.wait_for_selector(
            'a[href*="/post/"]',
            state="attached",
            timeout=min(BROWSER_TIMEOUT_MS, 8000),
        )
    except Exception:
        # Empty searches and logged-out interstitials legitimately have no post
        # anchor. A short final delay lets late client-side rendering settle
        # without turning every empty query into a full browser timeout.
        page.wait_for_timeout(1200)


def fetch_threads_search(payload):
    query = _threads_query(payload.get("query") or payload.get("target"))
    limit = _limit(payload.get("limit"), 50)
    # Threads' logged-out Recent search is public. The explicit filter keeps
    # candidate discovery fresh; /hiring applies its own three-month retention
    # after parsing the returned post timestamps.
    url = (
        f"{THREADS_BASE_URL}/search?q={quote_plus(query)}"
        "&serp_type=default&filter=recent"
    )

    with _BROWSER_GATE:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = _browser_context(browser)
            page = context.new_page()
            page.set_default_timeout(BROWSER_TIMEOUT_MS)
            page.goto(url, wait_until="domcontentloaded", timeout=BROWSER_TIMEOUT_MS)
            _wait_for_threads_results(page)

            collected = {}
            for _ in range(THREADS_SCROLLS):
                for item in _threads_dom_items(page):
                    collected[item["id"]] = item
                    if len(collected) >= limit:
                        break
                if len(collected) >= limit:
                    break
                page.mouse.wheel(0, 1800)
                page.wait_for_timeout(650)

            browser.close()

    items = []
    for item in list(collected.values())[:limit]:
        items.append(
            {
                "id": item["id"],
                "source": "threads",
                "target": query,
                "author": item.get("username") or "",
                "text": _clean_text(item.get("text")),
                "url": item.get("url") or "",
                "createdAt": _iso(item.get("createdAt")),
                "images": item.get("images") or [],
            }
        )

    return {
        "ok": True,
        "source": "threads",
        "mode": "search",
        "target": query,
        "query": query,
        "count": len(items),
        "items": items,
    }


def _linkedin_candidate_query(value):
    query = _clean_text(value)
    if len(query) < 2 or len(query) > 180:
        raise ValueError("LinkedIn candidate query must be 2-180 characters")
    return query


def _duckduckgo_target(href):
    raw = str(href or "").strip()
    if not raw:
        return ""
    parsed = urlparse(raw)
    if parsed.hostname and parsed.hostname.endswith("duckduckgo.com"):
        target = parse_qs(parsed.query).get("uddg", [""])[0]
        raw = unquote(target) if target else raw
    try:
        parsed = urlparse(raw)
    except ValueError:
        return ""
    host = (parsed.hostname or "").lower()
    if host not in {"linkedin.com", "www.linkedin.com"}:
        return ""
    path = parsed.path.lower()
    if not (path.startswith("/in/") or path.startswith("/posts/")):
        return ""
    return raw.split("?", 1)[0]


def fetch_linkedin_candidates(payload):
    query = _linkedin_candidate_query(payload.get("query") or payload.get("target"))
    limit = min(_limit(payload.get("limit"), 20), 40)
    scope = str(payload.get("scope") or "both").strip().lower()
    if scope not in {"profiles", "posts", "both"}:
        raise ValueError("LinkedIn candidate scope must be profiles, posts or both")

    site_terms = []
    if scope in {"profiles", "both"}:
        site_terms.append("site:linkedin.com/in/")
    if scope in {"posts", "both"}:
        site_terms.append("site:linkedin.com/posts/")
    search_query = f"({' OR '.join(site_terms)}) {query}"

    response = _http_get(
        "https://html.duckduckgo.com/html/",
        params={"q": search_query},
    )
    soup = BeautifulSoup(response.text, "html.parser")
    items = []
    seen = set()

    for result in soup.select(".result"):
        link = result.select_one("a.result__a")
        if not link:
            continue
        url = _duckduckgo_target(link.get("href", ""))
        if not url or url in seen:
            continue
        seen.add(url)

        title = _clean_text(link.get_text(" ", strip=True))
        snippet_node = result.select_one(".result__snippet")
        snippet = _clean_text(snippet_node.get_text(" ", strip=True) if snippet_node else "")
        text = _clean_text(f"{title}\n{snippet}")
        if not text:
            continue

        path = urlparse(url).path.lower()
        kind = "profile" if path.startswith("/in/") else "post"
        items.append(
            {
                "id": url,
                "source": "linkedin",
                "kind": kind,
                "target": query,
                "author": title.split(" - ", 1)[0].split(" | ", 1)[0].strip(),
                "title": title,
                "text": text,
                "url": url,
                # Search result pages do not expose a trustworthy LinkedIn
                # publication timestamp. The consumer records discovery time
                # separately instead of inventing a source publication date.
                "createdAt": None,
                "images": [],
            }
        )
        if len(items) >= limit:
            break

    return {
        "ok": True,
        "source": "linkedin",
        "mode": "candidates",
        "target": query,
        "query": query,
        "scope": scope,
        "count": len(items),
        "items": items,
    }


@app.post("/threads/search")
def threads_search_route():
    payload = request.get_json(silent=True) or {}
    try:
        return jsonify(fetch_threads_search(payload))
    except ValueError as exc:
        return jsonify(ok=False, error=str(exc)), 400
    except Exception as exc:
        return jsonify(ok=False, error=f"{type(exc).__name__}: {exc}"), 502


@app.post("/linkedin/candidates")
def linkedin_candidates_route():
    payload = request.get_json(silent=True) or {}
    try:
        return jsonify(fetch_linkedin_candidates(payload))
    except ValueError as exc:
        return jsonify(ok=False, error=str(exc)), 400
    except Exception as exc:
        return jsonify(ok=False, error=f"{type(exc).__name__}: {exc}"), 502
