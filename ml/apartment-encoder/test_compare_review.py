import unittest

import compare_review as C


def item(n, group, spans=None, price=None, db=None):
    spans = spans or {}
    return {
        "id": f"t:{n}", "n": n, "group": group, "text": "x",
        "db": {"price": None, "currency": None, "address": None, "street": None, "metro": None, **(db or {})},
        "pred": {"spans": {e: spans.get(e, []) for e in C.ENTITIES}, "price": price, "truncated": False},
    }


def seen(res):
    """Mark a hand-made result as ticked 'checked in full', as the page requires."""
    return {**res, "seen": True}


def span(text="a"):
    return {"start": 0, "end": 1, "text": text}


PRICE = {"span": span("500"), "currency": None, "candidates": [], "amount": 500, "ambiguous": False}


class Wilson(unittest.TestCase):
    def test_bounds(self):
        lo, hi = C.wilson(0, 10)
        self.assertEqual(lo, 0.0)
        self.assertGreater(hi, 0.2)
        lo, hi = C.wilson(50, 100)
        self.assertAlmostEqual(lo, 0.404, places=2)
        self.assertAlmostEqual(hi, 0.596, places=2)
        self.assertEqual(C.wilson(0, 0), (0.0, 0.0))


class Scoring(unittest.TestCase):
    def test_incomplete_items_are_skipped(self):
        it = item(1, "A", spans={"ADDRESS": [span()]})
        self.assertFalse(C.is_complete(it, None))
        self.assertFalse(C.is_complete(it, {"spans": {}, "db": {}}))
        self.assertFalse(C.is_complete(it, {"spans": {"ADDRESS:0": "ok"}, "db": {}}), "not ticked as checked")
        self.assertTrue(C.is_complete(it, seen({"spans": {"ADDRESS:0": "ok"}, "db": {}})))

    def test_a_stored_value_needs_a_verdict_too(self):
        it = item(1, "A", db={"metro": "Kyivska"})
        self.assertFalse(C.is_complete(it, {"spans": {}, "db": {}}))
        self.assertTrue(C.is_complete(it, seen({"spans": {}, "db": {"metro": "ok"}})))

    def test_an_empty_card_needs_an_explicit_tick(self):
        it = item(1, "A")
        self.assertFalse(C.is_complete(it, {"spans": {}, "db": {}}))
        self.assertTrue(C.is_complete(it, seen({"spans": {}, "db": {}})))

    def test_before_after_on_the_random_group(self):
        # 1: DB right, model silent.  2: DB empty, model right.  3: DB empty, model wrong.
        # 4: DB wrong, model right.   5: address in text, nobody found it (marked missed).
        items = [
            item(1, "A", db={"address": "Абая 5"}),
            item(2, "A", spans={"ADDRESS": [span("Лесі 3")]}),
            item(3, "A", spans={"ADDRESS": [span("Площа 49")]}),
            item(4, "A", spans={"ADDRESS": [span("Дегтярева 10")]}, db={"address": "Дегтярева"}),
            item(5, "A"),
        ]
        results = {k: seen(v) for k, v in {
            "t:1": {"spans": {}, "db": {"address": "ok"}},
            "t:2": {"spans": {"ADDRESS:0": "ok"}, "db": {}},
            "t:3": {"spans": {"ADDRESS:0": "bad"}, "db": {}},
            "t:4": {"spans": {"ADDRESS:0": "ok"}, "db": {"address": "bad"}},
            "t:5": {"spans": {}, "db": {}, "missed": {"ADDRESS": True}},
        }.items()}
        a = C.score(items, results)["entities"]["ADDRESS"]
        self.assertEqual(a["present_A"], 4)           # exists: 1 (DB), 2, 4, 5; item 3 has no real address
        self.assertEqual(a["in_text_A"], 3)           # in the text: 2, 4 (a right span) and 5 (missed); 1 is right in the DB only
        self.assertEqual(a["before_recall_A"], (1, 4))  # only item 1 is right in the DB (item 3 has no real address)
        self.assertEqual(a["tagger_recall_A"], (2, 3))  # of the 3 addresses in the text, the model got 2 and 4
        self.assertEqual(a["after_recall_A"], (2, 4))   # item 1 via DB, item 2 via the model; item 4's DB value is wrong
        self.assertEqual(a["before_wrong_A"], (1, 5))
        self.assertEqual(a["after_wrong_A"], (2, 5))    # item 3 (bad fill) and item 4 (DB stays wrong)
        self.assertEqual(a["fill_precision_A"], (1, 2))  # items 2 and 3 were fills; one was right

    def test_a_repeated_mention_counts_once(self):
        # the same address four times (a title repeated in the body), judged once on the page
        it = item(1, "A", spans={"ADDRESS": [span("Абая 5")] * 4 + [span("Лесі 3")]})
        res = seen({"spans": {"ADDRESS:0": "ok", "ADDRESS:1": "ok", "ADDRESS:2": "ok", "ADDRESS:3": "ok", "ADDRESS:4": "bad"},
                    "db": {}})
        self.assertEqual(C.verdicts(it, res, "ADDRESS"), ["ok", "bad"])
        self.assertEqual(C.score([it], {it["id"]: res})["entities"]["ADDRESS"]["precision_A"], (1, 2))

    def test_a_price_that_is_only_in_the_database_is_not_a_model_miss(self):
        # the price came from a structured field and is not in the text: nobody reading the text can find it
        it = item(1, "A", db={"price": 500, "currency": "USD"})
        res = seen({"spans": {}, "db": {"price": "ok"}})
        p = C.score([it], {it["id"]: res})["entities"]["PRICE"]
        self.assertEqual(p["tagger_recall_A"], (0, 0), "not counted against the model")
        self.assertEqual(p["before_recall_A"], (1, 1), "but the listing does have a price, and the DB has it")

    def test_skipped_cards_leave_every_score_and_are_counted_on_their_own(self):
        a = item(1, "A", spans={"ADDRESS": [span("Абая 5")]})
        junk = item(2, "A", spans={"ADDRESS": [span("Qilingan")]})              # a bad span, but the card is junk
        results = {
            "t:1": seen({"spans": {"ADDRESS:0": "ok"}, "db": {}}),
            "t:2": {"skip": True, "spans": {"ADDRESS:0": "bad"}, "db": {}},        # skipped: no "checked in full" tick needed
        }
        rep = C.score([a, junk], results)
        self.assertEqual((rep["reviewed"], rep["skipped_total"], rep["skipped"]["A"]), (1, 1, 1))
        self.assertEqual(rep["entities"]["ADDRESS"]["precision_A"], (1, 1), "the junk card's bad span is not scored")
        self.assertIn("Пропущено как сборное / мусор: 1", C.text_report(rep))

    def test_district_and_landmark_are_counted_not_scored(self):
        its = [item(i, "A") for i in (1, 2, 3, 4)]
        results = {
            "t:1": seen({"spans": {}, "db": {}, "missed": {"DISTRICT": True, "LANDMARK": True}}),
            "t:2": seen({"spans": {}, "db": {}, "missed": {"DISTRICT": True}}),
            "t:3": seen({"spans": {}, "db": {}}),
            "t:4": seen({"spans": {}, "db": {}, "missed": {"LANDMARK": True}}),
        }
        rep = C.score(its, results)
        self.assertEqual(rep["district_in_text_A"], (2, 4))
        self.assertEqual(rep["landmark_in_text_A"], (2, 4))
        self.assertEqual(rep["entities"]["ADDRESS"]["in_text_A"], 0, "a district is not an address miss")

    def test_price_choice(self):
        items = [item(1, "D", spans={"PRICE": [span("500"), span("300")]}, price=PRICE),
                 item(2, "D", spans={"PRICE": [span("400")]}, price=PRICE)]
        results = {k: seen(v) for k, v in {
            "t:1": {"spans": {"PRICE:0": "ok", "PRICE:1": "ok"}, "db": {}, "choice": "ok"},
            "t:2": {"spans": {"PRICE:0": "ok"}, "db": {}, "choice": "bad"},
        }.items()}
        rep = C.score(items, results)
        self.assertEqual(rep["price_choice"]["D"], (1, 2))
        self.assertEqual(rep["entities"]["PRICE"]["precision_D"], (3, 3))

    def test_report_renders_with_nothing_reviewed(self):
        rep = C.score([item(1, "A")], {})
        self.assertIn("Нет полностью размеченных", C.text_report(rep))


if __name__ == "__main__":
    unittest.main()
