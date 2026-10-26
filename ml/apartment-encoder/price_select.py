"""Choose the listing's own price among the amounts a text mentions.

The span tagger marks every amount that has a currency next to it: the rent, but
also a deposit, a commission, a parking fee, the other flats of a multi-flat post.
Which one is "the price" is a separate decision, made here with plain rules that
need no model:

* an amount near a price word ("цена", "аренда", "price", "narx") scores up;
* an amount near a side-payment word ("залог", "депозит", "комиссия", "коммунальные",
  "parcare") scores down;
* an amount with a currency right beside it scores up;
* ties go to the earliest one -- the headline price comes first.

When no amount stands out this still returns the earliest one; callers that need
certainty can look at `score` in `rank_prices`.
"""
import re

PRICE_CUE = re.compile(
    r"(?:цена|ціна|стоимост|вартість|аренд|оренд|ставка|price|pret|chirie|narx|нарх|ижара|"
    r"в месяц|за месяц|на месяц|/мес|/міс|per month|lunar)",
    re.IGNORECASE,
)
EXTRA_CUE = re.compile(
    r"(?:залог|депозит|deposit|заклад|гарант|комисси|комісі|коммунал|комунал|парков|паркінг|паркинг|"
    r"parcare|предоплат|аванс|страховк|garantie|taxa|avans)",
    re.IGNORECASE,
)
CLAUSE_BREAK = re.compile(r"[.,;!?+|\n]")
SUFFIX = re.compile(r"(к|k|тыс\.?|тис\.?)$", re.IGNORECASE)
GROUPED = re.compile(r"[1-9]\d{0,2}(?:[   .,]\d{3})+(?:[.,]\d{1,2})?")


def parse_amount(piece):
    """'15 000' -> 15000, '16 тис' -> 16000, '1,200' -> 1200, '350' -> 350; None if not a number."""
    s = piece.strip()
    multiplier = 1
    suffix = SUFFIX.search(s)
    if suffix:
        multiplier = 1000
        s = s[: suffix.start()].strip()
    if GROUPED.fullmatch(s):
        decimal = re.search(r"[.,]\d{1,2}$", s)
        head = s[: decimal.start()] if decimal else s
        value = float(re.sub(r"[   .,]", "", head))
        if decimal:
            value += float("0." + decimal.group()[1:])
    else:
        try:
            value = float(s.replace(",", "."))
        except ValueError:
            return None
    value *= multiplier
    return int(value) if value == int(value) else value


def clause_before(text, a, width=40):
    """Text before `a`, back to the previous clause break, so a neighbouring amount's cue stays out."""
    return CLAUSE_BREAK.split(text[max(0, a - width):a])[-1]


def clause_after(text, b, width=25):
    return CLAUSE_BREAK.split(text[b:b + width])[0]


def rank_prices(text, prices, currencies):
    """Score each (start, end) price span; returns a list of dicts in text order.

    `currencies` are the (start, end) currency spans of the same text.
    """
    ranked = []
    for i, (a, b) in enumerate(prices):
        before, after = clause_before(text, a), clause_after(text, b)
        score = 0
        if PRICE_CUE.search(before) or PRICE_CUE.search(after):
            score += 2
        if EXTRA_CUE.search(before) or EXTRA_CUE.search(after):
            score -= 3
        if any(0 <= c0 - b <= 3 or 0 <= a - c1 <= 3 for c0, c1 in currencies):
            score += 1
        ranked.append({"index": i, "start": a, "end": b, "score": score, "amount": parse_amount(text[a:b])})
    return ranked


def select_price(text, prices, currencies):
    """Index into `prices` of the listing's own price, or None when there are none."""
    ranked = rank_prices(text, prices, currencies)
    if not ranked:
        return None
    return max(ranked, key=lambda r: (r["score"], -r["index"]))["index"]


def nearest_currency(price, currencies):
    """The currency span touching `price`, preferring the one right after it."""
    a, b = price
    after = [c for c in currencies if 0 <= c[0] - b <= 3]
    before = [c for c in currencies if 0 <= a - c[1] <= 3]
    return (after or before or [None])[0]
