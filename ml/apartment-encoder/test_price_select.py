import unittest

from price_select import nearest_currency, parse_amount, rank_prices, select_price


def spans(text, *pieces):
    """(start, end) of each piece, searched left to right so repeats map to successive hits."""
    out, pos = [], 0
    for piece in pieces:
        i = text.index(piece, pos)
        out.append((i, i + len(piece)))
        pos = i + len(piece)
    return out


class ParseAmount(unittest.TestCase):
    def test_formats(self):
        self.assertEqual(parse_amount("15 000"), 15000)
        self.assertEqual(parse_amount("16 тис"), 16000)
        self.assertEqual(parse_amount("15к"), 15000)
        self.assertEqual(parse_amount("1,200"), 1200)
        self.assertEqual(parse_amount("350"), 350)
        self.assertEqual(parse_amount("12.5"), 12.5)
        self.assertEqual(parse_amount("0.350"), 0.35, "a leading zero is a decimal, not a thousands group")
        self.assertIsNone(parse_amount("abc"))


class SelectPrice(unittest.TestCase):
    def test_rent_beats_deposit_and_commission(self):
        t = "Цена 500 € в месяц, залог 400 €, комиссия 250 €"
        prices = spans(t, "500", "400", "250")
        currencies = spans(t, "€", "€", "€")
        self.assertEqual(select_price(t, prices, currencies), 0)

    def test_rent_is_not_first_in_the_text(self):
        t = "Депозит 300. Цена: 530 в месяц"
        prices = spans(t, "300", "530")
        self.assertEqual(select_price(t, prices, []), 1)

    def test_tie_goes_to_the_earliest(self):
        t = "600 у.е. ключи. 400 у.е. + паркинг"
        prices = spans(t, "600", "400")
        currencies = spans(t, "у.е.", "у.е.")
        self.assertEqual(select_price(t, prices, currencies), 0)

    def test_parking_fee_is_demoted_but_still_chosen_if_alone(self):
        t = "Parcare Subterană - 100 €"
        prices = spans(t, "100")
        self.assertEqual(select_price(t, prices, spans(t, "€")), 0)

    def test_nothing_to_choose(self):
        self.assertIsNone(select_price("no money here", [], []))

    def test_scores_are_exposed(self):
        t = "Цена 500 $, залог 300 $"
        ranked = rank_prices(t, spans(t, "500", "300"), spans(t, "$", "$"))
        self.assertGreater(ranked[0]["score"], ranked[1]["score"])
        self.assertEqual([r["amount"] for r in ranked], [500, 300])


class NearestCurrency(unittest.TestCase):
    def test_after_preferred(self):
        t = "$500 или 500 грн"
        price, currencies = spans(t, "500")[0], spans(t, "$", "грн")
        self.assertEqual(nearest_currency(price, currencies), currencies[0])
        second = spans(t, "500", "500")[1]
        self.assertEqual(nearest_currency(second, currencies), currencies[1])


if __name__ == "__main__":
    unittest.main()
