"""Score hand-review answers: how right is the model, and how right is what the database holds.

    python compare_review.py review/items.json review/review_results.json [--json]

`items.json` comes from build_review_set.py; the results file is what the review page
downloads. Only items you finished (every highlighted span and every stored value has
a verdict, and the card is ticked as fully checked) are counted, so a partial review still gives numbers -- with the wider
uncertainty that a small sample deserves. Every share is printed as

    63%  [48-76]  (19/30)        value, 95% Wilson interval, hits / total

Reading the report
------------------
Group A is a random sample, so only there can recall (what the text contains and who
found it) and the before/after comparison be trusted. Groups B and C were picked
because the model found something where the database is empty; they answer one
question -- "is a fill-in right?" -- and say nothing about overall recall.

  before = what the database holds today
  after  = the database value, and where it is empty, the model's first answer
"""
import argparse
import json
import math
import sys

ENTITIES = ("PRICE", "CURRENCY", "ADDRESS", "METRO")
NAMES = {"PRICE": "цена", "CURRENCY": "валюта", "ADDRESS": "адрес", "METRO": "метро"}
DB_FIELD = {"PRICE": "price", "ADDRESS": "address", "METRO": "metro"}


def wilson(k, n, z=1.96):
    """95% Wilson score interval for k hits in n trials (fractions)."""
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, centre - half), min(1.0, centre + half))


def fmt(k, n):
    if n == 0:
        return "   —   (нет данных)"
    lo, hi = wilson(k, n)
    return f"{100 * k / n:3.0f}%  [{100 * lo:.0f}-{100 * hi:.0f}]  ({k}/{n})"


def db_value(item, field):
    d = item["db"]
    if field == "address":
        return d.get("address") or d.get("street")
    return d.get(field)


def is_complete(item, res):
    """The reviewer ticked "checked in full", and every highlighted span and stored value has a verdict."""
    if res is None or not res.get("seen"):
        return False  # an untouched card would otherwise count as "nothing was missed"
    for ent, spans in item["pred"]["spans"].items():
        for i in range(len(spans)):
            if f"{ent}:{i}" not in res.get("spans", {}):
                return False
    for ent, field in DB_FIELD.items():
        if db_value(item, field) not in (None, "") and field not in res.get("db", {}):
            return False
    if item["pred"]["price"] and not res.get("choice"):
        return False
    return True


def verdicts(item, res, ent):
    """One verdict per distinct text: a title repeated in the body is one mention, not five."""
    seen, out = set(), []
    for i, span in enumerate(item["pred"]["spans"][ent]):
        key = span["text"].strip().lower()
        if key not in seen:
            seen.add(key)
            out.append(res["spans"][f"{ent}:{i}"])
    return out


def in_text(item, res, ent):
    """The text itself contains this entity: a highlighted span was right, or the reviewer said it was missed.

    A correct *stored* value does not count: a price that came from the source's structured
    field may appear nowhere in the text, and then no model reading the text could find it.
    """
    added = any(a.get("label") == ent for a in res.get("added") or [])  # a span you selected yourself
    return "ok" in verdicts(item, res, ent) or bool(res.get("missed", {}).get(ent)) or added


def exists(item, res, ent):
    """The listing has this entity: it is in the text, or the database holds a correct value for it."""
    field = DB_FIELD.get(ent)
    return in_text(item, res, ent) or bool(field and res.get("db", {}).get(field) == "ok")


def tagger_correct(item, res, ent):
    """The model's headline answer for the entity is right (price: its chosen amount)."""
    if ent == "PRICE":
        return bool(item["pred"]["price"]) and res.get("choice") == "ok"
    v = verdicts(item, res, ent)
    return bool(v) and v[0] == "ok"


def tagger_answered(item, ent):
    return bool(item["pred"]["price"]) if ent == "PRICE" else bool(item["pred"]["spans"][ent])


def is_skipped(res):
    """Flagged as a compilation or junk ("сборное / мусор"): out of every score, counted on its own."""
    return bool(res and res.get("skip"))


def score(items, results):
    pairs = [(it, results.get(it["id"])) for it in items]
    skipped = [(it, r) for it, r in pairs if is_skipped(r)]
    done = [(it, r) for it, r in pairs if not is_skipped(r) and is_complete(it, r)]
    report = {"reviewed": len(done), "total": len(items), "groups": {}, "entities": {}}
    for g in sorted({it["group"] for it, _ in done}):
        report["groups"][g] = sum(1 for it, _ in done if it["group"] == g)
    # how much of what was looked at is not a single listing at all
    report["skipped"] = {g: sum(1 for it, _ in skipped if it["group"] == g) for g in "ABCD"}
    report["skipped_total"] = len(skipped)
    # what the site needs and the model does not look for yet: a district / microdistrict / locality
    # (Глинка, Гидропарк) and landmarks (a mall, a school, a stop), counted on the reviewed random cards
    random_done = [(it, r) for it, r in done if it["group"] == "A"]
    for key in ("DISTRICT", "MICRODISTRICT", "LOCALITY", "LANDMARK", "COMPLEX", "DEPOSIT", "UTILITIES", "NEARBY",
                "AREA", "FLOOR", "FLOORS_TOTAL", "ROOMS", "COMMISSION", "PREPAYMENT"):
        report[f"{key.lower()}_in_text_A"] = (
            sum(1 for it, r in random_done if (r.get("missed") or {}).get(key)), len(random_done))

    def rows(group):
        return [(it, r) for it, r in done if it["group"] == group]

    for ent in ENTITIES:
        out = {}
        # span-level precision, per group
        for g in "ABCD":
            ok = bad = 0
            for it, r in rows(g):
                for v in verdicts(it, r, ent):
                    ok += v == "ok"
                    bad += v == "bad"
            out[f"precision_{g}"] = (ok, ok + bad)
        # recall and before/after on the random group only
        a = rows("A")
        text_rows = [(it, r) for it, r in a if in_text(it, r, ent)]
        pres = [(it, r) for it, r in a if exists(it, r, ent)]
        out["in_text_A"] = len(text_rows)
        out["present_A"] = len(pres)  # the entity exists for the listing (in the text, or correct in the database)
        out["tagger_recall_A"] = (sum(1 for it, r in text_rows if tagger_correct(it, r, ent)), len(text_rows))
        field = DB_FIELD.get(ent)
        if field:
            vals = [(it, r) for it, r in a if db_value(it, field) not in (None, "")]
            ok = sum(1 for it, r in vals if r["db"].get(field) == "ok")
            out["db_accuracy_A"] = (ok, len(vals))
            before_ok = sum(1 for it, r in pres if r.get("db", {}).get(field) == "ok")
            out["before_recall_A"] = (before_ok, len(pres))
            # after: stored value if there is one, else the model's headline answer
            after_ok = after_wrong = after_given = 0
            for it, r in a:
                if db_value(it, field) not in (None, ""):
                    given, right = True, r["db"].get(field) == "ok"
                elif tagger_answered(it, ent):
                    given, right = True, tagger_correct(it, r, ent)
                else:
                    given = right = False
                after_given += given
                after_ok += right
                after_wrong += given and not right
            pres_after_ok = sum(
                1 for it, r in pres
                if (r["db"].get(field) == "ok") or (db_value(it, field) in (None, "") and tagger_correct(it, r, ent)))
            out["after_recall_A"] = (pres_after_ok, len(pres))
            out["before_wrong_A"] = (sum(1 for it, r in vals if r["db"].get(field) == "bad"), len(a))
            out["after_wrong_A"] = (after_wrong, len(a))
            # a fill-in is the model's answer where the database is empty
            for g in "ABCD":
                fills = [(it, r) for it, r in rows(g) if db_value(it, field) in (None, "") and tagger_answered(it, ent)]
                out[f"fill_precision_{g}"] = (sum(1 for it, r in fills if tagger_correct(it, r, ent)), len(fills))
        report["entities"][ent] = out

    choice = {}
    for g in "AD":
        ok = bad = 0
        for it, r in rows(g):
            if it["pred"]["price"]:
                ok += r["choice"] == "ok"
                bad += r["choice"] == "bad"
        choice[g] = (ok, ok + bad)
    report["price_choice"] = choice
    return report


def text_report(rep):
    lines = [f"Размечено полностью: {rep['reviewed']} из {rep['total']}  (по группам: {rep['groups']})"]
    if rep["skipped_total"]:
        sk = rep["skipped"]
        lines.append(f"Пропущено как сборное / мусор: {rep['skipped_total']}  (по группам: " +
                     ", ".join(f"{g} {n}" for g, n in sk.items() if n) + ")")
        a_seen = rep["groups"].get("A", 0) + sk.get("A", 0)
        if a_seen:
            lines.append(f"  доля сборных среди просмотренных случайных A : {fmt(sk.get('A', 0), a_seen)}")
    lines.append("")
    if not rep["reviewed"]:
        return "\n".join(lines + ["Нет полностью размеченных объявлений."])
    for ent in ENTITIES:
        o = rep["entities"][ent]
        lines.append(f"== {NAMES[ent]} ==")
        lines.append(f"  точность модели (по фрагментам), случайные A : {fmt(*o['precision_A'])}")
        lines.append(f"  полнота модели, случайные A (в тексте есть {o['in_text_A']}) : {fmt(*o['tagger_recall_A'])}")
        if ent in DB_FIELD:
            lines.append(f"  значения в БД верны, A                       : {fmt(*o['db_accuracy_A'])}")
            lines.append(f"  (в объявлении это есть у {o['present_A']}: в тексте или верно в БД)")
            lines.append(f"  ДО   (только БД)  : найдено {fmt(*o['before_recall_A'])}  | ошибочных ответов {fmt(*o['before_wrong_A'])}")
            lines.append(f"  ПОСЛЕ (БД + модель): найдено {fmt(*o['after_recall_A'])}  | ошибочных ответов {fmt(*o['after_wrong_A'])}")
            for g, label in (("A", "случайные"), ("B", "адрес, БД пусто"), ("C", "метро, БД пусто"), ("D", "несколько сумм")):
                k, n = o[f"fill_precision_{g}"]
                if n:
                    lines.append(f"  верно ли заполнение там, где БД пусто, {label:<16}: {fmt(k, n)}")
        lines.append("")
    c = rep["price_choice"]
    lines.append("== выбор цены среди нескольких сумм ==")
    lines.append(f"  случайные A : {fmt(*c['A'])}")
    lines.append(f"  несколько сумм D : {fmt(*c['D'])}")
    lines.append("")
    lines.append("== что нужно сайту, а модель пока не ищет (случайные A) ==")
    lines.append(f"  в тексте есть район / мкр / местность : {fmt(*rep['district_in_text_A'])}")
    lines.append(f"  в тексте есть ориентир               : {fmt(*rep['landmark_in_text_A'])}")
    lines.append(f"  в тексте есть ЖК                     : {fmt(*rep['complex_in_text_A'])}")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("items")
    ap.add_argument("results")
    ap.add_argument("--json", action="store_true", help="print the numbers as JSON")
    args = ap.parse_args()

    payload = json.load(open(args.items, encoding="utf-8"))
    answers = json.load(open(args.results, encoding="utf-8"))
    if answers.get("setId") != payload.get("setId"):
        sys.exit(f"Файл результатов от другого набора ({answers.get('setId')} вместо {payload.get('setId')}).")
    rep = score(payload["items"], answers.get("results", {}))
    print(json.dumps(rep, ensure_ascii=False, indent=1) if args.json else text_report(rep))


if __name__ == "__main__":
    main()
