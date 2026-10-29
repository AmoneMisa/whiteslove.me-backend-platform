import unittest

import review_to_training as R

TEXT = "💰 Цена 500 $, ул. Абая 5, мкр Глинка, рядом ТЦ Мега"


def cps(piece):
    """(start, end) of `piece` in code points, the unit the page and the models use."""
    chars = list(TEXT)
    start = TEXT.index(piece)
    start = len(list(TEXT[:start]))
    return start, start + len(list(piece))


def item(spans):
    return {"id": "t:1", "group": "A", "text": TEXT,
            "pred": {"spans": {e: [{"start": s, "end": t, "text": TEXT} for s, t in spans.get(e, [])]
                               for e in ("PRICE", "CURRENCY", "ADDRESS", "METRO")}, "price": None, "truncated": False}}


def added(label, piece):
    s, e = cps(piece)
    return {"label": label, "start": s, "end": e, "text": piece}


class GoldRow(unittest.TestCase):
    def test_ok_spans_and_added_spans_become_gold_and_bad_ones_do_not(self):
        it = item({"PRICE": [cps("500")], "ADDRESS": [cps("Цена 500")]})  # the second is a wrong span
        res = {"seen": True, "sv": 7, "spans": {"PRICE:0": "ok", "ADDRESS:0": "bad"},
               "added": [added("ADDRESS", "ул. Абая 5"), added("LOCALITY", "Глинка"), added("LANDMARK", "ТЦ Мега"),
                         added("COMPLEX", "Мега")]}
        row, problems = R.gold_row(it, res)
        got = {(s["label"], TEXT_SLICE(s)) for s in row["spans"]}
        self.assertEqual(got, {("PRICE", "500"), ("ADDRESS", "ул. Абая 5"), ("LOCALITY", "Глинка"), ("LANDMARK", "ТЦ Мега"),
                               ("COMPLEX", "Мега")})
        self.assertEqual((problems, row["ignore"]), ([], []))

    def test_offsets_are_code_points_after_an_emoji(self):
        # "💰" is two UTF-16 units but one code point: the stored start must not drift by one
        s, e = cps("500")
        utf16_start = len(TEXT[:TEXT.index("500")].encode("utf-16-le")) // 2  # what a JS string index would say
        self.assertEqual((s, utf16_start), (7, 8), "the UTF-16 offset is one too large after the emoji")
        self.assertEqual(TEXT_SLICE({"start": s, "end": e}), "500")

    def test_a_card_ticked_before_districts_existed_ignores_them(self):
        row, _ = R.gold_row(item({}), {"seen": True, "spans": {}, "added": []})
        self.assertEqual(row["ignore"], ["DISTRICT", "MICRODISTRICT", "LOCALITY", "LANDMARK", "COMPLEX", "DEPOSIT", "UTILITIES",
                                       "AREA", "FLOOR", "FLOORS_TOTAL", "ROOMS", "COMMISSION", "PREPAYMENT"])
        row, _ = R.gold_row(item({}), {"seen": True, "sv": 3, "spans": {}, "added": []})
        self.assertEqual(row["ignore"], ["DISTRICT", "MICRODISTRICT", "LOCALITY", "DEPOSIT", "UTILITIES",
                                       "AREA", "FLOOR", "FLOORS_TOTAL", "ROOMS", "COMMISSION", "PREPAYMENT"],
                         "version 3 had landmarks and ЖК, but one district label for every kind of place")

    def test_before_the_nearby_button_a_generic_landmark_is_read_as_nearby(self):
        it = item({})
        old = {"seen": True, "sv": 5, "spans": {}, "added": [added("LANDMARK", "ТЦ Мега"), added("LANDMARK", "рядом")]}
        row, _ = R.gold_row(it, old)
        self.assertEqual({(s["label"], TEXT_SLICE(s)) for s in row["spans"]}, {("LANDMARK", "ТЦ Мега"), ("NEARBY", "рядом")})
        new = {"seen": True, "sv": 6, "spans": {}, "added": [added("LANDMARK", "рядом")]}
        row, _ = R.gold_row(it, new)
        self.assertEqual({(s["label"], TEXT_SLICE(s)) for s in row["spans"]}, {("LANDMARK", "рядом")}, "from version 6 the label is what you chose")

    def test_a_selection_that_does_not_match_the_text_is_reported_and_dropped(self):
        bad = added("DISTRICT", "Глинка")
        bad["start"] += 1
        row, problems = R.gold_row(item({}), {"seen": True, "sv": 3, "spans": {}, "added": [bad]})
        self.assertEqual(row["spans"], [])
        self.assertTrue(problems and "does not match" in problems[0])

    def test_unknown_label_and_out_of_range_are_rejected(self):
        row, problems = R.gold_row(item({}), {"seen": True, "sv": 2, "spans": {}, "added": [
            {"label": "CITY", "start": 0, "end": 2, "text": "💰 "}, {"label": "METRO", "start": 5, "end": 999, "text": "x"}]})
        self.assertEqual((row["spans"], len(problems)), ([], 2))


class Build(unittest.TestCase):
    def test_only_checked_cards_that_are_not_skipped(self):
        items = [dict(item({}), id=f"t:{i}") for i in range(4)]
        results = {"t:0": {"seen": True, "sv": 2}, "t:1": {"seen": False}, "t:2": {"skip": True, "seen": True},
                   "t:3": {"seen": True, "sv": 2, "added": [added("METRO", "Глинка")]}}
        rows, _ = R.build(items, results)
        self.assertEqual([r["id"] for r in rows], ["t:0", "t:3"])
        self.assertIn("2 reviewed cards", R.summary(rows))


def TEXT_SLICE(span):
    return "".join(list(TEXT)[span["start"]:span["end"]])


if __name__ == "__main__":
    unittest.main()
