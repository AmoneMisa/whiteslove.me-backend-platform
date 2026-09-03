import json
import math
import os
import re
import threading
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlparse

from bs4 import BeautifulSoup
from curl_cffi import requests as cffi
from facebook_scraper import get_posts
from flask import Flask, jsonify, request
from playwright.sync_api import sync_playwright

app = Flask(__name__)

MAX_ITEMS = max(1, min(250, int(os.environ.get("SOCIAL_MAX_ITEMS", "100"))))
HTTP_TIMEOUT = max(5, int(os.environ.get("SOCIAL_HTTP_TIMEOUT", "30")))
BROWSER_TIMEOUT_MS = max(5_000, int(os.environ.get("SOCIAL_BROWSER_TIMEOUT_MS", "45000")))
FACEBOOK_SCROLLS = max(1, min(12, int(os.environ.get("FACEBOOK_SCROLLS", "5"))))
THREADS_SCROLLS = max(1, min(20, int(os.environ.get("THREADS_SCROLLS", "8"))))
THREADS_BASE_URL = os.environ.get("THREADS_BASE_URL", "https://www.threads.com").rstrip("/")
LINKEDIN_MAX_DETAIL_FETCHES = max(
    0,
    min(50, int(os.environ.get("LINKEDIN_MAX_DETAIL_FETCHES", "15"))),
)
IMPERSONATE = os.environ.get("SOCIAL_IMPERSONATE", "chrome124")

_BROWSER_GATE = threading.BoundedSemaphore(
    max(1, int(os.environ.get("SOCIAL_BROWSER_CONCURRENCY", "1")))
)


def _parse_facebook_cookies(raw):
    """Accepts a JSON object or a "name=value; name2=value2" cookie header string."""
    text = str(raw or "").strip()
    if not text:
        return None

    try:
        parsed = json.loads(text)
    except (TypeError, ValueError):
        parsed = None
    if isinstance(parsed, dict):
        cookies = {str(k): str(v) for k, v in parsed.items() if v is not None}
        return cookies or None

    cookies = {}
    for part in text.split(";"):
        name, sep, value = part.strip().partition("=")
        name = name.strip()
        if sep and name:
            cookies[name] = value.strip()
    return cookies or None


FACEBOOK_COOKIES = _parse_facebook_cookies(os.environ.get("FACEBOOK_COOKIES"))


def _facebook_playwright_cookies():
    if not FACEBOOK_COOKIES:
        return []
    return [
        {"name": name, "value": value, "domain": ".facebook.com", "path": "/"}
        for name, value in FACEBOOK_COOKIES.items()
    ]


def _limit(value, default=50):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(1, min(MAX_ITEMS, parsed))


def _iso(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        text = str(value).strip()
        if not text:
            return None
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(text)
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def _clean_text(value):
    return re.sub(r"\n{3,}", "\n\n", str(value or "").replace("\u00a0", " ")).strip()


def _host_matches(host, allowed):
    host = (host or "").lower().split(":", 1)[0].strip(".")
    return any(host == item or host.endswith(f".{item}") for item in allowed)


def _validate_public_url(value, allowed_hosts):
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("Missing URL")
    parsed = urlparse(raw)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("Only http/https URLs are allowed")
    if not _host_matches(parsed.hostname, allowed_hosts):
        raise ValueError(f"Unsupported host: {parsed.hostname or '<empty>'}")
    if parsed.username or parsed.password:
        raise ValueError("Credentials in URLs are not allowed")
    return raw


def _facebook_target(value):
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("Missing Facebook target")

    if not re.match(r"^https?://", raw, re.I):
        if not re.fullmatch(r"[A-Za-z0-9_.-]{2,120}", raw):
            raise ValueError("Invalid Facebook page/group identifier")
        return {"kind": "page", "value": raw}

    url = _validate_public_url(raw, {"facebook.com", "fb.com"})
    parsed = urlparse(url)
    parts = [part for part in parsed.path.split("/") if part]

    if len(parts) >= 2 and parts[0].lower() == "groups":
        return {"kind": "group", "value": parts[1]}

    if parts and parts[0].lower() == "profile.php":
        profile_id = parse_qs(parsed.query).get("id", [None])[0]
        if profile_id and re.fullmatch(r"\d+", profile_id):
            return {"kind": "page", "value": profile_id}

    if not parts:
        raise ValueError("Facebook URL does not identify a page/group")

    return {"kind": "page", "value": parts[0]}


def _normalize_facebook_post(post, target):
    post_id = post.get("post_id")
    post_url = post.get("post_url") or post.get("link") or ""
    text = post.get("text") or post.get("post_text") or post.get("shared_text") or ""
    images = []
    for key in ("images", "images_lowquality"):
        values = post.get(key)
        if isinstance(values, list):
            images.extend(item for item in values if item)
    if post.get("image"):
        images.append(post["image"])

    author = post.get("username") or post.get("user_name") or post.get("user_id")

    return {
        "id": str(post_id or post_url or ""),
        "source": "facebook",
        "target": target,
        "author": str(author or ""),
        "text": _clean_text(text),
        "url": str(post_url or ""),
        "createdAt": _iso(post.get("time")),
        "images": list(dict.fromkeys(str(item) for item in images if item)),
        "video": post.get("video"),
        "likes": post.get("likes"),
        "comments": post.get("comments"),
        "shares": post.get("shares"),
    }


def _facebook_public_url(target_raw, target):
    raw = str(target_raw or "").strip()
    if re.match(r"^https?://", raw, re.I):
        return _validate_public_url(raw, {"facebook.com", "fb.com"})
    if target["kind"] == "group":
        return f"https://www.facebook.com/groups/{target['value']}/"
    return f"https://www.facebook.com/{target['value']}/"


def _normalize_browser_facebook_item(item, target):
    return {
        "id": str(item.get("id") or item.get("url") or ""),
        "source": "facebook",
        "target": target,
        "author": str(item.get("author") or ""),
        "text": _clean_text(item.get("text")),
        "url": str(item.get("url") or target),
        "createdAt": _iso(item.get("createdAt")),
        "images": list(dict.fromkeys(str(value) for value in (item.get("images") or []) if value)),
        "video": None,
        "likes": None,
        "comments": None,
        "shares": None,
    }


def _facebook_dom_items(page):
    return page.evaluate(
        """
        () => {
          const absolute = (href) => {
            try { return new URL(href, location.origin); } catch { return null; }
          };
          const postId = (url) => {
            let match = url.pathname.match(/\/groups\/[^/]+\/(?:posts|permalink)\/([^/?#]+)/i);
            if (match) return match[1];
            match = url.pathname.match(/\/posts\/([^/?#]+)/i);
            if (match) return match[1];
            return url.searchParams.get('story_fbid') || '';
          };
          const canonical = (url) => {
            url.hash = '';
            const id = url.searchParams.get('story_fbid');
            const owner = url.searchParams.get('id');
            if (id) {
              url.search = '';
              url.searchParams.set('story_fbid', id);
              if (owner) url.searchParams.set('id', owner);
              return url.href;
            }
            url.search = '';
            return url.href;
          };
          const links = [...document.querySelectorAll(
            'a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid="]'
          )];
          const unique = new Map();

          for (const link of links) {
            const url = absolute(link.getAttribute('href'));
            if (!url || !/(^|\.)facebook\.com$/i.test(url.hostname.replace(/^www\./i, ''))) continue;
            const id = postId(url);
            if (!id || unique.has(id)) continue;

            let article = link.closest('[role="article"]');
            if (!article) {
              let node = link;
              for (let depth = 0; depth < 10 && node; depth += 1, node = node.parentElement) {
                if (!(node instanceof HTMLElement)) continue;
                const text = (node.innerText || '').trim();
                const postLinks = node.querySelectorAll?.(
                  'a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid="]'
                )?.length || 0;
                if (text.length >= 12 && text.length <= 5000 && postLinks <= 3) article = node;
                if (postLinks > 3) break;
              }
            }
            article = article || link.parentElement || link;
            const text = (article.innerText || '').trim();
            if (!text) continue;

            const authorNode = article.querySelector?.('h2 a, h3 a, strong a');
            const timeNode = article.querySelector?.('time[datetime]');
            const images = [...(article.querySelectorAll?.('img[src]') || [])]
              .filter((img) => (img.naturalWidth || img.width || 0) >= 120)
              .map((img) => img.currentSrc || img.src || '')
              .filter((src) => src && !src.startsWith('data:'));

            unique.set(id, {
              id,
              author: (authorNode?.innerText || '').trim(),
              text,
              url: canonical(url),
              createdAt: timeNode?.getAttribute('datetime') || null,
              images: [...new Set(images)],
            });
          }
          return [...unique.values()];
        }
        """
    )


def _facebook_restriction_reason(page):
    current = str(page.url or "")
    lowered_url = current.lower()
    try:
        text = _clean_text(page.locator("body").inner_text(timeout=2_000)).lower()
    except Exception:
        text = ""

    if "/login" in lowered_url or "checkpoint" in lowered_url:
        return f"redirected to {current}"

    markers = (
        "you must log in to continue",
        "log into facebook to start sharing",
        "log in to facebook to continue",
        "this content isn't available right now",
        "this content is not available right now",
        "this content isn't available",
        "this group is private",
        "private group",
    )
    for marker in markers:
        if marker in text:
            return marker
    return None


def _fetch_facebook_playwright(target_raw, target, limit):
    url = _facebook_public_url(target_raw, target)

    with _BROWSER_GATE:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = _browser_context(browser)
            cookies = _facebook_playwright_cookies()
            if cookies:
                context.add_cookies(cookies)
            page = context.new_page()
            page.set_default_timeout(BROWSER_TIMEOUT_MS)
            page.goto(url, wait_until="domcontentloaded", timeout=BROWSER_TIMEOUT_MS)

            collected = {}
            stagnant = 0
            for _ in range(FACEBOOK_SCROLLS):
                before = len(collected)
                for item in _facebook_dom_items(page):
                    item_id = str(item.get("id") or item.get("url") or "")
                    if not item_id:
                        continue
                    collected[item_id] = item
                    if len(collected) >= limit:
                        break
                if len(collected) >= limit:
                    break
                stagnant = stagnant + 1 if len(collected) == before else 0
                if stagnant >= 2:
                    break
                page.mouse.wheel(0, 2200)
                page.wait_for_timeout(850)

            final_url = page.url
            restriction = _facebook_restriction_reason(page) if not collected else None
            browser.close()

    if restriction:
        raise RuntimeError(f"Facebook public page is restricted: {restriction}")

    items = [
        _normalize_browser_facebook_item(item, target_raw)
        for item in list(collected.values())[:limit]
    ]
    items = [item for item in items if item["id"] and item["text"]]
    if not items:
        raise RuntimeError(f"Facebook public page returned no readable posts: {final_url}")
    return items


def fetch_facebook(payload):
    target_raw = payload.get("target") or payload.get("url") or payload.get("page")
    target = _facebook_target(target_raw)
    limit = _limit(payload.get("limit"), 50)
    pages = max(1, min(20, math.ceil(limit / 8)))

    kwargs = {
        "pages": pages,
        "options": {"allow_extra_requests": False},
    }
    if FACEBOOK_COOKIES:
        kwargs["cookies"] = dict(FACEBOOK_COOKIES)

    primary_error = None
    items = []
    try:
        if target["kind"] == "group":
            kwargs["group"] = target["value"]
            iterator = get_posts(**kwargs)
        else:
            iterator = get_posts(target["value"], **kwargs)

        for post in iterator:
            normalized = _normalize_facebook_post(post, target_raw)
            if not normalized["id"]:
                continue
            items.append(normalized)
            if len(items) >= limit:
                break
    except Exception as exc:
        primary_error = f"{type(exc).__name__}: {exc}"

    if items:
        return {
            "ok": True,
            "source": "facebook",
            "target": target_raw,
            "fetchMode": "facebook-scraper",
            "count": len(items),
            "items": items,
        }

    try:
        items = _fetch_facebook_playwright(target_raw, target, limit)
    except Exception as exc:
        primary = primary_error or "returned 0 readable posts"
        fallback = f"{type(exc).__name__}: {exc}"
        raise RuntimeError(
            f"Facebook fetch failed; facebook-scraper={primary}; playwright={fallback}"
        ) from exc

    return {
        "ok": True,
        "source": "facebook",
        "target": target_raw,
        "fetchMode": "playwright",
        "primaryError": primary_error,
        "count": len(items),
        "items": items,
    }


def _threads_username(value):
    username = str(value or "").strip().lstrip("@")
    if not re.fullmatch(r"[A-Za-z0-9._]{1,64}", username):
        raise ValueError("Invalid Threads username")
    return username


def _browser_context(browser):
    context = browser.new_context(
        locale="en-US",
        viewport={"width": 1280, "height": 900},
        user_agent=(
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        ),
    )

    def route_handler(route):
        if route.request.resource_type in {"media", "font"}:
            route.abort()
        else:
            route.continue_()

    context.route("**/*", route_handler)
    return context


def _threads_dom_items(page):
    return page.evaluate(
        """
        () => {
          const absolute = (href) => {
            try { return new URL(href, location.origin).href; } catch { return ''; }
          };
          const unique = new Map();
          const links = [...document.querySelectorAll('a[href*="/post/"]')];
          for (const link of links) {
            const href = absolute(link.getAttribute('href'));
            const match = href.match(/\/(@[^/]+)\/post\/([^/?#]+)/i);
            if (!match) continue;
            const id = match[2];
            if (unique.has(id)) continue;

            let node = link;
            let best = null;
            for (let depth = 0; depth < 9 && node; depth += 1, node = node.parentElement) {
              if (!(node instanceof HTMLElement)) continue;
              const text = (node.innerText || '').trim();
              const postLinks = node.querySelectorAll?.('a[href*="/post/"]')?.length || 0;
              if (text.length >= 4 && text.length <= 3500 && postLinks <= 2) {
                best = node;
              }
              if (postLinks > 2) break;
            }
            best = best || link.parentElement || link;
            const text = (best.innerText || '').trim();
            const time = best.querySelector?.('time');
            const images = [...(best.querySelectorAll?.('img') || [])]
              .map((img) => img.currentSrc || img.src || '')
              .filter((src) => src && !src.startsWith('data:'));

            unique.set(id, {
              id,
              username: match[1].replace(/^@/, ''),
              text,
              url: href,
              createdAt: time?.getAttribute('datetime') || null,
              images: [...new Set(images)],
            });
          }
          return [...unique.values()];
        }
        """
    )


def fetch_threads(payload):
    username = _threads_username(payload.get("username") or payload.get("target"))
    limit = _limit(payload.get("limit"), 50)
    url = f"{THREADS_BASE_URL}/@{username}"

    with _BROWSER_GATE:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = _browser_context(browser)
            page = context.new_page()
            page.set_default_timeout(BROWSER_TIMEOUT_MS)
            page.goto(url, wait_until="domcontentloaded", timeout=BROWSER_TIMEOUT_MS)

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
        items.append({
            "id": item["id"],
            "source": "threads",
            "target": username,
            "author": item.get("username") or username,
            "text": _clean_text(item.get("text")),
            "url": item.get("url") or "",
            "createdAt": _iso(item.get("createdAt")),
            "images": item.get("images") or [],
        })

    return {
        "ok": True,
        "source": "threads",
        "target": username,
        "count": len(items),
        "items": items,
    }


def _http_get(url, *, params=None):
    response = cffi.get(
        url,
        params=params,
        impersonate=IMPERSONATE,
        timeout=HTTP_TIMEOUT,
        headers={
            "Accept-Language": "en-US,en;q=0.9",
            "User-Agent": (
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            ),
        },
    )
    response.raise_for_status()
    return response


def _linkedin_job_id(card):
    urn = card.get("data-entity-urn") or ""
    match = re.search(r"jobPosting:(\d+)", urn)
    if match:
        return match.group(1)

    urn_node = card.select_one("[data-entity-urn*='jobPosting:']")
    if urn_node:
        match = re.search(r"jobPosting:(\d+)", urn_node.get("data-entity-urn") or "")
        if match:
            return match.group(1)

    link = card.select_one("a.base-card__full-link, a[href*='/jobs/view/']")
    href = link.get("href", "") if link else ""
    match = re.search(r"/jobs/view/(?:[^/?#]*-)?(\d+)", href)
    return match.group(1) if match else ""


def _linkedin_job_description(job_id):
    if not job_id:
        return ""
    response = _http_get(
        f"https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{job_id}"
    )
    soup = BeautifulSoup(response.text, "html.parser")
    node = soup.select_one(
        ".show-more-less-html__markup, .description__text, .decorated-job-posting__details"
    )
    return _clean_text(node.get_text("\n", strip=True) if node else "")


def _parse_linkedin_jobs_html(html, *, details=False):
    soup = BeautifulSoup(html, "html.parser")
    cards = soup.select("li")
    items = []
    detail_budget = LINKEDIN_MAX_DETAIL_FETCHES if details else 0

    for card in cards:
        job_id = _linkedin_job_id(card)
        if not job_id:
            continue

        title_node = card.select_one(".base-search-card__title, h3")
        company_node = card.select_one(".base-search-card__subtitle, h4")
        location_node = card.select_one(".job-search-card__location")
        link_node = card.select_one("a.base-card__full-link, a[href*='/jobs/view/']")
        time_node = card.select_one("time")

        title = _clean_text(title_node.get_text(" ", strip=True) if title_node else "")
        company = _clean_text(company_node.get_text(" ", strip=True) if company_node else "")
        location = _clean_text(location_node.get_text(" ", strip=True) if location_node else "")
        url = str(link_node.get("href", "") if link_node else "")
        created_at = time_node.get("datetime") if time_node else None

        description = ""
        if detail_budget > 0:
            try:
                description = _linkedin_job_description(job_id)
            except Exception:
                description = ""
            detail_budget -= 1

        items.append({
            "id": job_id,
            "source": "linkedin",
            "kind": "job",
            "title": title,
            "company": company,
            "location": location,
            "text": description,
            "url": url,
            "createdAt": _iso(created_at),
        })

    return items


def fetch_linkedin_jobs(payload):
    keywords = _clean_text(payload.get("keywords") or payload.get("query"))
    location = _clean_text(payload.get("location"))
    limit = _limit(payload.get("limit"), 50)
    try:
        start = max(0, int(payload.get("start") or 0))
    except (TypeError, ValueError):
        start = 0
    details = bool(payload.get("details"))

    params = {
        "keywords": keywords,
        "location": location,
        "start": start,
    }
    if payload.get("timeRange"):
        params["f_TPR"] = str(payload["timeRange"])

    response = _http_get(
        "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search",
        params=params,
    )
    items = _parse_linkedin_jobs_html(response.text, details=details)[:limit]

    return {
        "ok": True,
        "source": "linkedin",
        "mode": "jobs",
        "query": keywords,
        "location": location,
        "start": start,
        "count": len(items),
        "items": items,
    }


def fetch_linkedin_public(payload):
    url = _validate_public_url(payload.get("url"), {"linkedin.com"})
    response = _http_get(url)
    soup = BeautifulSoup(response.text, "html.parser")
    lowered = response.text.lower()
    restricted = (
        "authwall" in lowered
        or "sign in to linkedin" in lowered
        or "join linkedin" in lowered
    )

    canonical = soup.select_one("link[rel='canonical']")
    title = soup.title.get_text(" ", strip=True) if soup.title else ""
    description = soup.select_one("meta[property='og:description'], meta[name='description']")
    description_text = description.get("content", "") if description else ""
    main = soup.select_one("main")
    body_text = _clean_text(main.get_text("\n", strip=True) if main else "")

    return {
        "ok": True,
        "source": "linkedin",
        "mode": "public",
        "restricted": restricted,
        "count": 1 if (title or description_text or body_text) else 0,
        "items": [{
            "id": canonical.get("href") if canonical else url,
            "source": "linkedin",
            "kind": "public_page",
            "title": _clean_text(title),
            "text": body_text or _clean_text(description_text),
            "url": canonical.get("href") if canonical else url,
            "restricted": restricted,
        }],
    }


def fetch_linkedin(payload):
    mode = str(payload.get("mode") or "jobs").strip().lower()
    if mode == "jobs":
        return fetch_linkedin_jobs(payload)
    if mode in {"public", "page", "post", "profile"}:
        return fetch_linkedin_public(payload)
    raise ValueError("LinkedIn mode must be 'jobs' or 'public'")


def run_fetch(payload):
    source = str(payload.get("source") or "").strip().lower()
    if source == "facebook":
        return fetch_facebook(payload)
    if source == "threads":
        return fetch_threads(payload)
    if source == "linkedin":
        return fetch_linkedin(payload)
    raise ValueError("source must be facebook, threads or linkedin")


@app.get("/health")
def health():
    return jsonify(
        ok=True,
        sources=["facebook", "threads", "linkedin"],
        authMode="facebook-cookie" if FACEBOOK_COOKIES else "public-only",
    )


@app.post("/fetch")
def fetch_route():
    payload = request.get_json(silent=True) or {}
    try:
        return jsonify(run_fetch(payload))
    except ValueError as exc:
        return jsonify(ok=False, error=str(exc)), 400
    except Exception as exc:
        return jsonify(ok=False, error=f"{type(exc).__name__}: {exc}"), 502


@app.get("/linkedin/jobs")
def linkedin_jobs_route():
    try:
        payload = dict(request.args)
        payload["source"] = "linkedin"
        payload["mode"] = "jobs"
        payload["details"] = str(request.args.get("details", "")).lower() in {"1", "true", "yes"}
        return jsonify(fetch_linkedin_jobs(payload))
    except ValueError as exc:
        return jsonify(ok=False, error=str(exc)), 400
    except Exception as exc:
        return jsonify(ok=False, error=f"{type(exc).__name__}: {exc}"), 502


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "4040")))