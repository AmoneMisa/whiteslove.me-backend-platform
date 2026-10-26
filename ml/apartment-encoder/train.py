"""Trains the apartment encoder on JSONL from apps/flats/scripts/export-encoder-dataset.mjs.

    python train.py --data ./encoder-dataset --out ./model

One shared multilingual transformer, mean-pooled, with one small classification
head per field: yes/no/unsaid for flags, the listed values plus unsaid for enums.
Each example's loss on each field is scaled by its `weight` (provenance tier),
so structured labels dominate and model-guessed labels only nudge.
"""
import argparse
import json
import random
from pathlib import Path

import torch
from torch import nn
from transformers import AutoModel, AutoTokenizer

BOOL_CLASSES = ["unsaid", "no", "yes"]
# Keep in sync with ENUM_TARGETS in apps/flats/src/ml/encoder-dataset.js.
ENUM_TARGETS = {"condition": ["needs_renovation", "basic", "good", "modern", "luxury"]}


def autocast(device):
    return torch.autocast(device_type="cuda", dtype=torch.bfloat16, enabled=device == "cuda")


def load(path):
    # split on LF only: str.splitlines() also breaks on U+2028/U+2029 inside listing text
    text = Path(path).read_text(encoding="utf-8")
    return [json.loads(line) for line in text.split(chr(10)) if line.strip()]


def field_classes(fields):
    return {f: ["unsaid", *ENUM_TARGETS[f]] if f in ENUM_TARGETS else BOOL_CLASSES for f in fields}


class Encoder(nn.Module):
    def __init__(self, base, classes):
        super().__init__()
        self.backbone = AutoModel.from_pretrained(base)
        hidden = self.backbone.config.hidden_size
        self.drop = nn.Dropout(0.1)
        self.heads = nn.ModuleDict({f: nn.Linear(hidden, len(c)) for f, c in classes.items()})

    def forward(self, input_ids, attention_mask):
        states = self.backbone(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state
        mask = attention_mask.unsqueeze(-1).to(states.dtype)
        pooled = self.drop((states * mask).sum(1) / mask.sum(1).clamp(min=1))
        return {f: head(pooled) for f, head in self.heads.items()}


def batches(rows, tok, classes, size, max_len, shuffle):
    order = list(range(len(rows)))
    if shuffle:
        random.shuffle(order)
    for i in range(0, len(order), size):
        chunk = [rows[j] for j in order[i:i + size]]
        enc = tok([r["text"] for r in chunk], truncation=True, max_length=max_len, padding=True, return_tensors="pt")
        y = {f: torch.tensor([classes[f].index(r["labels"][f]) for r in chunk]) for f in classes}
        w = {f: torch.tensor([float(r["weights"][f]) for r in chunk]) for f in classes}
        yield enc, y, w


def weighted_loss(logits, y, w, class_weights):
    total, n = 0.0, 0
    for f, out in logits.items():
        ce = nn.functional.cross_entropy(out, y[f], weight=class_weights[f], reduction="none")
        total = total + (ce * w[f]).sum() / w[f].sum().clamp(min=1e-6)
        n += 1
    return total / n


def class_weights_for(rows, classes, device):
    """Inverse-frequency weights: 'unsaid' dominates most flags and would win by default."""
    out = {}
    for f, names in classes.items():
        counts = torch.ones(len(names))
        for r in rows:
            if r["weights"][f] > 0:
                counts[names.index(r["labels"][f])] += 1
        out[f] = (counts.sum() / (len(names) * counts)).clamp(max=20.0).to(device)
    return out


@torch.no_grad()
def evaluate(model, rows, tok, classes, args, device):
    model.eval()
    conf = {f: torch.zeros(len(c), len(c)) for f, c in classes.items()}
    for enc, y, w in batches(rows, tok, classes, args.batch_size * 2, args.max_len, False):
        with autocast(device):
            logits = model(enc["input_ids"].to(device), enc["attention_mask"].to(device))
        for f, out in logits.items():
            for t, p, wt in zip(y[f].tolist(), out.argmax(-1).cpu().tolist(), w[f].tolist()):
                if wt > 0:  # ungrounded labels are not ground truth
                    conf[f][t, p] += 1
    report = {}
    for f, m in conf.items():
        f1s = []
        for k in range(m.shape[0]):
            tp, fp, fn = m[k, k], m[:, k].sum() - m[k, k], m[k, :].sum() - m[k, k]
            if tp + fn > 0:  # skip classes absent from this split
                f1s.append((2 * tp / (2 * tp + fp + fn).clamp(min=1)).item())
        report[f] = sum(f1s) / max(len(f1s), 1)
    return report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--base", default="xlm-roberta-base")
    ap.add_argument("--epochs", type=int, default=4)
    ap.add_argument("--batch-size", type=int, default=16)
    ap.add_argument("--max-len", type=int, default=256)
    ap.add_argument("--lr", type=float, default=3e-5)
    ap.add_argument("--seed", type=int, default=13)
    ap.add_argument("--limit-train", type=int, default=0, help="use a random subset of train (smoke runs)")
    args = ap.parse_args()

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    data = Path(args.data)
    train, val = load(data / "train.jsonl"), load(data / "val.jsonl")
    if args.limit_train:
        random.shuffle(train)
        train = train[: args.limit_train]
    classes = field_classes(sorted(train[0]["labels"]))

    tok = AutoTokenizer.from_pretrained(args.base)
    model = Encoder(args.base, classes).to(device)
    cw = class_weights_for(train, classes, device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    steps = args.epochs * ((len(train) + args.batch_size - 1) // args.batch_size)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=steps, pct_start=0.1)

    best = -1.0
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for epoch in range(args.epochs):
        model.train()
        for step, (enc, y, w) in enumerate(batches(train, tok, classes, args.batch_size, args.max_len, True), 1):
            with autocast(device):
                logits = model(enc["input_ids"].to(device), enc["attention_mask"].to(device))
            loss = weighted_loss({f: o.float() for f, o in logits.items()},
                                 {f: t.to(device) for f, t in y.items()},
                                 {f: t.to(device) for f, t in w.items()}, cw)
            opt.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            if step % 200 == 0:
                print(f"epoch {epoch + 1} step {step} loss {loss.item():.4f}", flush=True)
        report = evaluate(model, val, tok, classes, args, device)
        macro = sum(report.values()) / len(report)
        print(f"epoch {epoch + 1}: val macro-F1 {macro:.3f}")
        if macro > best:
            best = macro
            torch.save(model.state_dict(), out / "model.pt")
            tok.save_pretrained(out)
            (out / "config.json").write_text(json.dumps(
                {"base": args.base, "max_len": args.max_len, "classes": classes, "val_f1": report},
                ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"best val macro-F1 {best:.3f} -> {out}")


if __name__ == "__main__":
    main()
