#!/usr/bin/env python3
"""Tiny static server for local viewing. Usage: python3 serve.py [port]"""
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8010


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), partial(Handler, directory=ROOT))
    print(f"XRP dashboard at http://localhost:{PORT}")
    server.serve_forever()
