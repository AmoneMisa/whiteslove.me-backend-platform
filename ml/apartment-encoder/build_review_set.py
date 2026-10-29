"""Build a hand-review set: test listings with the models' predictions highlighted.

    python build_review_set.py --model model --spans-model span-model-v3 \
        --data data/span-splits --raw data/spans_raw.jsonl --out review

Writes review/items.json and review/review.html (open it in a browser, mark each
prediction right or wrong, press "Скачать результаты"), then score the answers with
compare_review.py.

Rows come from the test split, which no model trained on. Four groups, so one number
is not distorted by how rows were picked:

  A  random rows                              overall quality, and recall (what was missed)
  B  database has no address, model found one  how often a *fill-in* address is right
  C  database has no station, model found one  the same for the metro
  D  text mentions several amounts             did it pick the listing's own price

Texts are the already-redacted training texts: contacts are masked.
"""
import argparse
import hashlib
import json
import random
from pathlib import Path

import serve
import train_spans as T

GROUPS = {
    "A": "случайные",
    "B": "адрес: в БД пусто, модель нашла",
    "C": "метро: в БД пусто, модель нашла",
    "D": "несколько сумм в тексте",
}
DEFAULT_SIZES = {"A": 100, "B": 50, "C": 25, "D": 25}


def read_jsonl(path):
    # LF only: U+2028 and friends appear unescaped inside listing text
    with open(path, encoding="utf-8", newline="\n") as f:
        for line in f:
            if line.startswith("{"):
                yield json.loads(line)


def load_db(raw_path, wanted):
    """Stored address / station / price for the wanted ids, from the raw export."""
    db = {}
    for row in read_jsonl(raw_path):
        key = f"{row['source']}:{row['source_id']}"
        if key in wanted:
            db[key] = {k: row.get(k) for k in ("price", "currency", "address", "street", "metro")}
    return db


def has_db(db, field):
    if field == "address":
        return bool(db.get("address") or db.get("street"))
    return bool(db.get(field))


def pick(candidates, k, rng, taken):
    pool = [c for c in candidates if c["id"] not in taken]
    rng.shuffle(pool)
    chosen = pool[:k]
    taken.update(c["id"] for c in chosen)
    return chosen


def write_outputs(out, payload):
    """items.json (for compare_review.py) and the self-contained review.html page."""
    out.mkdir(parents=True, exist_ok=True)
    (out / "items.json").write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    template = (Path(__file__).parent / "review_template.html").read_text(encoding="utf-8")
    # "<" is escaped so listing text can never close the <script> element
    blob = json.dumps(payload, ensure_ascii=False).replace("<", "\\u003c")
    (out / "review.html").write_text(template.replace("/*ITEMS*/", blob), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model")
    ap.add_argument("--spans-model")
    ap.add_argument("--data", help="directory with test.jsonl from build-span-dataset.mjs")
    ap.add_argument("--raw", help="raw export with the stored address / metro / price")
    ap.add_argument("--out", default="review")
    ap.add_argument("--render-only", action="store_true",
                    help="rebuild review.html from the existing items.json (no models, same set id)")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--pool", type=int, default=3500, help="random test rows scanned for groups A, B and C")
    for g, n in DEFAULT_SIZES.items():
        ap.add_argument(f"--n-{g.lower()}", type=int, default=n)
    args = ap.parse_args()
    if args.render_only:
        out = Path(args.out)
        payload = json.loads((out / "items.json").read_text(encoding="utf-8"))
        write_outputs(out, payload)
        print(f"set {payload['setId']}: page rebuilt -> {out / 'review.html'}")
        return
    for required in ("model", "spans_model", "data", "raw"):
        if not getattr(args, required):
            ap.error(f"--{required.replace('_', '-')} is required unless --render-only is given")
    sizes ={g: getattr(args, f"n_{g.lower()}") for g in GROUPS}

    rng = random.Random(args.seed)
    test = list(read_jsonl(Path(args.data) / "test.jsonl"))
    rng.shuffle(test)
    pool = test[: args.pool]
    multi = [r for r in test[args.pool:] if sum(n["label"] == "PRICE" for n in r.get("neutral", [])) >= 2][:400]
    candidates = {r["id"]: r for r in pool + multi}
    print(f"test rows {len(test)}; scanning {len(pool)} + {len(multi)} multi-amount rows", flush=True)

    db = load_db(args.raw, set(candidates))
    device = serve.pick_device()
    predictor = serve.Predictor(serve.load_flags(args.model, device), serve.load_spans(args.spans_model, device), device)

    scored = []
    for i, r in enumerate(candidates.values(), 1):
        if r["id"] not in db:
            continue
        pred = predictor.predict(r["text"])
        scored.append({"id": r["id"], "text": r["text"], "db": db[r["id"]],
                       "pred": {"spans": pred["spans"], "price": pred["price"], "truncated": pred["truncated"]}})
        if i % 500 == 0:
            print(f"  predicted {i}/{len(candidates)}", flush=True)

    in_pool = {r["id"] for r in pool}
    taken = set()
    chosen = {}
    # The special groups first, so the random group cannot use up their rows.
    chosen["D"] = pick([s for s in scored if s["id"] not in in_pool and s["pred"]["price"]], sizes["D"], rng, taken)
    chosen["B"] = pick([s for s in scored if s["id"] in in_pool and not has_db(s["db"], "address")
                        and s["pred"]["spans"]["ADDRESS"]], sizes["B"], rng, taken)
    chosen["C"] = pick([s for s in scored if s["id"] in in_pool and not has_db(s["db"], "metro")
                        and s["pred"]["spans"]["METRO"]], sizes["C"], rng, taken)
    chosen["A"] = pick([s for s in scored if s["id"] in in_pool], sizes["A"], rng, taken)

    items = [dict(item, group=g) for g, rows in chosen.items() for item in rows]
    rng.shuffle(items)
    for n, item in enumerate(items, 1):
        item["n"] = n
    set_id = hashlib.sha1("|".join(sorted(i["id"] for i in items)).encode()).hexdigest()[:10]

    out = Path(args.out)
    payload = {"setId": set_id, "groups": GROUPS, "items": items}
    write_outputs(out, payload)

    counts = {g: len(rows) for g, rows in chosen.items()}
    print(f"set {set_id}: {len(items)} items {counts} -> {out / 'review.html'}")
    short = {g: (sizes[g], len(rows)) for g, rows in chosen.items() if len(rows) < sizes[g]}
    if short:
        print("note: fewer rows than requested (wanted, got):", short)


if __name__ == "__main__":
    main()
