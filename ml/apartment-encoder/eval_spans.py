"""Scores a trained span tagger on a split without training.

    python eval_spans.py --model ./span-model --data ./data/span-splits --split test

Useful for comparing a model against a rebuilt dataset: the labels change as the
aligner improves, so a model's old numbers are not comparable with new ones.
"""
import argparse
import json
from pathlib import Path

import torch
from transformers import AutoTokenizer

import train_spans as T


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--data", help="directory with <split>.jsonl")
    ap.add_argument("--split", default="test")
    ap.add_argument("--file", help="a JSONL file of rows to score instead (e.g. data/review-gold.jsonl, the hand-made labels)")
    ap.add_argument("--limit", type=int, default=10000)
    ap.add_argument("--batch-size", type=int, default=32)
    ap.add_argument("--device", help="cpu or cuda (default: cuda when there is one); cpu keeps a training run's GPU free")
    args = ap.parse_args()

    device = args.device or ("cuda" if torch.cuda.is_available() else "cpu")
    cfg = json.loads((Path(args.model) / "config.json").read_text(encoding="utf-8"))
    tok = AutoTokenizer.from_pretrained(args.model)
    T.set_entities(cfg.get("entities", T.LEGACY_ENTITIES))  # an older model reads fewer entities
    model = T.Tagger(cfg["base"], freeze_embeddings=True)
    model.load_state_dict(torch.load(Path(args.model) / "model.pt", map_location="cpu"))
    model.to(device)
    if not args.file and not args.data:
        ap.error("give --data (with --split) or --file")
    source = Path(args.file) if args.file else Path(args.data) / f"{args.split}.jsonl"
    rows = T.load(source)[: args.limit]
    items = T.encode_all(rows, tok, cfg["max_len"])
    report = T.evaluate(model, items, tok.pad_token_id, args, device)
    for entity, v in report.items():
        if v["gold"] == 0:
            print(f"{entity:9s} no gold spans in this data (nothing to score)")
            continue
        print(f"{entity:9s} F1 {v['f1']:.3f} (P {v['precision']:.3f} R {v['recall']:.3f})  "
              f"soft F1 {v['soft_f1']:.3f} (P {v['soft_precision']:.3f} R {v['soft_recall']:.3f})  n={v['gold']}")
    scored = [v for v in report.values() if v["gold"]]
    if scored:
        print(f"macro F1 {sum(v['f1'] for v in scored) / len(scored):.3f}  "
              f"soft {sum(v['soft_f1'] for v in scored) / len(scored):.3f}  (over {len(scored)} entities with gold)")


if __name__ == "__main__":
    main()
