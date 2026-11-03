"""A stand-in for the EC2 instance metadata service, for imds-guard-netns.sh only.

IMDSv2-shaped: PUT /latest/api/token returns a token; /latest/meta-data/iam/info answers 200 when
the file named by the first argument exists (an instance profile is "attached"), else 404.
Every other GET answers 200. Listens on all IPv4 and IPv6 addresses, port 80.
"""
import http.server
import os
import socket
import sys

ROLE_FLAG = sys.argv[1]


class Handler(http.server.BaseHTTPRequestHandler):
    def reply(self, code, body=b"ok"):
        self.send_response(code)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_PUT(self):
        self.reply(200 if self.path == "/latest/api/token" else 404, b"test-token")

    def do_GET(self):
        if self.path == "/latest/meta-data/iam/info":
            self.reply(200 if os.path.exists(ROLE_FLAG) else 404)
        else:
            self.reply(200)

    def log_message(self, *args):
        pass


class DualStack(http.server.ThreadingHTTPServer):
    address_family = socket.AF_INET6

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


DualStack(("::", 80), Handler).serve_forever()
