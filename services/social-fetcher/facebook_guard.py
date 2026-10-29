"""Keeps the Facebook session safe: one page load at a time, spaced out, within a daily budget, and stopped for a
while as soon as Facebook rejects the session.

Facebook restricts an account that opens many sessions or pages in a short time ("you cannot create several sessions").
This is an upstream requirement of the account, not a crawl-depth limit: it spaces and bounds the *requests* to the
site, it does not decide how far a crawl goes. A request that cannot be served in time fails fast with an error the
caller treats as a retry condition, never as a completed crawl.

All limits are environment settings of the service (see README); the guard itself is plain Python and takes its clock,
sleep and random source as arguments so it can be tested.
"""
import json
import os
import random
import threading
import time
from contextlib import contextmanager


class FacebookPaused(RuntimeError):
    """Facebook is not being contacted: the session was rejected, or the daily budget is used up."""


class FacebookTooSoon(RuntimeError):
    """The next page load is not allowed yet; retry after `retry_after` seconds."""

    def __init__(self, message, retry_after):
        super().__init__(message)
        self.retry_after = retry_after


class FacebookGuard:
    def __init__(self, *, min_interval=90.0, jitter=0.25, daily_limit=120, pause_seconds=24 * 3600,
                 state_file=None, clock=time.time, sleep=time.sleep, rand=random.random):
        self.min_interval = max(0.0, float(min_interval))
        self.jitter = max(0.0, min(0.9, float(jitter)))
        self.daily_limit = max(0, int(daily_limit))  # 0 = no daily limit
        self.pause_seconds = max(0.0, float(pause_seconds))
        self.state_file = state_file
        self.clock, self.sleep, self.rand = clock, sleep, rand
        self._lock = threading.Lock()
        self._last_end = 0.0
        self._loads = []  # start times of the page loads in the last 24 hours
        self._paused_until = 0.0
        self._paused_reason = ""
        self._load_state()

    # ---- persisted state: a pause must survive a restart of the container ----
    def _load_state(self):
        if not self.state_file:
            return
        try:
            with open(self.state_file, encoding="utf-8") as handle:
                state = json.load(handle)
            self._paused_until = float(state.get("pausedUntil") or 0)
            self._paused_reason = str(state.get("reason") or "")
            self._loads = [float(t) for t in state.get("loads") or []]
        except (OSError, ValueError):
            pass

    def _save_state(self):
        if not self.state_file:
            return
        try:
            os.makedirs(os.path.dirname(self.state_file) or ".", exist_ok=True)
            tmp = f"{self.state_file}.tmp"
            with open(tmp, "w", encoding="utf-8") as handle:
                json.dump({"pausedUntil": self._paused_until, "reason": self._paused_reason, "loads": self._loads}, handle)
            os.replace(tmp, self.state_file)
        except OSError:
            pass

    # ---- control ----
    def pause(self, reason, seconds=None):
        """Stop contacting Facebook for `seconds` (default: the configured pause)."""
        self._paused_until = self.clock() + (self.pause_seconds if seconds is None else float(seconds))
        self._paused_reason = str(reason)[:200]
        self._save_state()

    def pause_until(self, timestamp, reason):
        self._paused_until = max(self._paused_until, float(timestamp))
        self._paused_reason = str(reason)[:200]
        self._save_state()

    def status(self):
        now = self.clock()
        recent = [t for t in self._loads if now - t < 86400]
        return {
            "paused": self._paused_until > now,
            "pausedUntil": self._paused_until if self._paused_until > now else None,
            "reason": self._paused_reason if self._paused_until > now else "",
            "loadsLast24h": len(recent),
            "dailyLimit": self.daily_limit,
            "minIntervalSeconds": self.min_interval,
        }

    @contextmanager
    def session(self, max_wait=100.0):
        """Hold the one Facebook slot. Waits (up to `max_wait` seconds) for the spacing; raises instead of waiting longer."""
        started = self.clock()
        if not self._lock.acquire(timeout=max(0.0, max_wait)):
            raise FacebookTooSoon("Facebook is busy with another page load", retry_after=self.min_interval)
        try:
            now = self.clock()
            if self._paused_until > now:
                raise FacebookPaused(
                    f"Facebook paused until {int(self._paused_until)} ({self._paused_reason or 'session rejected'})"
                )
            self._loads = [t for t in self._loads if now - t < 86400]
            if self.daily_limit and len(self._loads) >= self.daily_limit:
                retry = max(1.0, 86400 - (now - self._loads[0]))
                raise FacebookPaused(f"Facebook daily limit of {self.daily_limit} page loads used; retry in {int(retry)}s")
            gap = self.min_interval * (1 + self.jitter * (2 * self.rand() - 1))
            wait = max(0.0, self._last_end + gap - now)
            if wait > max_wait - (now - started):
                raise FacebookTooSoon(f"Facebook page loads are spaced out; next one in {int(wait)}s", retry_after=wait)
            if wait:
                self.sleep(wait)
            self._loads.append(self.clock())
            self._save_state()
            try:
                yield self
            finally:
                self._last_end = self.clock()
        finally:
            self._lock.release()


def from_environment(environ=os.environ):
    guard = FacebookGuard(
        min_interval=float(environ.get("FACEBOOK_MIN_INTERVAL_SECONDS", "90")),
        daily_limit=int(environ.get("FACEBOOK_DAILY_LIMIT", "120")),
        pause_seconds=float(environ.get("FACEBOOK_PAUSE_HOURS", "24")) * 3600,
        state_file=environ.get("FACEBOOK_STATE_FILE") or None,
    )
    until = (environ.get("FACEBOOK_PAUSED_UNTIL") or "").strip()  # e.g. 2026-10-31T00:00:00Z: the account is restricted
    if until:
        from datetime import datetime, timezone

        try:
            stamp = datetime.fromisoformat(until.replace("Z", "+00:00"))
            if stamp.tzinfo is None:
                stamp = stamp.replace(tzinfo=timezone.utc)
            guard.pause_until(stamp.timestamp(), "FACEBOOK_PAUSED_UNTIL")
        except ValueError:
            pass
    return guard
