#!/usr/bin/env python3
"""Point the HRVO API at a LiveKit server (ADR 067; docs/runbooks/livekit-selfhost.md §6).

Edits only the LiveKit lines of the API's env file (e.g. /opt/virtual-hr/app/.env.staging); every
other line stays byte-identical. A mode-600 backup is written first. Values are never printed.

  to-selfhost  LIVEKIT_URL/KEY/SECRET := the self-hosted server (key pair from its secrets.env);
               the old values become LIVEKIT_PREVIOUS_API_KEY/SECRET (webhooks from calls still on
               the old server keep verifying) and LIVEKIT_EXTRA_URLS (the web CSP keeps allowing it).
  drop-previous  after the old server has no rooms left: remove LIVEKIT_PREVIOUS_API_KEY/SECRET.
  restore BACKUP rollback: put a backup written by this script back in place (itself backed up).

Then recreate only the API: `$C up -d --no-deps api` (the web build already allows both URLs when
it was built with LIVEKIT_EXTRA_URLS; see the runbook).
"""
import argparse
import os
import re
import shutil
import stat
import sys
import time

LINE = re.compile(r'^([A-Z0-9_]+)=(.*)$')


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
    os.replace(tmp, path)


def backup(path):
    dest = f'{path}.livekit-backup-{time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())}'
    shutil.copy2(path, dest)
    os.chmod(dest, 0o600)
    return dest


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
    sub = p.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('to-selfhost')
    s.add_argument('--secrets', required=True, help='the self-hosted server secrets.env')
    s.add_argument('--url', required=True, help='wss://livekit.virtual-hr.site')
    sub.add_parser('drop-previous')
    r = sub.add_parser('restore')
    r.add_argument('backup')
    a = p.parse_args()

    lines, values = read_env(a.env)
    if a.cmd == 'restore':
        if not os.path.basename(a.backup).startswith(os.path.basename(a.env) + '.livekit-backup-'):
            sys.exit('restore takes a backup written by this script')
        saved = backup(a.env)
        shutil.copy2(a.backup, a.env)
        os.chmod(a.env, 0o600)
        print(f'restored {a.env} from {a.backup} (the replaced file is kept as {saved})')
        return

    if a.cmd == 'drop-previous':
        if 'LIVEKIT_PREVIOUS_API_KEY' not in values and 'LIVEKIT_PREVIOUS_API_SECRET' not in values:
            sys.exit('no previous key pair configured')
        saved = backup(a.env)
        write_env(a.env, lines, {}, removals=('LIVEKIT_PREVIOUS_API_KEY', 'LIVEKIT_PREVIOUS_API_SECRET'))
        print(f'removed LIVEKIT_PREVIOUS_API_KEY, LIVEKIT_PREVIOUS_API_SECRET (backup {saved})')
        return

    if not re.match(r'^wss://[A-Za-z0-9.-]+(:\d+)?$', a.url):
        sys.exit('--url must be wss://<host>[:port]')
    for n in ('LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'):
        if not values.get(n):
            sys.exit(f'{a.env} has no {n}; nothing to switch from')
    if values['LIVEKIT_URL'] == a.url:
        sys.exit(f'LIVEKIT_URL already points at {a.url}')
    key, secret = read_selfhost_keys(a.secrets)
    if key == values['LIVEKIT_API_KEY']:
        sys.exit('the self-hosted key name equals the current one; generate a new pair')
    saved = backup(a.env)
    updates = {
        'LIVEKIT_URL': a.url,
        'LIVEKIT_API_KEY': key,
        'LIVEKIT_API_SECRET': secret,
        'LIVEKIT_PREVIOUS_API_KEY': values['LIVEKIT_API_KEY'],
        'LIVEKIT_PREVIOUS_API_SECRET': values['LIVEKIT_API_SECRET'],
        'LIVEKIT_EXTRA_URLS': values['LIVEKIT_URL'],
    }
    # The API derives the Twirp address from LIVEKIT_URL; a leftover LIVEKIT_HTTP_URL would still
    # name the old server.
    removals = ('LIVEKIT_HTTP_URL',) if 'LIVEKIT_HTTP_URL' in values else ()
    write_env(a.env, lines, updates, removals)
    del secret
    print('updated ' + ', '.join(updates) + (', removed LIVEKIT_HTTP_URL' if removals else '') + f' in {a.env} (backup {saved}; values not shown)')


if __name__ == '__main__':
    main()
