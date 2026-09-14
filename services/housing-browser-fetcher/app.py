# Housing-site browser fetcher sidecar.
#
# Some housing catalogues (domza.uz, uybor.uz) were rebuilt as client-rendered
# SPAs: a plain HTTP fetch gets back a near-empty shell, because the actual
# listing cards are populated by a client-side data fetch that runs after the
# page mounts. This sidecar loads the page in a real headless Chromium, waits
# for that fetch to settle, and hands back the fully rendered HTML.
#
# Extraction stays in Node (custom.js / owner-html.js) — this only gets past
# the "no JS execution" problem, mirroring the division of labor the
# olx-fetcher sidecar's /fetch/html endpoint already uses for a different
# problem (a TLS-fingerprint WAF instead of client-side rendering).
#
# Restricted to an explicit host allowlist so this sidecar can't be used as an
# open browser-rendering proxy.

import os
import threading
from urllib.parse import urlparse

from flask import Flask, jsonify, request
from playwright.sync_api import sync_playwright

app = Flask(__name__)

BROWSER_TIMEOUT_MS = max(5_000, int(os.environ.get("HOUSING_BROWSER_TIMEOUT_MS", "30000")))
# A brief settle window after the network goes idle: some SPAs still run one
# more render tick (e.g. a map/list sync) right after their last fetch resolves.
SETTLE_TIMEOUT_MS = max(0, int(os.environ.get("HOUSING_BROWSER_SETTLE_MS", "1500")))

# Hosts other scrapers are allowed to fetch through /fetch/html. Keep this
# tight — it's a fetch-by-URL endpoint, so anything added here is effectively
# trusted to be a real housing site, not an SSRF target picked by a caller.
ALLOWED_HOSTS = {
    h.strip().lower()
    for h in os.environ.get("PLAYWRIGHT_FETCH_HOSTS", "domza.uz,uybor.uz,x-estate.com").split(",")
    if h.strip()
}

# Chromium instances are heavy; cap how many run at once regardless of how
# many gunicorn threads are handling requests concurrently.
_BROWSER_GATE = threading.BoundedSemaphore(
    max(1, int(os.environ.get("HOUSING_BROWSER_CONCURRENCY", "2")))
)


def _normalized_host(value):
    return str(value or "").strip().lower().removeprefix("www.")


def _browser_context(browser):
    context = browser.new_context(
        locale="en-US",
        viewport={"width": 1366, "height": 900},
        user_agent=(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
        ),
    )

    def route_handler(route):
        # We only ever read the DOM, never render it visually — skip the
        # bytes that don't affect what page.content() returns.
        if route.request.resource_type in {"image", "media", "font"}:
            route.abort()
        else:
            route.continue_()

    context.route("**/*", route_handler)
    return context


def render_html(url):
    """Load url in a real browser and return (html, final_url) once the
    page's own client-side data fetch has had a chance to settle."""
    with _BROWSER_GATE:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                context = _browser_context(browser)
                page = context.new_page()
                page.set_default_timeout(BROWSER_TIMEOUT_MS)
                page.goto(url, wait_until="domcontentloaded", timeout=BROWSER_TIMEOUT_MS)
                try:
                    page.wait_for_load_state("networkidle", timeout=BROWSER_TIMEOUT_MS)
                except Exception:
                    # A slow trailing connection (analytics, a websocket) must
                    # not fail the whole fetch — whatever rendered by now is
                    # still worth returning.
                    pass
                if SETTLE_TIMEOUT_MS:
                    page.wait_for_timeout(SETTLE_TIMEOUT_MS)
                html = page.content()
                final_url = page.url
            finally:
                browser.close()
    return html, final_url


@app.get("/health")
def health():
    return jsonify(ok=True, allowedHosts=sorted(ALLOWED_HOSTS))


@app.get("/fetch/html")
def fetch_html():
    """Render an allowlisted, client-rendered housing page and return its DOM.

    Extraction stays in Node (custom.js / owner-html.js) — this only waits for
    the client-side fetch that populates the catalogue to settle.
    """
    url = (request.args.get("url") or "").strip()
    try:
        parsed = urlparse(url)
    except ValueError:
        return jsonify(error="invalid url"), 400

    host = _normalized_host(parsed.hostname)
    if parsed.scheme != "https" or host not in ALLOWED_HOSTS:
        return jsonify(error=f"host {host!r} is not allowlisted for /fetch/html"), 400

    try:
        html, final_url = render_html(url)
    except Exception as exc:
        return jsonify(error=f"render error: {exc}"[:240]), 502

    # A redirect off the allowlisted host (e.g. to an internal address) must
    # not be handed back transparently.
    final_host = _normalized_host(urlparse(final_url).hostname)
    if final_host not in ALLOWED_HOSTS:
        return jsonify(error=f"redirected off-allowlist to {final_host!r}"), 502

    return jsonify(status=200, finalUrl=final_url, html=html)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "4040")))
