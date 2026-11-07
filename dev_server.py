"""
Local Development Server for Zapfy PWA.
Serves static files directly from the project root using Python's built-in http.server.
Displays both localhost and LAN IP so you can test and install the PWA on your phone in your Wi-Fi.
"""

import http.server
import os
import socket
import sys
from pathlib import Path

PORT = 8080
DIRECTORY = Path(__file__).resolve().parent


def get_local_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIRECTORY), **kwargs)

    def end_headers(self):
        # Enable CORS and disable cache during local development
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    os.chdir(str(DIRECTORY))
    lan_ip = get_local_ip()

    print("=" * 60)
    print(" ⛽ Zapfy PWA Local Dev Server")
    print("=" * 60)
    print(f" • PC Browser:   http://localhost:{PORT}")
    print(f" • Handy (WLAN): http://{lan_ip}:{PORT}")
    print("=" * 60)
    print(" Drücke Strg+C zum Beenden.")

    http.server.ThreadingHTTPServer.allow_reuse_address = True
    with http.server.ThreadingHTTPServer(("", PORT), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer beendet.")


if __name__ == "__main__":
    main()
