import json
import os
import tempfile
import unittest

from facebook_guard import FacebookGuard, FacebookPaused, FacebookTooSoon, from_environment


class Clock:
    def __init__(self):
        self.now = 1_000_000.0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


def guard(clock, **kwargs):
    kwargs.setdefault("rand", lambda: 0.5)  # no jitter
    return FacebookGuard(clock=clock, sleep=clock.sleep, **kwargs)


class Spacing(unittest.TestCase):
    def test_page_loads_are_spaced_by_the_minimum_interval(self):
        clock = Clock()
        g = guard(clock, min_interval=90)
        with g.session():
            clock.now += 20  # the load itself
        before = clock.now
        with g.session():
            pass
        self.assertAlmostEqual(clock.now - before, 90)

    def test_a_wait_longer_than_the_caller_can_afford_fails_fast_instead_of_sleeping(self):
        clock = Clock()
        g = guard(clock, min_interval=300)
        with g.session():
            pass
        before = clock.now
        with self.assertRaises(FacebookTooSoon) as caught:
            with g.session(max_wait=100):
                pass
        self.assertEqual(clock.now, before)
        self.assertGreater(caught.exception.retry_after, 100)

    def test_the_first_load_does_not_wait(self):
        clock = Clock()
        before = clock.now
        with guard(clock, min_interval=90).session():
            pass
        self.assertEqual(clock.now, before)


class Budget(unittest.TestCase):
    def test_the_daily_limit_stops_further_loads_until_the_oldest_ages_out(self):
        clock = Clock()
        g = guard(clock, min_interval=0, daily_limit=3)
        for _ in range(3):
            with g.session():
                pass
        with self.assertRaises(FacebookPaused):
            with g.session():
                pass
        clock.now += 86401
        with g.session():
            pass

    def test_a_failed_load_still_counts(self):
        clock = Clock()
        g = guard(clock, min_interval=0, daily_limit=1)
        with self.assertRaises(ValueError):
            with g.session():
                raise ValueError("boom")
        with self.assertRaises(FacebookPaused):
            with g.session():
                pass


class Pause(unittest.TestCase):
    def test_a_paused_guard_does_not_contact_facebook_until_the_pause_ends(self):
        clock = Clock()
        g = guard(clock, min_interval=0)
        g.pause("session rejected", seconds=3600)
        with self.assertRaises(FacebookPaused):
            with g.session():
                self.fail("must not run")
        self.assertTrue(g.status()["paused"])
        clock.now += 3601
        with g.session():
            pass
        self.assertFalse(g.status()["paused"])

    def test_the_pause_survives_a_restart(self):
        clock = Clock()
        with tempfile.TemporaryDirectory() as directory:
            state = os.path.join(directory, "state.json")
            guard(clock, min_interval=0, state_file=state).pause("session rejected", seconds=3600)
            reborn = guard(clock, min_interval=0, state_file=state)
            with self.assertRaises(FacebookPaused):
                with reborn.session():
                    pass
            with open(state) as handle:
                self.assertEqual(json.load(handle)["reason"], "session rejected")

    def test_the_environment_can_pause_facebook_until_a_date(self):
        g = from_environment({"FACEBOOK_PAUSED_UNTIL": "2999-01-01T00:00:00Z", "FACEBOOK_MIN_INTERVAL_SECONDS": "0"})
        with self.assertRaises(FacebookPaused):
            with g.session():
                pass


if __name__ == "__main__":
    unittest.main()
