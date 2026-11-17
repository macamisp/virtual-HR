#!/usr/bin/env python3
"""HRVO self-hosted LiveKit: network and TLS verification (ADR 067; docs/runbooks/livekit-selfhost.md).

Standard library only. Run it from OUTSIDE the server (a workstation) to see what the Internet sees:

  python3 check.py --livekit livekit.virtual-hr.site --turn livekit-turn.virtual-hr.site --expect-ip <EIP>
  python3 check.py ... --secrets secrets.env      # adds an authenticated API call (ListRooms)

Checks: DNS points straight at the media host (not proxied), TLS certificates for both names, the
signalling endpoint and its WebSocket path, TURN/TLS, TURN/UDP (STUN binding), ICE/TCP, and that
the internal ports are closed. Secrets are read from the file and never printed.
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
import socket
import ssl
import struct
import sys
import time
import urllib.error
import urllib.request

RESULTS = []


def record(name, ok, detail=''):
    RESULTS.append((name, ok, detail))
    mark = 'PASS' if ok else ('WARN' if ok is None else 'FAIL')
    print(f'[{mark}] {name}{": " + detail if detail else ""}', flush=True)


def tls_context(cafile):
    ctx = ssl.create_default_context(cafile=cafile) if cafile else ssl.create_default_context()
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    return ctx


def connect_addr(host, port, args):
    """Where to connect: --connect overrides DNS (local rehearsals); SNI stays the real name."""
    return (args.connect or host, port)


def check_dns(args):
    for name in (args.livekit, args.turn):
        try:
            ips = sorted({ai[4][0] for ai in socket.getaddrinfo(name, None, socket.AF_INET)})
        except socket.gaierror as e:
            record(f'DNS {name}', False, f'does not resolve ({e})')
            continue
        if args.expect_ip:
            record(f'DNS {name}', ips == [args.expect_ip], f'{", ".join(ips)} (expected {args.expect_ip}; a Cloudflare address means the record is proxied: set it to DNS only)')
        else:
            record(f'DNS {name}', None, f'{", ".join(ips)} (pass --expect-ip to compare)')


def check_tls(name, port, args):
    try:
        with socket.create_connection(connect_addr(name, port, args), timeout=8) as raw:
            with tls_context(args.cafile).wrap_socket(raw, server_hostname=name) as s:
                cert = s.getpeercert()
                left = (ssl.cert_time_to_seconds(cert['notAfter']) - time.time()) / 86400
                record(f'TLS {name}:{port}', left >= args.min_days, f'{s.version()}, certificate valid for the name, expires in {left:.0f} days')
                return True
    except (OSError, ssl.SSLError) as e:
        record(f'TLS {name}:{port}', False, str(e))
        return False


def https_get(url, args, headers=None, data=None):
    host = url.split('/')[2].split(':')[0]
    ctx = tls_context(args.cafile)
    req = urllib.request.Request(url, headers=headers or {}, data=data, method='POST' if data is not None else 'GET')
    if args.connect:
        # Keep the name for SNI and Host, but dial the given address.
        class Conn(urllib.request.HTTPSHandler):
            def https_open(self, r):
                import http.client

                class C(http.client.HTTPSConnection):
                    def connect(self_inner):
                        sock = socket.create_connection((args.connect, self_inner.port), timeout=8)
                        self_inner.sock = ctx.wrap_socket(sock, server_hostname=host)
                return self.do_open(C, r, context=ctx)
        opener = urllib.request.build_opener(Conn())
    else:
        opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx))
    try:
        with opener.open(req, timeout=10) as res:
            return res.status, res.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')


def check_signal(args):
    base = f'https://{args.livekit}:{args.tls_port}'
    try:
        status, body = https_get(f'{base}/', args)
        record('Signalling GET /', status == 200 and body.strip() == 'OK', f'HTTP {status} {body.strip()[:20]!r}')
    except OSError as e:
        record('Signalling GET /', False, str(e))
    try:
        # WebSocket upgrade without a token, sent raw (urllib rewrites the Connection header): LiveKit
        # answers 401, which proves the upgrade path reaches it through the TLS front.
        key = base64.b64encode(os.urandom(16)).decode()
        with socket.create_connection(connect_addr(args.livekit, args.tls_port, args), timeout=8) as raw:
            with tls_context(args.cafile).wrap_socket(raw, server_hostname=args.livekit) as s:
                s.sendall((f'GET /rtc HTTP/1.1\r\nHost: {args.livekit}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n'
                           f'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {key}\r\n\r\n').encode())
                status_line = s.recv(256).decode('latin-1').split('\r\n', 1)[0]
        status = int(status_line.split(' ')[1]) if status_line.startswith('HTTP/') else 0
        record('Signalling /rtc reaches LiveKit', status == 401, f'{status_line} without a token (expected 401)')
    except (OSError, ssl.SSLError, ValueError, IndexError) as e:
        record('Signalling /rtc reaches LiveKit', False, str(e))


def b64url(b):
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode()


def read_keys(path):
    with open(path, encoding='utf-8') as f:
        for line in f:
            if line.startswith('LIVEKIT_KEYS='):
                key, _, secret = line.strip()[len('LIVEKIT_KEYS='):].partition(': ')
                return key, secret
    raise SystemExit(f'{path} has no LIVEKIT_KEYS line')


def check_api(args):
    key, secret = read_keys(args.secrets)
    now = int(time.time())
    header = b64url(json.dumps({'alg': 'HS256', 'typ': 'JWT'}).encode())
    payload = b64url(json.dumps({'iss': key, 'nbf': now - 5, 'exp': now + 60, 'sub': 'hrvo-check', 'video': {'roomList': True}}).encode())
    sig = b64url(hmac.new(secret.encode(), f'{header}.{payload}'.encode(), hashlib.sha256).digest())
    del secret
    try:
        status, body = https_get(f'https://{args.livekit}:{args.tls_port}/twirp/livekit.RoomService/ListRooms', args,
                                 headers={'Authorization': f'Bearer {header}.{payload}.{sig}', 'Content-Type': 'application/json'}, data=b'{}')
        rooms = len(json.loads(body).get('rooms', [])) if status == 200 else None
        record('API ListRooms with the production key', status == 200, f'HTTP {status}' + (f', {rooms} active room(s)' if rooms is not None else ''))
    except (OSError, ValueError) as e:
        record('API ListRooms with the production key', False, str(e))


def stun_request():
    txid = os.urandom(12)
    return txid, struct.pack('!HHI', 0x0001, 0, 0x2112A442) + txid


def stun_answer(data, txid):
    """(ok, mapped address) for a STUN Binding success response."""
    ok = len(data) >= 20 and struct.unpack('!H', data[:2])[0] == 0x0101 and data[8:20] == txid
    mapped = ''
    i = 20
    while ok and i + 4 <= len(data):
        t, ln = struct.unpack('!HH', data[i:i + 4])
        if t == 0x0020 and ln >= 8:
            xport = struct.unpack('!H', data[i + 6:i + 8])[0] ^ 0x2112
            xip = struct.unpack('!I', data[i + 8:i + 12])[0] ^ 0x2112A442
            mapped = f'{socket.inet_ntoa(struct.pack("!I", xip))}:{xport}'
        i += 4 + ln + ((4 - ln % 4) % 4)
    return ok, mapped


def check_turn_tls(args):
    """A STUN Binding over TLS to the TURN name proves the SNI route reaches LiveKit's TURN server."""
    txid, req = stun_request()
    try:
        with socket.create_connection(connect_addr(args.turn, args.tls_port, args), timeout=8) as raw:
            with tls_context(args.cafile).wrap_socket(raw, server_hostname=args.turn) as s:
                s.sendall(req)
                ok, mapped = stun_answer(s.recv(2048), txid)
        record(f'TURN/TLS {args.turn}:{args.tls_port} answers STUN', ok, f'mapped address {mapped}' if mapped else 'no STUN answer')
    except (OSError, ssl.SSLError) as e:
        record(f'TURN/TLS {args.turn}:{args.tls_port} answers STUN', False, str(e))


def check_stun(args):
    host, port = (args.connect or args.turn), args.turn_udp_port
    txid, req = stun_request()
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(3)
    try:
        for _ in range(3):
            s.sendto(req, (host, port))
            try:
                data, _ = s.recvfrom(2048)
            except socket.timeout:
                continue
            ok, mapped = stun_answer(data, txid)
            record(f'TURN/UDP {port} (STUN binding)', ok, f'mapped address {mapped}' if mapped else 'answered')
            return
        record(f'TURN/UDP {port} (STUN binding)', False, 'no answer (UDP blocked by the security group or host firewall?)')
    finally:
        s.close()


def check_tcp(name, host, port, should_be_open):
    try:
        with socket.create_connection((host, port), timeout=4):
            is_open = True
    except OSError:
        is_open = False
    record(f'{name} TCP {port} {"open" if should_be_open else "closed to this network"}', is_open == should_be_open,
           'reachable' if is_open else 'not reachable')


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--livekit', required=True, help='signalling domain, e.g. livekit.virtual-hr.site')
    p.add_argument('--turn', required=True, help='TURN domain, e.g. livekit-turn.virtual-hr.site')
    p.add_argument('--expect-ip', help='the media host public IP both names must resolve to')
    p.add_argument('--connect', help='dial this address instead of DNS (local rehearsal); SNI keeps the names')
    p.add_argument('--cafile', help='CA bundle (local rehearsal with an internal CA)')
    p.add_argument('--secrets', help='secrets.env for an authenticated ListRooms call (values never printed)')
    p.add_argument('--tls-port', type=int, default=443)
    p.add_argument('--turn-udp-port', type=int, default=3478)
    p.add_argument('--ice-tcp-port', type=int, default=7881)
    p.add_argument('--closed', default='7880,6389,5349', help='ports that must NOT be reachable from here')
    p.add_argument('--closed-host', help='address to probe the closed ports on (default: the signalling host)')
    p.add_argument('--min-days', type=float, default=14, help='minimum days of certificate validity left')
    p.add_argument('--skip-dns', action='store_true')
    args = p.parse_args()

    target = args.connect or args.livekit
    if not args.skip_dns:
        check_dns(args)
    check_tls(args.livekit, args.tls_port, args)
    check_tls(args.turn, args.tls_port, args)
    check_signal(args)
    if args.secrets:
        check_api(args)
    check_turn_tls(args)
    check_stun(args)
    check_tcp('ICE', target, args.ice_tcp_port, True)
    for port in [int(x) for x in args.closed.split(',') if x]:
        check_tcp('Internal', args.closed_host or target, port, False)

    failed = [r for r in RESULTS if r[1] is False]
    print(f'\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed' + (f'; FAILED: {", ".join(r[0] for r in failed)}' if failed else ''))
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
