import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import review_server as S


def card(seen=False, t=0, **extra):
    """An answered card (it carries a note, so it counts as touched)."""
    return {"spans": {}, "db": {}, "missed": {}, "choice": None, "note": "m", "seen": seen, "t": t, **extra}


def blank(t=0):
    return {"spans": {}, "db": {}, "missed": {}, "choice": None, "note": "", "seen": False, "t": t}


class Merge(unittest.TestCase):
    def test_later_edit_wins(self):
        merged, taken = S.merge_results({"a": card(t=5, note="old")}, {"a": card(t=9, note="new"), "b": card(t=1)})
        self.assertEqual((merged["a"]["note"], taken, sorted(merged)), ("new", 2, ["a", "b"]))

    def test_an_older_answer_does_not_overwrite(self):
        merged, taken = S.merge_results({"a": card(t=9, note="new")}, {"a": card(t=5, note="old")})
        self.assertEqual((merged["a"]["note"], taken), ("new", 0))

    def test_equal_age_keeps_the_card_further_along(self):
        # a file downloaded from the page carries no timestamps: the finished card must survive
        merged, _ = S.merge_results({"a": card(seen=False)}, {"a": card(seen=True)})
        self.assertTrue(merged["a"]["seen"])
        merged, _ = S.merge_results({"a": card(seen=True)}, {"a": card(seen=False)})
        self.assertTrue(merged["a"]["seen"])

    def test_a_blank_card_never_overwrites_an_answer(self):
        # a phone that merely opened the card, with a fresher clock, must not wipe the PC's answer
        merged, taken = S.merge_results({"a": card(seen=True, t=5)}, {"a": blank(t=99), "b": blank(t=99)})
        self.assertEqual((merged["a"]["seen"], taken, sorted(merged)), (True, 0, ["a"]))

    def test_junk_entries_are_ignored(self):
        merged, taken = S.merge_results({}, {"a": "not a dict", "b": card()})
        self.assertEqual((sorted(merged), taken), (["b"], 1))


class Live(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        folder = Path(cls.dir.name)
        (folder / "review.html").write_text("<html>PAGE</html>", encoding="utf-8")
        cls.path = folder / "review_results.json"
        cls.store = S.Store(cls.path, "set1")
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), S.make_handler(cls.store, "secret", folder / "review.html"))
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.dir.cleanup()

    def call(self, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data,
                                     headers={"content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def test_key_is_required(self):
        self.assertEqual(self.call("/results")[0], 403)
        self.assertEqual(self.call("/results?key=wrong")[0], 403)
        self.assertEqual(self.call("/results", {"setId": "set1", "results": {}})[0], 403)
        self.assertEqual(self.call("/?key=secret")[1], b"<html>PAGE</html>")

    def test_round_trip_and_file(self):
        status, body = self.call("/results?key=secret", {"setId": "set1", "results": {"x:1": card(seen=True, t=7)}})
        self.assertEqual((status, json.loads(body)["taken"]), (200, 1))
        got = json.loads(self.call("/results?key=secret")[1])
        self.assertTrue(got["results"]["x:1"]["seen"])
        on_disk = json.loads(self.path.read_text(encoding="utf-8"))  # the file compare_review.py reads
        self.assertEqual((on_disk["setId"], list(on_disk["results"])), ("set1", ["x:1"]))

    def test_other_set_and_bad_body_are_refused(self):
        self.assertEqual(self.call("/results?key=secret", {"setId": "other", "results": {}})[0], 409)
        self.assertEqual(self.call("/results?key=secret", {"setId": "set1", "results": [1]})[0], 400)


class StoreFile(unittest.TestCase):
    def test_refuses_a_results_file_of_another_set(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "review_results.json"
            p.write_text(json.dumps({"setId": "old", "results": {}}), encoding="utf-8")
            with self.assertRaises(SystemExit):
                S.Store(p, "new")

    def test_existing_answers_are_loaded_and_backed_up(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "review_results.json"
            p.write_text(json.dumps({"setId": "s", "results": {"a": card(seen=True)}}), encoding="utf-8")
            store = S.Store(p, "s")
            self.assertTrue(store.results["a"]["seen"])
            self.assertTrue(p.with_suffix(".json.bak").exists())


if __name__ == "__main__":
    unittest.main()
