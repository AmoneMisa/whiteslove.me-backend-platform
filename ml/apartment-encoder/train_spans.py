"""Trains the span tagger: finds PRICE / CURRENCY / ADDRESS / METRO in listing text.

    python train_spans.py --data ./data/span-splits --out ./span-model

Data comes from apps/flats/scripts/build-span-dataset.mjs. One shared
multilingual transformer with, per token, one 3-way (O / B / I) head for each
entity. An entity the row marks as `ignore` (its stored value could not be
reliably located in the text) is masked out of the loss for that row instead of
being trained as "nothing here".

Built to be fast on one consumer GPU: texts are tokenized once up front,
batches are grouped by length so padding is minimal, the (huge, mostly unused)
word-embedding matrix is frozen, and rows with at least one located span are
taken first when the training set is capped.
"""
import argparse
import json
import random
import re
import time
from pathlib import Path

import torch
from torch import nn
from transformers import AutoModel, AutoTokenizer

# The entities the active model reads. New ones are only ever appended, so the first four of a newer
# model line up with an older one. Models trained before DISTRICT and LANDMARK existed carry their own
# list in config.json: call set_entities(cfg.get("entities", LEGACY_ENTITIES)) before building them.
LEGACY_ENTITIES = ["PRICE", "CURRENCY", "ADDRESS", "METRO"]
ENTITIES = ["PRICE", "CURRENCY", "ADDRESS", "METRO", "DISTRICT", "LANDMARK", "COMPLEX", "MICRODISTRICT", "LOCALITY", "DEPOSIT", "UTILITIES", "NEARBY"]
TAGS = ["O", "B", "I"]


def set_entities(names):
    """Switch the active entity list in place, so every function that reads ENTITIES sees it."""
    ENTITIES[:] = list(names)


def load(path):
    # split on LF only: str.splitlines() also breaks on U+2028/U+2029 inside listing text
    text = Path(path).read_text(encoding="utf-8")
    return [json.loads(line) for line in text.split(chr(10)) if line.strip()]


def autocast(device):
    # device_type must name a device that exists even when autocast is disabled (a CPU-only machine)
    return torch.autocast(device_type="cuda" if device == "cuda" else "cpu", dtype=torch.bfloat16, enabled=device == "cuda")


class Tagger(nn.Module):
    def __init__(self, base, freeze_embeddings=True):
        super().__init__()
        self.backbone = AutoModel.from_pretrained(base)
        if freeze_embeddings:
            # ~70% of XLM-R's parameters; no gradient or optimizer state for them
            self.backbone.embeddings.word_embeddings.weight.requires_grad_(False)
        self.drop = nn.Dropout(0.1)
        self.head = nn.Linear(self.backbone.config.hidden_size, len(ENTITIES) * len(TAGS))

    def forward(self, input_ids, attention_mask):
        states = self.backbone(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state
        logits = self.head(self.drop(states))
        return logits.view(*logits.shape[:2], len(ENTITIES), len(TAGS))  # [batch, tokens, entity, tag]


def token_tags(offsets, spans, entity):
    """Per-token tag ids for one entity from character spans."""
    tags = [0] * len(offsets)
    for start, end in ((s["start"], s["end"]) for s in spans if s["label"] == entity):
        first = True
        for i, (a, b) in enumerate(offsets):
            if b <= a:  # special token
                continue
            if a < end and b > start:
                tags[i] = 1 if first else 2
                first = False
    return tags


def token_mask(offsets, neutral):
    """1.0 per token and entity, 0.0 where a neutral range covers the token for that entity."""
    mask = [[1.0] * len(ENTITIES) for _ in offsets]
    for n in neutral:
        if n["label"] not in ENTITIES:  # a label the active model does not read (e.g. DISTRICT for a 4-entity model)
            continue
        j = ENTITIES.index(n["label"])
        for i, (a, b) in enumerate(offsets):
            if b > a and a < n["end"] and b > n["start"]:
                mask[i][j] = 0.0
    return mask


PLACEHOLDER = re.compile(r"\[(?:PHONE|EMAIL|URL|TELEGRAM)\]")

# "Депозит 300" is a capitalised word and a number, which is also what "Краснова 67"
# looks like. Words that name a listing attribute rather than a street rule it out.
NOT_AN_ADDRESS = re.compile(
    r"^(?:депозит|залог|заклад|комисси|комісі|этаж|поверх|цена|ціна|оплата|предоплата|"
    r"id|тел|комнат|кімнат|площад\w*\s+\d|общая|загальна|sotix|narx|etaj|camere|pret)\w*\b",
    re.IGNORECASE,
)
# Cities and countries are named next to "метро" or in the agency's boilerplate
# ("по городу Ташкент") and are not stations.
NOT_A_STATION = re.compile(
    r"^(?:ташкент|тошкент|toshkent|tashkent|київ|киев|kyiv|kiev|харків|харьков|одеса|одесса|львів|львов|"
    r"дніпро|днепр|алматы|астана|бишкек|бухарест|bucuresti|bucharest|кишинёв|кишинев|chisinau|самарканд|"
    r"samarkand|узбекистан|ўзбекистон|oʻzbekiston|україна|украина|казахстан|кыргызстан|румыния|romania|"
    r"москва|moscow)$",
    re.IGNORECASE,
)


# "Toshkent" is also a station of the Tashkent metro, so a city name is dropped only
# when nothing next to it says "metro". Same cues as the aligner (span-align.js).
METRO_CUE_BEFORE = re.compile(r"(?:метро|metro|metrou|станци[яи]|stansiya|bekat|бекат|м\.)[\s\"«'‘ʻ:-]{0,6}$", re.IGNORECASE)
METRO_CUE_AFTER = re.compile(r"^\s{0,2}(?:метро|metro|metrosi|metrou|станци)", re.IGNORECASE)


def has_metro_cue(text, a, b):
    return bool(METRO_CUE_BEFORE.search(text[max(0, a - 30):a]) or METRO_CUE_AFTER.search(text[b:b + 14]))


def is_word_char(ch):
    return ch.isalnum() or ch in "'’ʻ`"


def postfilter(entity, text, spans):
    """Drop spans that cannot be right: redaction placeholders, a price with no digit."""
    blocked = [m.span() for m in PLACEHOLDER.finditer(text)]
    keep = []
    for a, b in spans:
        # A name cut inside a word ("Виду|бичі", "Doʻ|stligi") is a subword artifact: widen it to the
        # whole word. Not for price and currency: those are often glued, "500грн", and widening swallowed
        # (F1 fell 0.03), on address and district it cost 0.02-0.04.
        if entity == "METRO":
            while a > 0 and is_word_char(text[a - 1]) and is_word_char(text[a]):
                a -= 1
            while b < len(text) and is_word_char(text[b]) and is_word_char(text[b - 1]):
                b += 1
        # "Абая 5." is the address "Абая 5". Not for currency: "грн." keeps its dot.
        while entity != "CURRENCY" and b > a and text[b - 1] in ".,;:!?-–—":
            b -= 1
        if any(a < pb and pa < b for pa, pb in blocked):
            continue
        piece = text[a:b]
        if entity in ("PRICE", "DEPOSIT", "UTILITIES") and not re.search(r"\d", piece):
            continue
        # Fragments of a subword ("К", "Ша", "ул") are model artifacts, not names.
        if entity == "METRO" and len(re.findall(r"\w", piece)) < 3:
            continue
        if entity == "ADDRESS" and len(re.findall(r"[^\W\d_]", piece)) < 4:
            continue
        if entity == "ADDRESS" and NOT_AN_ADDRESS.match(piece.strip()):
            continue
        if entity == "METRO" and NOT_A_STATION.match(piece.strip()) and not has_metro_cue(text, a, b):
            continue
        # A district or landmark is a name: it needs letters (a bare number or a sign is an artifact).
        if entity in ("DISTRICT", "LANDMARK", "COMPLEX", "MICRODISTRICT", "LOCALITY", "NEARBY") and len(re.findall(r"[^\W\d_]", piece)) < 3:
            continue
        if b > a:
            keep.append((a, b))
    return keep


def encode_all(rows, tok, max_len, chunk=2000):
    """Tokenize everything once. Returns per-row dicts with ids, offsets, tags, use-mask."""
    out = []
    for i in range(0, len(rows), chunk):
        part = rows[i:i + chunk]
        enc = tok([r["text"] for r in part], truncation=True, max_length=max_len, return_offsets_mapping=True)
        for r, ids, offsets in zip(part, enc["input_ids"], enc["offset_mapping"]):
            out.append({
                "ids": ids,
                "offsets": offsets,
                "tags": [token_tags(offsets, r["spans"], e) for e in ENTITIES],
                "use": [0.0 if e in r["ignore"] else 1.0 for e in ENTITIES],
                "tmask": token_mask(offsets, r.get("neutral", [])),
                "row": r,
            })
    return out


def collate(items, pad_id):
    width = max(len(it["ids"]) for it in items)
    ids = torch.full((len(items), width), pad_id, dtype=torch.long)
    mask = torch.zeros(len(items), width, dtype=torch.long)
    labels = torch.zeros(len(items), width, len(ENTITIES), dtype=torch.long)
    for i, it in enumerate(items):
        n = len(it["ids"])
        ids[i, :n] = torch.tensor(it["ids"])
        mask[i, :n] = 1
        labels[i, :n] = torch.tensor(it["tags"]).T
    use = torch.tensor([it["use"] for it in items])
    tmask = torch.ones(len(items), width, len(ENTITIES))
    for i, it in enumerate(items):
        tmask[i, :len(it["ids"])] = torch.tensor(it["tmask"])
    return ids, mask, labels, use, tmask


def length_grouped(items, size, shuffle):
    """Batches of similar length: shuffle, sort inside big windows, then shuffle the batches."""
    order = list(range(len(items)))
    if shuffle:
        random.shuffle(order)
    window = size * 64
    batches = []
    for i in range(0, len(order), window):
        part = sorted(order[i:i + window], key=lambda j: len(items[j]["ids"]))
        batches += [part[k:k + size] for k in range(0, len(part), size)]
    if shuffle:
        random.shuffle(batches)
    return batches


def span_loss(logits, labels, use, attention_mask, tag_weights, tmask):
    ce = nn.functional.cross_entropy(
        logits.reshape(-1, len(TAGS)), labels.reshape(-1), weight=tag_weights, reduction="none"
    ).view(labels.shape)
    # [batch, tokens, entity]; tmask zeroes neutral mentions (e.g. a deposit amount)
    mask = attention_mask.unsqueeze(-1).float() * use.unsqueeze(1) * tmask
    return (ce * mask).sum() / mask.sum().clamp(min=1.0)


def decode(tags, offsets, text):
    """Greedy BIO -> character spans."""
    out, cur = [], None
    for tag, (a, b) in zip(tags, offsets):
        if b <= a:
            continue
        if tag == 1 or (tag == 2 and cur is None):
            if cur:
                out.append(cur)
            cur = [a, b]
        elif tag == 2:
            cur[1] = b
        else:
            if cur:
                out.append(cur)
            cur = None
    if cur:
        out.append(cur)
    trimmed = []
    for a, b in out:
        while a < b and text[a].isspace():
            a += 1
        while b > a and text[b - 1].isspace():
            b -= 1
        if b > a:
            trimmed.append((a, b))
    return trimmed


@torch.no_grad()
def evaluate(model, items, pad_id, args, device):
    model.eval()
    zero = ("tp", "fp", "fn", "lenient_tp", "gold", "found", "soft_pred", "soft_gold")
    stat = {e: {k: 0 for k in zero} for e in ENTITIES}
    for batch in length_grouped(items, args.batch_size * 2, False):
        chunk = [items[j] for j in batch]
        ids, mask, _, _, _ = collate(chunk, pad_id)
        with autocast(device):
            logits = model(ids.to(device), mask.to(device))
        pred = logits.float().argmax(-1).cpu()
        for i, it in enumerate(chunk):
            r = it["row"]
            limit = max((b for _, b in it["offsets"]), default=0)  # text past truncation was never seen
            for j, entity in enumerate(ENTITIES):
                if entity in r["ignore"]:
                    continue
                gold = [(s["start"], s["end"]) for s in r["spans"] if s["label"] == entity and s["end"] <= limit]
                found = postfilter(entity, r["text"], decode(pred[i, :len(it["ids"]), j].tolist(), it["offsets"], r["text"]))
                neutral = [(n["start"], n["end"]) for n in r.get("neutral", []) if n["label"] == entity]
                found = [(a, b) for a, b in found if not any(a < nb and na < b for na, nb in neutral)]
                s = stat[entity]
                s["gold"] += len(gold)
                s["found"] += len(found)
                s["tp"] += len(set(found) & set(gold))
                s["fp"] += len(set(found) - set(gold))
                s["fn"] += len(set(gold) - set(found))
                s["lenient_tp"] += sum(any(a < gb and ga < b for a, b in found) for ga, gb in gold)
                # Soft match: a span counts when it overlaps a gold span by IoU >= 0.5.
                s["soft_pred"] += sum(any(iou(f, g) >= 0.5 for g in gold) for f in found)
                s["soft_gold"] += sum(any(iou(f, g) >= 0.5 for f in found) for g in gold)
    report = {}
    for e, s in stat.items():
        p = s["tp"] / max(s["tp"] + s["fp"], 1)
        rc = s["tp"] / max(s["tp"] + s["fn"], 1)
        sp = s["soft_pred"] / max(s["found"], 1)
        sr = s["soft_gold"] / max(s["gold"], 1)
        report[e] = {
            "precision": round(p, 4), "recall": round(rc, 4),
            "f1": round(2 * p * rc / max(p + rc, 1e-9), 4),
            "soft_precision": round(sp, 4), "soft_recall": round(sr, 4),
            "soft_f1": round(2 * sp * sr / max(sp + sr, 1e-9), 4),
            "lenient_recall": round(s["lenient_tp"] / max(s["gold"], 1), 4), "gold": s["gold"],
        }
    return report


def iou(a, b):
    inter = max(0, min(a[1], b[1]) - max(a[0], b[0]))
    union = (a[1] - a[0]) + (b[1] - b[0]) - inter
    return inter / union if union else 0.0


def warm_start(model, directory):
    """Start from a trained span model: its backbone, and its head rows for the entities it knew.

    The head is one matrix whose rows are laid out entity by entity (3 tags each), so an older model's
    rows are the first rows of a longer list. Rows of new entities keep their random start.
    """
    directory = Path(directory)
    old_cfg = json.loads((directory / "config.json").read_text(encoding="utf-8"))
    old_entities = old_cfg.get("entities", LEGACY_ENTITIES)
    if ENTITIES[: len(old_entities)] != old_entities:
        raise SystemExit(f"cannot warm start: {old_entities} is not a prefix of {ENTITIES}")
    old = torch.load(directory / "model.pt", map_location="cpu")
    state = model.state_dict()
    for key, value in old.items():
        if not key.startswith("head."):
            state[key] = value
    rows = len(old_entities) * len(TAGS)
    state["head.weight"][:rows] = old["head.weight"]
    state["head.bias"][:rows] = old["head.bias"]
    model.load_state_dict(state)
    print(f"warm start from {directory} ({len(old_entities)} of {len(ENTITIES)} entities known)", flush=True)


def cap_train(rows, limit):
    """Keep every row with a located span first, fill the rest at random."""
    if not limit or len(rows) <= limit:
        return rows
    informative = [r for r in rows if r["spans"]]
    rest = [r for r in rows if not r["spans"]]
    random.shuffle(informative)
    random.shuffle(rest)
    return (informative + rest)[:limit]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--base", default="xlm-roberta-base")
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--batch-size", type=int, default=32)
    ap.add_argument("--max-len", type=int, default=256)
    ap.add_argument("--lr", type=float, default=5e-5)
    ap.add_argument("--seed", type=int, default=13)
    ap.add_argument("--limit-train", type=int, default=0)
    ap.add_argument("--limit-val", type=int, default=8000)
    ap.add_argument("--limit-test", type=int, default=10000)
    ap.add_argument("--train-embeddings", action="store_true", help="also train the word embeddings (slower)")
    ap.add_argument("--init-from", help="warm start from a trained span model (its entities must be a prefix of the current list)")
    args = ap.parse_args()

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    data = Path(args.data)
    tok = AutoTokenizer.from_pretrained(args.base)

    started = time.time()
    train = encode_all(cap_train(load(data / "train.jsonl"), args.limit_train), tok, args.max_len)
    val = encode_all(load(data / "val.jsonl")[: args.limit_val], tok, args.max_len)
    print(f"tokenized {len(train)} train / {len(val)} val rows in {time.time() - started:.0f}s", flush=True)

    model = Tagger(args.base, freeze_embeddings=not args.train_embeddings)
    if args.init_from:
        warm_start(model, args.init_from)
    model = model.to(device)
    # "O" is >95% of tokens; without a boost the model learns to tag nothing.
    tag_weights = torch.tensor([1.0, 6.0, 4.0], device=device)
    params = [p for p in model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=args.lr, weight_decay=0.01, fused=device == "cuda")
    steps = args.epochs * len(length_grouped(train, args.batch_size, False))
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=steps, pct_start=0.1)
    pad_id = tok.pad_token_id

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    best = -1.0
    for epoch in range(args.epochs):
        model.train()
        epoch_started = time.time()
        for step, batch in enumerate(length_grouped(train, args.batch_size, True), 1):
            ids, mask, labels, use, tmask = collate([train[j] for j in batch], pad_id)
            ids, mask, labels, use, tmask = (x.to(device) for x in (ids, mask, labels, use, tmask))
            with autocast(device):
                logits = model(ids, mask)
            loss = span_loss(logits.float(), labels, use, mask, tag_weights, tmask)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            nn.utils.clip_grad_norm_(params, 1.0)
            opt.step()
            sched.step()
            if step % 100 == 0:
                rate = step / (time.time() - epoch_started)
                print(f"epoch {epoch + 1} step {step} loss {loss.item():.4f} {rate:.1f} it/s", flush=True)
        report = evaluate(model, val, pad_id, args, device)
        macro = sum(v["f1"] for v in report.values()) / len(report)
        soft = sum(v["soft_f1"] for v in report.values()) / len(report)
        print(f"epoch {epoch + 1}: val span F1 {macro:.3f} (soft {soft:.3f})", json.dumps(report), flush=True)
        if macro > best:
            best = macro
            torch.save({k: v for k, v in model.state_dict().items()}, out / "model.pt")
            tok.save_pretrained(out)
            (out / "config.json").write_text(json.dumps(
                {"base": args.base, "max_len": args.max_len, "entities": ENTITIES, "val": report},
                ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"best val span F1 {best:.3f} -> {out}", flush=True)

    # Final check on held-out test rows with the best checkpoint.
    model.load_state_dict(torch.load(out / "model.pt", map_location=device))
    test = encode_all(load(data / "test.jsonl")[: args.limit_test], tok, args.max_len)
    test_report = evaluate(model, test, pad_id, args, device)
    cfg = json.loads((out / "config.json").read_text(encoding="utf-8"))
    cfg["test"] = test_report
    (out / "config.json").write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    print("test", json.dumps(test_report), flush=True)


if __name__ == "__main__":
    main()
