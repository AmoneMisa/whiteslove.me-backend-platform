"""Serve the review page on the local network, so it can be filled in from a phone.

    python review_server.py --dir review

Prints a link with a one-off key. Open it on the PC and on the phone (same Wi-Fi). Answers
from every device are merged into review/review_results.json -- the same file the page's
"Скачать результаты" button makes, so compare_review.py reads it directly. Ctrl+C stops it.

Plain HTTP on your own network, protected only by the key in the link: use it on a home
Wi-Fi you trust and stop it when done. Nothing is sent outside the local network.
"""
import argparse
import json
import os
import secrets
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

MAX_BODY = 5 * 1024 * 1024


def lan_ip():
    """The address other devices on this network reach this PC at."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no packet is sent; this only picks the outgoing interface
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def touched(answers):
    """The card holds at least one answer. A blank card is just "looked at" and carries nothing."""
    return bool(
        answers.get("seen") or answers.get("skip") or answers.get("choice") or answers.get("note") or answers.get("added")
        or answers.get("spans") or answers.get("db") or any((answers.get("missed") or {}).values())
    )


def newer(incoming, current):
    """Same rule as the page: the later edit wins; at equal age, the card further along."""
    if current is None:
        return True
    a, b = incoming.get("t") or 0, current.get("t") or 0
    if a != b:
        return a > b
    return bool(incoming.get("seen")) and not current.get("seen")


def merge_results(current, incoming):
    """Merge `incoming` into `current` (both {id: answers}); returns (merged, how many were taken)."""
    merged, taken = dict(current), 0
    for item_id, answers in incoming.items():
        # a blank card never replaces an answer, and is not stored: it carries nothing
        if isinstance(answers, dict) and touched(answers) and newer(answers, merged.get(item_id)):
            merged[item_id] = answers
            taken += 1
    return merged, taken


class Store:
    """The results file, safe to use from several request threads."""

    def __init__(self, path, set_id):
        self.path, self.set_id, self.lock = Path(path), set_id, threading.Lock()
        self.results = {}
        if self.path.exists():
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if data.get("setId") != set_id:
                raise SystemExit(f"{self.path} belongs to another set ({data.get('setId')}); move it away first.")
            self.results = data.get("results", {})
            backup = self.path.with_suffix(".json.bak")
            if not backup.exists():
                backup.write_text(self.path.read_text(encoding="utf-8"), encoding="utf-8")

    def snapshot(self):
        with self.lock:
            return {"setId": self.set_id, "results": dict(self.results)}

    def update(self, incoming):
        with self.lock:
            self.results, taken = merge_results(self.results, incoming)
            tmp = self.path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps({"setId": self.set_id, "results": self.results}, ensure_ascii=False, indent=1),
                           encoding="utf-8")
            os.replace(tmp, self.path)  # a crash mid-write must not leave half a file
            return taken, len(self.results)


def make_handler(store, key, page_path):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, status, body, content_type="application/json; charset=utf-8"):
            data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("content-type", content_type)
            self.send_header("content-length", str(len(data)))
            self.send_header("cache-control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _authorized(self):
            given = parse_qs(urlparse(self.path).query).get("key", [""])[0]
            return secrets.compare_digest(given, key)

        def do_GET(self):
            if not self._authorized():
                return self._send(403, {"error": "forbidden"})
            route = urlparse(self.path).path
            if route in ("/", "/review.html"):
                return self._send(200, page_path.read_bytes(), "text/html; charset=utf-8")
            if route == "/results":
                return self._send(200, store.snapshot())
            self._send(404, {"error": "not found"})

        def do_POST(self):
            length = int(self.headers.get("content-length", 0) or 0)
            if length > MAX_BODY:
                self.close_connection = True
                return self._send(413, {"error": "too large"})
            # Read the body before answering anything: replying 403 while the client is still
            # sending makes it see "connection reset" instead of the status.
            raw = self.rfile.read(length)
            if not self._authorized():
                return self._send(403, {"error": "forbidden"})
            if urlparse(self.path).path != "/results":
                return self._send(404, {"error": "not found"})
            try:
                body = json.loads(raw)
                results = body["results"]
                if not isinstance(results, dict):
                    raise ValueError("results must be an object")
            except (ValueError, KeyError) as e:
                return self._send(400, {"error": str(e)})
            if body.get("setId") != store.set_id:
                return self._send(409, {"error": "another set"})
            taken, total = store.update(results)
            self._send(200, {"taken": taken, "total": total})

        def log_message(self, *args):
            pass

    return Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="review", help="folder with items.json and review.html")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--local-only", action="store_true", help="listen on this PC only (for testing)")
    ap.add_argument("--key", help="access key in the link (default: a random one)")
    args = ap.parse_args()

    folder = Path(args.dir)
    set_id = json.loads((folder / "items.json").read_text(encoding="utf-8"))["setId"]
    store = Store(folder / "review_results.json", set_id)
    key = args.key or secrets.token_urlsafe(9)
    host = "127.0.0.1" if args.local_only else "0.0.0.0"
    server = ThreadingHTTPServer((host, args.port), make_handler(store, key, folder / "review.html"))

    shown = "127.0.0.1" if args.local_only else lan_ip()
    print(f"Набор {set_id}: уже отмечено объявлений: {len(store.results)}")
    print(f"\nОткройте на телефоне (та же Wi-Fi сеть) и на ПК:\n\n    http://{shown}:{args.port}/?key={key}\n")
    print("Ответы со всех устройств сохраняются в", folder / "review_results.json")
    print("Остановить: Ctrl+C", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nостановлено")


if __name__ == "__main__":
    main()
