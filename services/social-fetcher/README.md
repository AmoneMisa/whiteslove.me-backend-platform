# Social fetcher

Internal public-data fetcher for Facebook, Threads and LinkedIn.

Production runs `main:app`: `main.py` extends the base Flask app from `app.py`
with the public Threads keyword-search and LinkedIn candidate-discovery routes.

## Boundaries

- Public pages only.
- No account login, cookies, session tokens or stored credentials.
- No CAPTCHA solving or anti-bot challenge bypass.
- Facebook does not request comments/reactor lists or member lists.
- Threads profile and keyword search use logged-out public web pages through Playwright.
- LinkedIn job search uses the public `jobs-guest` HTML endpoints.
- LinkedIn candidate discovery uses public search-result snippets for `linkedin.com/in/` and `linkedin.com/posts/` URLs; it does not bypass LinkedIn auth walls.
- Explicit LinkedIn page/post/profile URLs are fetched only when publicly reachable; auth-wall responses are returned as `restricted: true` rather than bypassed.
- Target URLs are host-allowlisted to prevent SSRF.

## API

### Health

```http
GET /health
```

### Generic fetch

```http
POST /fetch
Content-Type: application/json
```

Facebook page or public group:

```json
{
  "source": "facebook",
  "target": "https://www.facebook.com/groups/123456789/",
  "limit": 50
}
```

Threads public profile:

```json
{
  "source": "threads",
  "username": "example",
  "limit": 50
}
```

### Threads public keyword search

```http
POST /threads/search
Content-Type: application/json
```

```json
{
  "query": "аренда Ташкент",
  "limit": 40
}
```

The search uses the public logged-out Threads search page with the Recent filter.
No Threads token, cookie, login or password environment variable is required.

### LinkedIn public jobs

```json
{
  "source": "linkedin",
  "mode": "jobs",
  "keywords": "frontend developer",
  "location": "Tashkent, Uzbekistan",
  "limit": 50,
  "details": false
}
```

### LinkedIn public candidate discovery

```http
POST /linkedin/candidates
Content-Type: application/json
```

```json
{
  "query": "Open to Work Uzbekistan",
  "scope": "both",
  "limit": 20
}
```

`scope` may be `profiles`, `posts` or `both`.

### LinkedIn explicit public URL

```json
{
  "source": "linkedin",
  "mode": "public",
  "url": "https://www.linkedin.com/posts/..."
}
```

The backend exposes these operations internally at `POST /internal/social/fetch`
and requires `X-Queue-Key`, using `SOCIAL_INTERNAL_KEY` or `QUEUE_INTERNAL_KEY`.
It routes Threads `mode=search` to `/threads/search` and LinkedIn
`mode=candidates` to `/linkedin/candidates`.

## Environment

- `SOCIAL_MAX_ITEMS` — hard result cap, default `100`.
- `SOCIAL_HTTP_TIMEOUT` — HTTP timeout in seconds, default `30`.
- `SOCIAL_BROWSER_TIMEOUT_MS` — Playwright navigation timeout, default `45000`.
- `SOCIAL_BROWSER_CONCURRENCY` — concurrent Chromium sessions, default `1`.
- `THREADS_SCROLLS` — maximum public Threads profile/search scroll passes, default `8`.
- `THREADS_BASE_URL` — optional base URL override, default `https://www.threads.com`; normally leave unset.
- `LINKEDIN_MAX_DETAIL_FETCHES` — maximum job detail requests when `details=true`, default `15`.
- `SOCIAL_IMPERSONATE` — curl_cffi browser fingerprint label, default `chrome124`.
