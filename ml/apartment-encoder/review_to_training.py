"""Turn the hand review into gold span labels, for training and for honest evaluation.

    python review_to_training.py review/items.json review/review_results.json --out data/review-gold.jsonl

One row per card you ticked "checked in full" (skipped compilations are left out). The row's
spans are what you confirmed plus what you selected yourself:

  * every model span you marked "верно"                       (PRICE, CURRENCY, ADDRESS, METRO)
  * every fragment you selected and labelled                  (ADDRESS, METRO, DISTRICT, LANDMARK)

A model span marked "неверно" is simply not in the row: that text is "nothing", which is the
lesson. Rows have the same shape as data/span-splits/*.jsonl (text, spans in code points,
ignore, neutral), so train_spans.py reads them.

Labels you could not have judged are put in `ignore` rather than trained as "nothing here":
a card ticked before districts and landmarks could be marked (page version < 2) says nothing
about DISTRICT and LANDMARK, and one ticked before ЖК could be marked (version < 3) nothing about COMPLEX.

How to use them: the labels are checked by a person, unlike the automatic ones, so they are the
right yardstick (hold them out as a test set) and the only source for DISTRICT and LANDMARK.
A couple of hundred cards is far too few to *teach* an open class such as landmarks; see the
README before training heads on them.
"""
import argparse
import json
import sys
from collections import Counter
from pathlib import Path

LABELS = ("PRICE", "CURRENCY", "ADDRESS", "METRO", "DISTRICT", "LANDMARK", "COMPLEX", "MICRODISTRICT", "LOCALITY", "DEPOSIT", "UTILITIES", "NEARBY",
          "AREA", "FLOOR", "FLOORS_TOTAL", "ROOMS", "COMMISSION", "PREPAYMENT")
# What a card ticked in an older page version cannot tell us: a label that did not exist yet.
# Version 4 told district, microdistrict and locality apart: an older "district" mark covers all three.
# Version 5 added deposit and utilities (and the page now lets you select a price and a currency by hand).
NEEDS_VERSION = {"DISTRICT": 4, "MICRODISTRICT": 4, "LOCALITY": 4, "LANDMARK": 2, "COMPLEX": 3, "DEPOSIT": 5, "UTILITIES": 5,
                 # version 7 added the apartment facts and the fee / advance payment
                 "AREA": 7, "FLOOR": 7, "FLOORS_TOTAL": 7, "ROOMS": 7, "COMMISSION": 7, "PREPAYMENT": 7}


NEARBY_VERSION = 6  # from this page version on, "рядом" is its own button


def is_generic(text):
    """A kind of place named in general words ("школы", "детский сад"): no capital letter and no number anywhere."""
    return not any(ch.isupper() or ch.isdigit() for ch in text)


def gold_row(item, res):
    """The gold row for one reviewed card, plus any problems found in the spans."""
    cps = list(item["text"])
    spans, problems = set(), []

    for ent, found in item["pred"]["spans"].items():
        for i, s in enumerate(found):
            if res.get("spans", {}).get(f"{ent}:{i}") == "ok":
                spans.add((ent, s["start"], s["end"]))

    for a in res.get("added") or []:
        label, start, end = a.get("label"), a.get("start"), a.get("end")
        if label not in LABELS or not isinstance(start, int) or not isinstance(end, int) or not 0 <= start < end <= len(cps):
            problems.append(f"{item['id']}: unusable selection {a!r}")
        elif "".join(cps[start:end]) != a.get("text"):
            problems.append(f"{item['id']}: selection {a.get('text')!r} does not match the text at {start}:{end}")
        else:
            spans.add((label, start, end))

    if res.get("sv", 0) < NEARBY_VERSION:
        # Before the page had "рядом", one "ориентир" button covered both. A generic word marked then is read as
        # "рядом" (an approximation: a lowercase specific place such as "міського озера" would be misread too).
        spans = {("NEARBY" if label == "LANDMARK" and is_generic("".join(cps[s:e])) else label, s, e) for label, s, e in spans}
    ignore = [label for label, version in NEEDS_VERSION.items() if res.get("sv", 0) < version]
    row = {
        "id": item["id"],
        "text": item["text"],
        "spans": [{"label": l, "start": s, "end": e} for l, s, e in sorted(spans, key=lambda x: (x[1], x[2], x[0]))],
        "ignore": ignore,
        "neutral": [],
        "group": item["group"],
        "source": "review",
    }
    return row, problems


def build(items, results):
    rows, problems = [], []
    for item in items:
        res = results.get(item["id"])
        if not res or res.get("skip") or not res.get("seen"):
            continue
        row, probs = gold_row(item, res)
        rows.append(row)
        problems += probs
    return rows, problems


def summary(rows):
    counts = Counter(s["label"] for r in rows for s in r["spans"])
    trusted = sum(1 for r in rows if not r["ignore"])
    lines = [f"{len(rows)} reviewed cards -> gold rows"]
    for label in LABELS:
        lines.append(f"  {label:<9} {counts.get(label, 0):>4} spans")
    lines.append(f"  district / landmark / ЖК are all trusted on {trusted} of {len(rows)} cards "
                 f"(the rest were ticked before some of them could be marked)")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("items")
    ap.add_argument("results")
    ap.add_argument("--out", default="data/review-gold.jsonl")
    args = ap.parse_args()

    payload = json.load(open(args.items, encoding="utf-8"))
    answers = json.load(open(args.results, encoding="utf-8"))
    if answers.get("setId") != payload.get("setId"):
        sys.exit(f"The results file is from another set ({answers.get('setId')} instead of {payload.get('setId')}).")
    rows, problems = build(payload["items"], answers.get("results", {}))

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    print(summary(rows))
    for p in problems:
        print("warning:", p)
    print(f"written: {out}")


if __name__ == "__main__":
    main()
