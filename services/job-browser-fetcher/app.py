import ipaddress
import os
import threading
import time
from email.utils import parsedate_to_datetime
from urllib.parse import urljoin, urlparse

from curl_cffi import requests as cffi
from flask import Flask, Response, jsonify, request

app = Flask(__name__)

IMPERSONATE = os.environ.get("JOB_BROWSER_IMPERSONATE", "chrome124")
TIMEOUT = float(os.environ.get("JOB_BROWSER_TIMEOUT", "25"))
ATTEMPTS = max(1, int(os.environ.get("JOB_BROWSER_ATTEMPTS", "2")))
RETRY_BACKOFF = max(0.0, float(os.environ.get("JOB_BROWSER_RETRY_BACKOFF", "2")))
RATE_LIMIT_COOLDOWN = max(30, int(os.environ.get("JOB_BROWSER_429_COOLDOWN", "900")))
BLOCK_COOLDOWN = max(30, int(os.environ.get("JOB_BROWSER_403_COOLDOWN", "900")))
MAX_RETRY_SLEEP = max(0.0, float(os.environ.get("JOB_BROWSER_MAX_RETRY_SLEEP", "8")))
MAX_REDIRECTS = max(0, min(10, int(os.environ.get("JOB_BROWSER_MAX_REDIRECTS", "5"))))

DEFAULT_ALLOWED_HOSTS = {
    "flagma.uz",
    "flagma.ro",
    "flagma.kg",
    "jobs.ua",
    "work.ua",
    "robota.ua",
    "djinni.co",
    "jobs.dou.ua",
    "api.hh.ru",
    "hh.kz",
    "headhunter.kg",
    "resume.uz",
    "enbek.kz",
    "qsamruk.kz",
    "newjob.kg",
    "kyzmat.gov.kg",
    "ejobs.ro",
    "bestjobs.eu",
    "hipo.ro",
    "taskfavour.com",
    "remote.co",
    "simplyhired.com",
    "visajobsearch.com",
    "visajobfinder.com",
    "migratemate.co",
    "gcsservices.careers.microsoft.com",

    # Registry-style job boards executed by the shared cyclic crawler.
    "indeed.com",
    "glassdoor.com",
    "careerjet.com",
    "ziprecruiter.com",
    "monster.com",
    "talent.com",
    "careerbuilder.com",
    "jora.com",
    "jobisjob.com",
    "getwork.com",
    "lensa.com",
    "weworkremotely.com",
    "dynamitejobs.com",
    "justremote.co",
    "remotehub.com",
    "remote4.me",
    "dailyremote.com",
    "remote.com",
    "remotejobs.com",
    "workew.com",
    "nodesk.co",
    "pangian.com",
    "rocketshipjobs.com",
    "jobgether.com",
    "hiring.cafe",
    "remotejobfor.me",
    "sydicom.app",
    "turing.com",
    "arc.dev",
    "crossover.com",
    "gun.io",
    "landing.jobs",
    "offerzen.com",
    "devitjobs.com",
    "jsremotely.com",
    "golang.cafe",
    "python.org",
    "rubynow.com",
    "aijobs.net",
    "upwork.com",
    "fiverr.com",
    "freelancer.com",
    "toptal.com",
    "app.usebraintrust.com",
    "contra.com",
    "guru.com",
    "peopleperhour.com",
    "workana.com",
    "truelancer.com",
    "talent.hubstaff.com",
    "solidgigs.com",
    "gocatalant.com",
    "cloudpeeps.com",
    "kolabtree.com",
    "bark.com",
    "dribbble.com",
    "behance.net",
    "krop.com",
    "coroflot.com",
    "designjobsboard.com",
    "workingnotworking.com",
    "creativepool.com",
    "designcrowd.com",
    "problogger.com",
    "freelancewriting.com",
    "contena.co",
    "bloggingpro.com",
    "writeraccess.com",
    "clearvoice.com",
    "marketerhire.com",
    "mediabistro.com",
    "superpath.co",
    "proz.com",
    "translatorscafe.com",
    "gengo.com",
    "smartcat.com",
    "preply.com",
    "teach.italki.com",
    "cambly.com",
    "modsquad.com",
    "supportadventure.com",
    "jobs.workingsolutions.com",
    "belaysolutions.com",
    "web.timeetc.com",
    "airbus.com",
    "jobs.siemens.com",
    "jobs.lever.co",
    "neworbit.space",
    "job-boards.greenhouse.io",
    "himalayas.app",
}
EXTRA_ALLOWED_HOSTS = {
    value.strip().lower().removeprefix("www.")
    for value in os.environ.get("JOB_BROWSER_ALLOWED_HOSTS", "").split(",")
    if value.strip()
}
ALLOWED_HOSTS = DEFAULT_ALLOWED_HOSTS | EXTRA_ALLOWED_HOSTS

_cooldowns: dict[str, float] = {}
_cooldowns_lock = threading.Lock()


def normalized_host(value: str) -> str:
    return value.strip().lower().rstrip(".").removeprefix("www.")


def allowed_url(raw: str):
    try:
        parsed = urlparse(raw)
    except ValueError:
        return None
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        return None
    host = normalized_host(parsed.hostname)
    if host not in ALLOWED_HOSTS:
        return None
    try:
        ipaddress.ip_address(host)
        return None
    except ValueError:
        pass
    return parsed


def retry_after_seconds(value: str | None) -> float | None:
    if not value:
        return None
    try:
        seconds = float(value)
        return max(0.0, seconds)
    except ValueError:
        pass
    try:
        dt = parsedate_to_datetime(value)
        return max(0.0, dt.timestamp() - time.time())
    except (TypeError, ValueError, OverflowError):
        return None


def cooldown_remaining(host: str) -> int:
    with _cooldowns_lock:
        until = _cooldowns.get(host, 0.0)
        if until <= time.time():
            _cooldowns.pop(host, None)
            return 0
        return max(1, int(until - time.time()))


def set_cooldown(host: str, seconds: float):
    with _cooldowns_lock:
        _cooldowns[host] = max(_cooldowns.get(host, 0.0), time.time() + seconds)


def proxy_response(upstream) -> Response:
    content_type = upstream.headers.get("content-type") or "text/plain; charset=utf-8"
    response = Response(upstream.content, status=upstream.status_code, content_type=content_type)
    retry_after = upstream.headers.get("retry-after")
    if retry_after:
        response.headers["Retry-After"] = retry_after
    response.headers["X-Job-Browser-Fetcher"] = IMPERSONATE
    return response


def chrome_get(raw_url: str, headers: dict[str, str]):
    current_url = raw_url
    for redirect in range(MAX_REDIRECTS + 1):
        if not allowed_url(current_url):
            raise ValueError("redirect target host is not allowed")
        upstream = cffi.get(
            current_url,
            impersonate=IMPERSONATE,
            timeout=TIMEOUT,
            allow_redirects=False,
            headers=headers,
        )
        if upstream.status_code not in {301, 302, 303, 307, 308}:
            return upstream
        location = upstream.headers.get("location")
        if not location:
            return upstream
        if redirect >= MAX_REDIRECTS:
            raise RuntimeError("too many redirects")
        current_url = urljoin(current_url, location)
    raise RuntimeError("too many redirects")


@app.get("/health")
def health():
    return jsonify(ok=True, impersonate=IMPERSONATE)


@app.post("/fetch")
def browser_fetch():
    payload = request.get_json(silent=True) or {}
    raw_url = str(payload.get("url") or "")
    parsed = allowed_url(raw_url)
    if not parsed:
        return jsonify(error="URL host is not allowed"), 403

    host = normalized_host(parsed.hostname or "")
    remaining = cooldown_remaining(host)
    if remaining:
        response = jsonify(error=f"{host} is cooling down")
        response.status_code = 429
        response.headers["Retry-After"] = str(remaining)
        return response

    headers = {
        "Accept": str(payload.get("accept") or "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8")[:500],
        "Accept-Language": str(payload.get("acceptLanguage") or "en-US,en;q=0.9")[:300],
    }

    last_error = None
    for attempt in range(ATTEMPTS):
        try:
            upstream = chrome_get(raw_url, headers)
        except Exception as error:
            last_error = str(error)
            if attempt + 1 < ATTEMPTS:
                time.sleep(min(MAX_RETRY_SLEEP, RETRY_BACKOFF * (attempt + 1)))
            continue

        status = upstream.status_code
        if status == 429:
            retry_after = retry_after_seconds(upstream.headers.get("retry-after"))
            if attempt + 1 < ATTEMPTS:
                time.sleep(min(MAX_RETRY_SLEEP, retry_after or RETRY_BACKOFF * (attempt + 1)))
                continue
            set_cooldown(host, max(RATE_LIMIT_COOLDOWN, retry_after or 0))
        elif status == 403:
            set_cooldown(host, BLOCK_COOLDOWN)
        elif status >= 500 and attempt + 1 < ATTEMPTS:
            time.sleep(min(MAX_RETRY_SLEEP, RETRY_BACKOFF * (attempt + 1)))
            continue

        return proxy_response(upstream)

    return jsonify(error=last_error or f"failed to fetch {host}"), 502


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "4040")))
