"""Pick about twenty hard test listings for hand labelling, and build a review page for them.

    python build_hard_set.py --model model --spans-model span-model-v3 \
        --data data/span-splits6 --raw data/spans_raw2.jsonl --exclude review/items.json --out review-hard

The point is a small, deliberately difficult set that a person labels carefully with the new entities
(DISTRICT, LANDMARK, COMPLEX) as well as the old ones. Hard here means what the automatic labels and
the models find hardest, chosen from the test split (no model trained on it):

  L  a list of landmarks ("Ориентир: ..., ..., ...")
  X  a district, a landmark and a ЖК all in one text, with other places named beside them
  N  a district written as a bare name ("Глинка", "Гидропарк"), with no word "район"
  R  Romanian, or Uzbek in Latin letters
  M  several streets or house numbers in one text
  T  a long text (past what the model reads)
  E  a post full of emoji

It writes the same files as build_review_set.py (items.json, review.html), under its own set id, so
the 200-card review and its answers are untouched. Predictions are the span model's; a model that
predates an entity shows nothing for it, and you add those by selecting text.
"""
import argparse
import hashlib
import json
import random
import re
from pathlib import Path

import serve
import train_spans as T
from build_review_set import load_db, read_jsonl, write_outputs

GROUPS = {
    "L": "список ориентиров",
    "X": "район + ориентир + ЖК вместе",
    "N": "район без слова «район»",
    "R": "румынский / узбекский латиницей",
    "M": "несколько адресов",
    "T": "длинный текст",
    "E": "пост с эмодзи",
    "P": "залог / коммунальные",
    "K": "микрорайон / махалля / местность",
}
QUOTAS = {"L": 4, "X": 4, "N": 3, "R": 3, "M": 3, "T": 2, "E": 1}
# --size 40: the same kinds, with deposit / utilities and the smaller kinds of place added
QUOTAS_40 = {"L": 5, "X": 4, "N": 4, "R": 4, "M": 5, "T": 2, "E": 1, "P": 8, "K": 7}
DEPOSIT_CUE = re.compile(r"залог|депозит|застав|завдат|коммунал|комунал|garan[țt]|depozit|utilit|kommunal|komunal", re.I)
SMALL_PLACE = re.compile(r"мкр|микрорайон|мікрорайон|махал|mahall|квартал|массив|cartier|местност", re.I)
DISTRICT_NOUN = re.compile(r"район|р-н|мкр|мікрорайон|микрорайон|массив|квартал|mavze|hudud|tuman|raion|sector|zona|cartier", re.I)
ROMANIAN = re.compile(r"[ăâîșțşţ]")
UZBEK_LATIN = re.compile(r"(?:o|g)['ʻ’`]|\b(?:xona|xonali|kvartira|ijara|narxi|manzil|moʻljal|mo'ljal)\b", re.I)
EMOJI = re.compile("[\U0001F300-\U0001FAFF☀-➿]")


def count(row, label):
    return sum(1 for s in row["spans"] if s["label"] == label)


def kinds(row):
    """Which hard-set categories a row qualifies for (a row may qualify for several)."""
    text = row["text"]
    out = set()
    if count(row, "LANDMARK") >= 3:
        out.add("L")
    if count(row, "DISTRICT") and count(row, "LANDMARK") and count(row, "COMPLEX") and len(row.get("neutral", [])) >= 2:
        out.add("X")
    bare = [s for s in row["spans"] if s["label"] == "DISTRICT"
            and not DISTRICT_NOUN.search("".join(list(text)[s["start"]:s["end"]]))]
    if bare and count(row, "DISTRICT") == len(bare):
        out.add("N")
    if len(ROMANIAN.findall(text)) >= 3 or UZBEK_LATIN.search(text):
        out.add("R")
    if count(row, "ADDRESS") >= 2 or sum(1 for n in row.get("neutral", []) if n["label"] == "ADDRESS") >= 2:
        out.add("M")
    if len(text) > 1500:
        out.add("T")
    if len(EMOJI.findall(text)) >= 8 and (count(row, "COMPLEX") or count(row, "DISTRICT")):
        out.add("E")
    if DEPOSIT_CUE.search(text) and (count(row, "DEPOSIT") or count(row, "UTILITIES") or re.search(r"\d", text)):
        out.add("P")
    if count(row, "MICRODISTRICT") or count(row, "LOCALITY") or SMALL_PLACE.search(text):
        out.add("K")
    return out


def looks_like_a_compilation(row):
    """Several flats or search filters in one text: the amounts repeat. Not a good hand-labelling target."""
    return sum(1 for n in row.get("neutral", []) if n["label"] == "PRICE") >= 4


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--spans-model", required=True)
    ap.add_argument("--data", required=True, help="directory with test.jsonl")
    ap.add_argument("--raw", required=True, help="raw export with the stored address / metro / price")
    ap.add_argument("--exclude", nargs="*", default=[], help="items.json of existing review sets whose cards must not be repeated")
    ap.add_argument("--out", default="review-hard")
    ap.add_argument("--seed", type=int, default=5)
    ap.add_argument("--device", default="cpu", help="cpu keeps the GPU free for a training run")
    ap.add_argument("--max-chars", type=int, default=2400)
    ap.add_argument("--size", type=int, choices=(20, 40), default=20, help="how many cards (40 adds deposit and small-place kinds)")
    args = ap.parse_args()

    rng = random.Random(args.seed)
    taken = set()
    for path in args.exclude:
        taken |= {i["id"] for i in json.loads(Path(path).read_text(encoding="utf-8"))["items"]}

    pools = {k: [] for k in GROUPS}
    seen = 0
    for row in read_jsonl(Path(args.data) / "test.jsonl"):
        seen += 1
        if row["id"] in taken or len(row["text"]) > args.max_chars or looks_like_a_compilation(row):
            continue
        for k in kinds(row):
            pools[k].append(row)
    print(f"scanned {seen} test rows; candidates per kind: { {k: len(v) for k, v in pools.items()} }", flush=True)

    quotas = QUOTAS_40 if args.size == 40 else QUOTAS
    chosen, used = [], set()
    for k, quota in quotas.items():
        pool = [r for r in pools[k] if r["id"] not in used]
        rng.shuffle(pool)
        for row in pool[:quota]:
            used.add(row["id"])
            chosen.append((k, row))
    # a thin category is topped up from the dense "X" pool rather than left short
    short = sum(quotas.values()) - len(chosen)
    if short > 0:
        extra = [r for r in pools["X"] + pools["L"] if r["id"] not in used]
        rng.shuffle(extra)
        for row in extra[:short]:
            used.add(row["id"])
            chosen.append(("X", row))

    db = load_db(args.raw, {row["id"] for _, row in chosen})
    device = args.device
    predictor = serve.Predictor(serve.load_flags(args.model, device), serve.load_spans(args.spans_model, device), device)

    items = []
    for kind, row in chosen:
        if row["id"] not in db:
            continue
        pred = predictor.predict(row["text"])
        items.append({"id": row["id"], "text": row["text"], "db": db[row["id"]], "group": kind,
                      "pred": {"spans": pred["spans"], "price": pred["price"], "truncated": pred["truncated"]}})
    rng.shuffle(items)
    for n, item in enumerate(items, 1):
        item["n"] = n
    set_id = hashlib.sha1("|".join(sorted(i["id"] for i in items)).encode()).hexdigest()[:10]
    payload = {"setId": set_id, "groups": GROUPS, "items": items}
    write_outputs(Path(args.out), payload)

    import collections
    print(f"set {set_id}: {len(items)} cards {dict(collections.Counter(i['group'] for i in items))} -> {Path(args.out) / 'review.html'}")


if __name__ == "__main__":
    main()
