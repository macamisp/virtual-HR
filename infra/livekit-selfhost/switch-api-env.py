#!/usr/bin/env python3
"""Point the HRVO API at a LiveKit server (ADR 067; docs/runbooks/livekit-selfhost.md §6-7).

Edits only the LiveKit lines of the API's env file (/opt/virtual-hr/app/.env.staging); every other
line stays byte-identical. Values are never printed. Before every change a backup is written to a
dedicated root-only directory OUTSIDE the application checkout (default /var/backups/hrvo-livekit-env,
mode 700): created atomically, never overwritten, never deleted by this script, named
  <env file>.<UTC time to the microsecond>.before-<command>.bak

  to-selfhost  LIVEKIT_URL/KEY/SECRET := the self-hosted server (key pair from its secrets.env);
               the old values become LIVEKIT_PREVIOUS_API_KEY/SECRET (webhooks from calls still on
               the old server keep verifying) and LIVEKIT_EXTRA_URLS (the web CSP keeps allowing it).
  to-cloud     ROLLBACK, the mirror image: LiveKit Cloud current again (from the previous pair; once
               that was dropped, from the newest before-to-selfhost backup, or --cloud-from BACKUP);
               the self-hosted pair becomes the previous one, so rooms still running there can close
               (participant_left, meeting attendance) instead of leaving people BUSY for 12 h.
               Run it BEFORE rolling back application images (the old web image does not allow the
               self-hosted server), and keep the self-hosted stack and its secrets.env until drained.
  drop-previous  remove LIVEKIT_PREVIOUS_API_KEY/SECRET once the previous server has no rooms left:
               asks that server (ListRooms) and refuses while rooms remain or it cannot tell;
               --confirm-no-rooms only when the operator has confirmed it otherwise (server gone).
  list-backups   the backups of this env file (names, times, commands; no values).
  restore BACKUP last resort: put a backup back byte for byte. It forgets the server being left, so
               its webhooks are refused: prefer to-cloud.

Then recreate only the API, always through prod-compose.sh (keeps the Supabase overlay):
  /opt/hrvo-livekit/prod-compose.sh up -d --no-deps api
"""
import argparse
import base64
import datetime
import hashlib
import hmac
import json
import os
import re
import stat
import sys
import time
import urllib.error
import urllib.request

LINE = re.compile(r'^([A-Z0-9_]+)=(.*)$')
# LiveKit Cloud project URLs; anything else is the self-hosted server. Keeps each command's direction
# explicit (a second to-cloud would otherwise "go back" to the self-hosted pair kept as previous).
CLOUD_URL = re.compile(r'^wss://[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.livekit\.cloud(:\d+)?$')
DEFAULT_BACKUP_DIR = '/var/backups/hrvo-livekit-env'
OPS = ('to-selfhost', 'to-cloud', 'drop-previous', 'restore')


def read_env(path):
    with open(path, encoding='utf-8') as f:
        lines = f.read().split('\n')
    values = {}
    for line in lines:
        m = LINE.match(line)
        if m:
            values[m.group(1)] = m.group(2)
    return lines, values


def write_env(path, lines, updates, removals=()):
    seen = set()
    out = []
    for line in lines:
        m = LINE.match(line)
        name = m.group(1) if m else None
        if name in removals:
            continue
        if name in updates:
            if name in seen:
                continue  # a duplicate definition: keep the first, updated
            out.append(f'{name}={updates[name]}')
            seen.add(name)
        else:
            out.append(line)
    missing = [n for n in updates if n not in seen]
    if missing:
        if out and out[-1] == '':
            out.pop()
        out.append('# ---- LiveKit switch-over (ADR 067) ----')
        out.extend(f'{n}={updates[n]}' for n in missing)
        out.append('')
    tmp = f'{path}.tmp-{os.getpid()}'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write('\n'.join(out))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


# --- backups: outside the checkout, private, atomic, never overwritten ---------------------------

def inside_git_checkout(path):
    d = os.path.realpath(path)
    while True:
        if os.path.lexists(os.path.join(d, '.git')):
            return True
        up = os.path.dirname(d)
        if up == d:
            return False
        d = up


def backup_dir(path, env_path):
    """The backup directory, created 0700 if missing; refused unless private and outside any checkout."""
    # Where it is first (nothing is created in a refused place), then what it is.
    real = os.path.realpath(path)
    app = os.path.dirname(os.path.realpath(env_path))
    if real == app or real.startswith(app + os.sep) or inside_git_checkout(real):
        sys.exit(f'{path} is inside the application directory or a git checkout: backups hold every production secret')
    if not os.path.lexists(path):
        os.makedirs(path, mode=0o700)
    st = os.lstat(path)
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
        sys.exit(f'{path} must be a real directory (not a link)')
    if st.st_uid != os.geteuid():
        sys.exit(f'{path} must be owned by the user running this (root on the host)')
    if stat.S_IMODE(st.st_mode) & 0o077:
        sys.exit(f'{path} must not be accessible by group or others (mode {oct(stat.S_IMODE(st.st_mode))})')
    return os.path.realpath(path)


def backup_name_re(env_path):
    return re.compile(re.escape(os.path.basename(env_path)) + r'\.(\d{8}T\d{6}\.\d{6}Z)(?:-\d+)?\.before-(' + '|'.join(OPS) + r')\.bak$')


def backup(env_path, bdir, op):
    """Write a new backup atomically: an exclusive temp file, fsync, then link() into its final name,
    which fails rather than overwrite. Returns the path."""
    with open(env_path, 'rb') as src:
        data = src.read()
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    base = os.path.basename(env_path)
    tmp = os.path.join(bdir, f'.{base}.{stamp}.{os.getpid()}.tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        for n in range(1000):
            dest = os.path.join(bdir, f'{base}.{stamp}{"" if n == 0 else f"-{n}"}.before-{op}.bak')
            try:
                os.link(tmp, dest)
            except FileExistsError:
                continue
            dfd = os.open(bdir, os.O_RDONLY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
            return dest
        sys.exit('could not find a free backup name')
    finally:
        os.unlink(tmp)


def list_backups(env_path, bdir):
    pat = backup_name_re(env_path)
    found = []
    for name in os.listdir(bdir):
        m = pat.match(name)
        if m:
            found.append((name, m.group(1), m.group(2)))
    return sorted(found)


def checked_backup(path, env_path, bdir):
    """A backup given on the command line: it must be one of ours, in the backup directory, private."""
    real = os.path.realpath(path)
    if os.path.dirname(real) != bdir or not backup_name_re(env_path).match(os.path.basename(real)):
        sys.exit(f'{path} is not a backup of {os.path.basename(env_path)} in {bdir} (see list-backups)')
    st = os.lstat(real)
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or stat.S_IMODE(st.st_mode) & 0o077:
        sys.exit(f'{path} must be a private regular file owned by this user')
    return real


# --- the previous server: are its rooms drained? ------------------------------------------------

def b64url(b):
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode()


def active_rooms(url, key, secret):
    """Number of rooms on the LiveKit server at `url` (ws/wss) asked with its key pair, or None when
    it cannot be asked."""
    http = re.sub(r'^ws', 'http', url.rstrip('/'))
    if not re.match(r'^https?://[A-Za-z0-9.-]+(:\d+)?$', http):
        return None
    now = int(time.time())
    header = b64url(json.dumps({'alg': 'HS256', 'typ': 'JWT'}).encode())
    payload = b64url(json.dumps({'iss': key, 'nbf': now - 5, 'exp': now + 60, 'sub': 'hrvo-switch', 'video': {'roomList': True}}).encode())
    sig = b64url(hmac.new(secret.encode(), f'{header}.{payload}'.encode(), hashlib.sha256).digest())
    req = urllib.request.Request(f'{http}/twirp/livekit.RoomService/ListRooms', data=b'{}', method='POST',
                                 headers={'Authorization': f'Bearer {header}.{payload}.{sig}', 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return len(json.loads(res.read().decode('utf-8')).get('rooms') or [])
    except (urllib.error.URLError, OSError, ValueError):
        return None


def read_selfhost_keys(path):
    mode = stat.S_IMODE(os.stat(path).st_mode)
    if mode & 0o077:
        sys.exit(f'{path} must not be readable by group or others (mode {oct(mode)})')
    with open(path, encoding='utf-8') as f:
        for line in f:
            m = re.match(r'^LIVEKIT_KEYS=([A-Za-z0-9_-]+): (\S{32,})$', line.strip())
            if m:
                return m.group(1), m.group(2)
    sys.exit(f'{path}: no LIVEKIT_KEYS line with a secret of at least 32 characters')


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--env', required=True, help="the API's env file, e.g. /opt/virtual-hr/app/.env.staging")
    p.add_argument('--backup-dir', default=DEFAULT_BACKUP_DIR, help=f'where backups go (default {DEFAULT_BACKUP_DIR})')
    sub = p.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('to-selfhost')
    s.add_argument('--secrets', required=True, help='the self-hosted server secrets.env')
    s.add_argument('--url', required=True, help='wss://livekit.virtual-hr.site')
    c = sub.add_parser('to-cloud')
    c.add_argument('--cloud-from', help='a before-to-selfhost backup (default: the newest one, once the previous pair was dropped)')
    d = sub.add_parser('drop-previous')
    d.add_argument('--confirm-no-rooms', action='store_true', help='the previous server cannot be asked and the operator confirmed it has no rooms')
    sub.add_parser('list-backups')
    r = sub.add_parser('restore')
    r.add_argument('backup')
    a = p.parse_args()

    bdir = backup_dir(a.backup_dir, a.env)
    lines, values = read_env(a.env)

    if a.cmd == 'list-backups':
        for name, when, op in list_backups(a.env, bdir):
            print(f'{when}  before-{op:<14} {os.path.join(bdir, name)}')
        return

    if a.cmd == 'restore':
        src = checked_backup(a.backup, a.env, bdir)
        saved = backup(a.env, bdir, 'restore')
        with open(src, 'rb') as f:
            data = f.read()
        tmp = f'{a.env}.tmp-{os.getpid()}'
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, a.env)
        print(f'restored {a.env} from {src} (the replaced file is kept as {saved})')
        return

    if a.cmd == 'drop-previous':
        key, secret = values.get('LIVEKIT_PREVIOUS_API_KEY', ''), values.get('LIVEKIT_PREVIOUS_API_SECRET', '')
        if not key and not secret:
            sys.exit('no previous key pair configured')
        extra = [u.strip() for u in values.get('LIVEKIT_EXTRA_URLS', '').split(',') if u.strip()]
        rooms = active_rooms(extra[0], key, secret) if len(extra) == 1 else None
        if rooms is None and not a.confirm_no_rooms:
            sys.exit('cannot ask the previous server for its rooms (LIVEKIT_EXTRA_URLS unreachable or unclear): '
                     'keep the previous pair, or pass --confirm-no-rooms once you have confirmed it has none')
        if rooms:
            sys.exit(f'the previous server still has {rooms} active room(s): keep the previous pair until they end')
        saved = backup(a.env, bdir, 'drop-previous')
        write_env(a.env, lines, {}, removals=('LIVEKIT_PREVIOUS_API_KEY', 'LIVEKIT_PREVIOUS_API_SECRET'))
        state = 'no active rooms' if rooms == 0 else 'confirmed by the operator'
        print(f'removed LIVEKIT_PREVIOUS_API_KEY, LIVEKIT_PREVIOUS_API_SECRET ({state}; backup {saved})')
        return

    for n in ('LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'):
        if not values.get(n):
            sys.exit(f'{a.env} has no {n}; nothing to switch from')

    if a.cmd == 'to-selfhost':
        if CLOUD_URL.match(a.url):
            sys.exit('to-selfhost takes the self-hosted URL, not a LiveKit Cloud one')
        key, secret = read_selfhost_keys(a.secrets)
        switch(a.env, bdir, lines, values, a.url, key, secret, 'to-selfhost', 'self-hosted')
        return

    # to-cloud: the Cloud values from the previous pair (+ LIVEKIT_EXTRA_URLS), else from a backup.
    if CLOUD_URL.match(values['LIVEKIT_URL']):
        sys.exit('LIVEKIT_URL is already LiveKit Cloud: nothing to roll back')
    extra = values.get('LIVEKIT_EXTRA_URLS', '').split(',')
    url = extra[0].strip() if len(extra) == 1 else ''
    key, secret = values.get('LIVEKIT_PREVIOUS_API_KEY', ''), values.get('LIVEKIT_PREVIOUS_API_SECRET', '')
    source = 'the previous key pair'
    if a.cloud_from or not (url and key and secret):
        if a.cloud_from:
            src = checked_backup(a.cloud_from, a.env, bdir)
        else:
            candidates = [n for n, _, op in list_backups(a.env, bdir) if op == 'to-selfhost']
            if not candidates:
                sys.exit(f'no LiveKit Cloud values to go back to: no previous pair and no before-to-selfhost backup in {bdir}')
            src = os.path.join(bdir, candidates[-1])
        _, old = read_env(src)
        url, key, secret = old.get('LIVEKIT_URL', ''), old.get('LIVEKIT_API_KEY', ''), old.get('LIVEKIT_API_SECRET', '')
        source = src
        if not (url and key and secret):
            sys.exit(f'{src} holds no complete LiveKit pair')
    if not CLOUD_URL.match(url):
        sys.exit(f'the values to go back to ({source}) are not a LiveKit Cloud URL: refusing')
    switch(a.env, bdir, lines, values, url, key, secret, 'to-cloud', f'LiveKit Cloud (from {source})')


def switch(path, bdir, lines, values, url, key, secret, op, label):
    """Make (url, key, secret) current and keep the current server as the previous one."""
    if not re.match(r'^wss://[A-Za-z0-9.-]+(:\d+)?$', url):
        sys.exit('the target URL must be wss://<host>[:port]')
    if len(secret) < 32:
        sys.exit('the target secret must be at least 32 characters')
    if values['LIVEKIT_URL'] == url:
        sys.exit(f'LIVEKIT_URL already points at {url}')
    if key == values['LIVEKIT_API_KEY']:
        sys.exit('the target key name equals the current one; each server needs its own pair')
    saved = backup(path, bdir, op)
    updates = {
        'LIVEKIT_URL': url,
        'LIVEKIT_API_KEY': key,
        'LIVEKIT_API_SECRET': secret,
        # Rooms still running on the server being left keep sending webhooks: verify them.
        'LIVEKIT_PREVIOUS_API_KEY': values['LIVEKIT_API_KEY'],
        'LIVEKIT_PREVIOUS_API_SECRET': values['LIVEKIT_API_SECRET'],
        # The web build's CSP must allow both (it does when built with this value).
        'LIVEKIT_EXTRA_URLS': values['LIVEKIT_URL'],
    }
    # The API derives the Twirp address from LIVEKIT_URL; a leftover LIVEKIT_HTTP_URL would still
    # name the old server.
    removals = ('LIVEKIT_HTTP_URL',) if 'LIVEKIT_HTTP_URL' in values else ()
    write_env(path, lines, updates, removals)
    print(f'switched to {label}: updated ' + ', '.join(updates) + (', removed LIVEKIT_HTTP_URL' if removals else '')
          + f' in {path} (backup {saved}; values not shown)')


if __name__ == '__main__':
    main()
