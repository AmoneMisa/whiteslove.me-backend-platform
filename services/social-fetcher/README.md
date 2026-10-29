# Social fetcher

Internal public-data fetcher for Facebook, Threads and LinkedIn.

Production runs `main:app`: `main.py` extends the base Flask app from `app.py`
with the public Threads keyword-search and LinkedIn candidate-discovery routes.

## Boundaries

- Public pages only.
- Facebook can run with one logged-in session (`FACEBOOK_COOKIES`, set on the server, never committed), protected as described under "Facebook session". Nothing else logs in.
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

## Facebook session

Facebook restricts an account that opens several sessions or many pages in a short time. `facebook_guard.py` keeps the
one session safe; the limits are environment settings, and a request that cannot be served is an error (a retry
condition), never an empty completed crawl:

| Setting | Default | Meaning |
|---|---|---|
| `FACEBOOK_MIN_INTERVAL_SECONDS` | 90 | gap between two page loads (±25% jitter); only one runs at a time |
| `FACEBOOK_DAILY_LIMIT` | 120 | page loads in any 24 hours (0 = no limit) |
| `FACEBOOK_PAUSE_HOURS` | 24 | how long Facebook is left alone after the session is rejected (login redirect or a restriction notice) |
| `FACEBOOK_PAUSED_UNTIL` | empty | ISO time until which Facebook is not contacted, e.g. while the account is restricted |
| `FACEBOOK_MAX_WAIT_SECONDS` | 110 | longest a request waits for its turn before it fails with a retry error |
| `FACEBOOK_STATE_FILE` | `/state/facebook.json` in compose | keeps the pause and the budget across restarts |

`GET /health` shows the state under `facebook` (paused, until when, loads in the last 24 hours).
Use the account on the server only: logging in with it from a browser at the same time is what Facebook reads as a second
session. To put cookies in, use a private window, copy them, close the window without logging out, and set
`FACEBOOK_COOKIES` in the server `.env`.
