"""HTTP inference for the trained apartment encoder (stdlib server).

    python serve.py --model ./model --spans-model ./span-model-v3 --port 4040

POST /predict {"text": "..."} ->
  {
    "fields": {"dishwasher": {"label": "yes", "prob": 0.97}, ...},
    "confidence": 0.93,
    "spans": {"PRICE": [{"start": 10, "end": 13, "text": "700"}], "CURRENCY": [...],
              "ADDRESS": [...], "METRO": [...]},
    "price": {"amount": 700, "span": {...}, "currency": {...}, "candidates": [...]},
    "truncated": false
  }
GET /health -> {"ok": true, "flags": true, "spans": true}

`spans` and `price` are present only when --spans-model is given. Offsets count
Unicode code points (what Python indexes), not UTF-16 units. `truncated` means the
text was longer than the span model reads, so mentions past that point were not seen.
`price` is the amount chosen among all price spans (see price_select.py); callers
that want every amount use `spans.PRICE` / `price.candidates`.

It returns raw labels, probabilities and spans; turning them into the ai-worker's
apartment shape (and dropping uncertain ones) happens in the worker. The text is
expected to be already redacted (contacts replaced with [PHONE] etc.), as in training.
"""
import argparse
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import torch
from transformers import AutoTokenizer

import price_select
import train_spans as T
from train import Encoder


def pick_device():
    return "cuda" if torch.cuda.is_available() else "cpu"


def load_flags(model_dir, device):
    model_dir = Path(model_dir)
    cfg = json.loads((model_dir / "config.json").read_text(encoding="utf-8"))
    tok = AutoTokenizer.from_pretrained(model_dir)
    model = Encoder(cfg["base"], cfg["classes"])
    model.load_state_dict(torch.load(model_dir / "model.pt", map_location="cpu"))
    return model.to(device).eval(), tok, cfg


def load_spans(model_dir, device):
    model_dir = Path(model_dir)
    cfg = json.loads((model_dir / "config.json").read_text(encoding="utf-8"))
    tok = AutoTokenizer.from_pretrained(model_dir)
    T.set_entities(cfg.get("entities", T.LEGACY_ENTITIES))  # a model trained before DISTRICT / LANDMARK reads four
    model = T.Tagger(cfg["base"], freeze_embeddings=True)
    model.load_state_dict(torch.load(model_dir / "model.pt", map_location="cpu"))
    return model.to(device).eval(), tok, cfg


class Predictor:
    def __init__(self, flags, spans, device):
        self.flags, self.spans, self.device = flags, spans, device
        self.lock = threading.Lock()  # one forward pass at a time on the device

    @torch.no_grad()
    def predict_flags(self, text):
        model, tok, cfg = self.flags
        enc = tok([text], truncation=True, max_length=cfg["max_len"], return_tensors="pt").to(self.device)
        logits = model(enc["input_ids"], enc["attention_mask"])
        fields, top = {}, []
        for f, out in logits.items():
            probs = out.softmax(-1)[0]
            k = int(probs.argmax())
            fields[f] = {"label": cfg["classes"][f][k], "prob": round(float(probs[k]), 4)}
            top.append(float(probs[k]))
        return {"fields": fields, "confidence": round(sum(top) / len(top), 4)}

    @torch.no_grad()
    def predict_spans(self, text):
        model, tok, cfg = self.spans
        row = {"text": text, "spans": [], "ignore": [], "neutral": []}
        # A long text is read in overlapping windows; each span comes from the window that owns its start.
        items = T.encode_all([row], tok, cfg["max_len"])
        found = {e: [] for e in T.ENTITIES}
        for item in items:
            ids, mask, *_ = T.collate([item], tok.pad_token_id)
            with T.autocast(self.device):
                logits = model(ids.to(self.device), mask.to(self.device))
            pred = logits.float().argmax(-1).cpu()[0]
            lo, hi = item["own"]
            for j, e in enumerate(T.ENTITIES):
                spans = T.decode(pred[: len(item["ids"]), j].tolist(), item["offsets"], text)
                found[e].extend(sp for sp in T.postfilter(e, text, spans) if lo <= sp[0] < hi)
        found = {e: sorted(set(v)) for e, v in found.items()}
        spans = {e: [{"start": a, "end": b, "text": text[a:b]} for a, b in found[e]] for e in T.ENTITIES}

        price = None
        chosen = price_select.select_price(text, found["PRICE"], found["CURRENCY"])
        if chosen is not None:
            ranked = price_select.rank_prices(text, found["PRICE"], found["CURRENCY"])
            a, b = found["PRICE"][chosen]
            cur = price_select.nearest_currency((a, b), found["CURRENCY"])
            top = max(r["score"] for r in ranked)
            price = {
                "amount": ranked[chosen]["amount"],
                # Several amounts tie for the best score (e.g. a post listing several flats):
                # the choice is just the earliest one and should not be trusted as certain.
                "ambiguous": sum(r["score"] == top for r in ranked) > 1,
                "span": {"start": a, "end": b, "text": text[a:b]},
                "currency": None if cur is None else {"start": cur[0], "end": cur[1], "text": text[cur[0]:cur[1]]},
                "candidates": [
                    {"start": r["start"], "end": r["end"], "text": text[r["start"]:r["end"]],
                     "amount": r["amount"], "score": r["score"]}
                    for r in ranked
                ],
            }
        return {"spans": spans, "price": price, "truncated": False}

    def predict(self, text):
        with self.lock:
            out = self.predict_flags(text)
            if self.spans:
                out.update(self.predict_spans(text))
        return out


def make_handler(predictor):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, status, body):
            data = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/health":
                self._send(200, {"ok": True, "flags": True, "spans": predictor.spans is not None})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/predict":
                return self._send(404, {"error": "not found"})
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
                text = str(body["text"]).strip()
                if not text:
                    raise ValueError("empty text")
            except (ValueError, KeyError) as e:  # JSONDecodeError is a ValueError
                return self._send(400, {"error": str(e)})
            self._send(200, predictor.predict(text))

        def log_message(self, *args):
            pass

    return Handler


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="flags/enum encoder directory")
    ap.add_argument("--spans-model", help="span tagger directory (price / currency / address / metro)")
    ap.add_argument("--port", type=int, default=4040)
    args = ap.parse_args()

    device = pick_device()
    flags = load_flags(args.model, device)
    spans = load_spans(args.spans_model, device) if args.spans_model else None
    predictor = Predictor(flags, spans, device)
    print(f"apartment encoder on :{args.port} ({device}; spans {'on' if spans else 'off'})", flush=True)
    ThreadingHTTPServer(("0.0.0.0", args.port), make_handler(predictor)).serve_forever()
