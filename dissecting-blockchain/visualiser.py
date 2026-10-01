"""
Lab visualiser for the peers in this folder.

Start your peers as usual, one terminal each:
    python peer.py -p 8001        (or python pow_peer.py -p 8001)
Then, in another terminal:
    python visualiser.py
and open http://localhost:8000 (in Codespaces it opens for you).

The visualiser finds any peers running on ports 8001-8010, shows their
blockchains and the messages between them, and lets you run the same
commands you would type in a peer's terminal.
"""
import argparse, json, socket

from concurrent.futures import ThreadPoolExecutor
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from xmlrpc.client import Fault, ServerProxy, Transport


WEB_ROOT = Path(__file__).parent / "visualiser_web"


class TimeoutTransport(Transport):
    def __init__(self, timeout):
        super().__init__()
        self.timeout = timeout

    def make_connection(self, host):
        connection = super().make_connection(host)
        connection.timeout = self.timeout
        return connection


def peer_proxy(port, timeout=2.0):
    return ServerProxy(f"http://localhost:{port}", transport=TimeoutTransport(timeout), allow_none=True)


def poll_peer(port, since):
    try:
        return json.loads(peer_proxy(port).vis_snapshot(since))
    except (ConnectionError, OSError) as e:
        if isinstance(e, (socket.timeout, TimeoutError)):
            return {"port": port, "busy": True}
        return None
    except Fault:
        # Something answered but it isn't a peer from this lab (or it's an old copy)
        return {"port": port, "error": "This peer doesn't support the visualiser. Restart it with the latest peer.py."}
    except Exception:
        return None


class Handler(SimpleHTTPRequestHandler):
    ports = []
    pool = None

    def log_message(self, format, *args):
        pass

    def send_json(self, body, status=200):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        url = urlparse(self.path)
        if url.path != "/api/state":
            return super().do_GET()

        # ?since=8001:12,8002:5 -> only send events we haven't seen yet
        since = {}
        for item in parse_qs(url.query).get("since", [""])[0].split(","):
            port, _, last_id = item.partition(":")
            if port.isdigit() and last_id.isdigit():
                since[int(port)] = int(last_id)

        results = self.pool.map(lambda p: poll_peer(p, since.get(p, 0)), self.ports)
        self.send_json({"ports": [self.ports[0], self.ports[-1]], "peers": [r for r in results if r]})

    def do_POST(self):
        if urlparse(self.path).path != "/api/command":
            return self.send_json({"error": "Not found"}, 404)
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            port, line = int(body["port"]), str(body["line"])
        except (ValueError, KeyError, TypeError):
            return self.send_json({"error": "Expected {port, line}"}, 400)
        if port not in self.ports:
            return self.send_json({"error": f"Port {port} is not a lab peer port"}, 400)
        try:
            request = peer_proxy(port).vis_command(line)
        except Exception as e:
            return self.send_json({"error": f"Could not reach peer {port}: {e}"}, 502)
        self.send_json({"request": request})


def parse_ports(text):
    first, _, last = text.partition("-")
    return list(range(int(first), int(last or first) + 1))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Visualise the lab's blockchain peers in the browser")
    parser.add_argument("-p", "--port", type=int, default=8000, help="Port for the visualiser (default 8000)")
    parser.add_argument("--peers", default="8001-8010", help="Port range to look for peers on (default 8001-8010)")
    parser.add_argument("--host", default="127.0.0.1", help="Address to listen on (default 127.0.0.1)")
    args = parser.parse_args()

    Handler.ports = parse_ports(args.peers)
    Handler.pool = ThreadPoolExecutor(max_workers=len(Handler.ports))
    server = ThreadingHTTPServer((args.host, args.port), partial(Handler, directory=str(WEB_ROOT)))
    print(f"Lab visualiser running at http://localhost:{args.port}")
    print(f"Looking for peers on ports {args.peers}. Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()
