/**
 * Access from other devices on the local network (docs/runbooks/lan-https.md):
 *  - every browser-facing URL comes from one LAN_HOST, all of them https:// or wss://, so a page
 *    on the LAN address never loads anything over http/ws;
 *  - the web app reaches the API at the host the page was opened from (followPageHost);
 *  - CORS_ORIGINS accepts localhost, 127.0.0.1 and private-network patterns, never "*";
 *  - the API binds to 0.0.0.0 unless HOST says otherwise.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { insecureUrls, lanEnv, localhostLinkWarning, parseLanHost } from '../../../scripts/lan-config.ts';
import { followPageHost, isLocalHostname } from '../../../packages/shared/src/net/local-url.ts';
import { getCorsOrigins, isOriginAllowed, listenHost, originMatcher } from '../src/common/config.ts';

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

describe('LAN HTTPS settings from one LAN_HOST', () => {
  it('derives every browser-facing URL as https / wss on the proxy ports', () => {
    const env = lanEnv({ host: '192.168.52.124' });
    assert.equal(env.APP_WEB_URL, 'https://192.168.52.124:3443');
    assert.equal(env.NEXT_PUBLIC_API_URL, 'https://192.168.52.124:3444');
    assert.equal(env.NEXT_PUBLIC_LIVEKIT_URL, 'wss://192.168.52.124:7443');
    assert.equal(env.LIVEKIT_URL, 'wss://192.168.52.124:7443', 'the API hands this to browsers in media tokens');
    assert.equal(env.LIVEKIT_HTTP_URL, 'http://127.0.0.1:7880', 'the API itself talks to LiveKit directly');
    assert.equal(env.NEXT_PUBLIC_STORAGE_URL, 'https://192.168.52.124:8443');
    assert.equal(env.S3_PUBLIC_ENDPOINT, env.NEXT_PUBLIC_STORAGE_URL, 'presigned uploads go through the proxy too');
    assert.equal(env.CORS_ORIGINS, 'https://192.168.52.124:3443,https://localhost:3443,https://127.0.0.1:3443');
    assert.equal(env.TRUST_PROXY, 'loopback', 'the proxy runs on this computer');
    assert.equal(env.HOST, '0.0.0.0');
    assert.equal(env.LAN_BIND, '0.0.0.0');
    assert.deepEqual(insecureUrls(env), []);
  });

  it('takes a local hostname and custom ports', () => {
    const env = lanEnv({ host: 'hrvo.local', webPort: 443, apiPort: 4443 });
    assert.equal(env.APP_WEB_URL, 'https://hrvo.local', 'the default port is left out');
    assert.equal(env.NEXT_PUBLIC_API_URL, 'https://hrvo.local:4443');
    assert.equal(env.CORS_ORIGINS, 'https://hrvo.local,https://localhost,https://127.0.0.1');
  });

  it('refuses anything that is not a bare IPv4 address or hostname', () => {
    for (const bad of ['', 'http://192.168.1.2', '192.168.1.2:3443', '999.1.1.1', 'a b', 'host/path', '-bad.local']) {
      assert.throws(() => parseLanHost(bad), /LAN_HOST/, JSON.stringify(bad));
    }
    assert.equal(parseLanHost(' 10.0.0.7 '), '10.0.0.7');
    assert.equal(parseLanHost('Office-PC.lan'), 'office-pc.lan');
  });

  it('names every value that is still http:// or ws://', () => {
    const bad = { ...lanEnv({ host: '10.0.0.7' }), NEXT_PUBLIC_LIVEKIT_URL: 'ws://10.0.0.7:7880', NEXT_PUBLIC_API_URL: 'http://10.0.0.7:3001' };
    assert.deepEqual(insecureUrls(bad).sort(), ['NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_LIVEKIT_URL']);
  });
});

describe('The web app reaches the API at the host the page was opened from', () => {
  it('knows which hostnames are local', () => {
    for (const h of ['localhost', '127.0.0.1', '::1', '[::1]', '10.0.0.7', '172.16.5.5', '172.31.255.1', '192.168.1.20', '169.254.1.1', 'hrvo.local', 'office-pc.lan', 'fe80::1']) {
      assert.equal(isLocalHostname(h), true, h);
    }
    for (const h of ['api.example.com', '8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.1.1', 'example.local.com', '']) {
      assert.equal(isLocalHostname(h), false, h);
    }
  });

  it('swaps localhost for the page host, keeping scheme, port and path', () => {
    assert.equal(followPageHost('http://localhost:3001', { hostname: '192.168.1.20' }), 'http://192.168.1.20:3001');
    assert.equal(followPageHost('ws://localhost:7880', { hostname: '192.168.1.20' }), 'ws://192.168.1.20:7880');
    assert.equal(followPageHost('https://192.168.1.20:3444', { hostname: 'localhost' }), 'https://localhost:3444', 'the HRVO computer opening its own proxy as localhost');
    assert.equal(followPageHost('https://192.168.1.20:3444', { hostname: '127.0.0.1' }), 'https://127.0.0.1:3444');
    assert.equal(followPageHost('http://localhost:3001/api/', { hostname: '10.0.0.7' }), 'http://10.0.0.7:3001/api/');
    assert.equal(followPageHost('http://localhost:3001', { hostname: '[::1]' }), 'http://[::1]:3001');
  });

  it('leaves a public API address alone, and does not follow a page on a public host', () => {
    assert.equal(followPageHost('https://api.example.com', { hostname: '192.168.1.20' }), 'https://api.example.com');
    assert.equal(followPageHost('https://api.example.com', { hostname: 'localhost' }), 'https://api.example.com');
    assert.equal(followPageHost('http://localhost:3001', { hostname: 'app.example.com' }), 'http://localhost:3001', 'a misconfigured public build is not guessed at');
    assert.equal(followPageHost('http://localhost:3001', { hostname: 'localhost' }), 'http://localhost:3001');
    assert.equal(followPageHost('http://localhost:3001', null), 'http://localhost:3001', 'server side: no page');
    assert.equal(followPageHost('not a url', { hostname: '10.0.0.7' }), 'not a url');
  });
});

describe('CORS_ORIGINS for a local network', () => {
  it('outside production, localhost, 127.0.0.1 and private addresses on port 3000 are allowed by default', () => {
    withEnv({ CORS_ORIGINS: undefined, NODE_ENV: 'test' }, () => {
      for (const o of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://192.168.1.20:3000', 'http://10.0.0.7:3000', 'http://172.16.0.9:3000']) {
        assert.equal(isOriginAllowed(o), true, o);
      }
      for (const o of ['http://192.168.1.20:3001', 'http://localhost:4000', 'https://192.168.1.20:3000', 'http://192.168.evil.com:3000', 'http://evil.com', 'http://8.8.8.8:3000']) {
        assert.equal(isOriginAllowed(o), false, o);
      }
      assert.equal(isOriginAllowed(undefined), true, 'no Origin header: not a browser cross-origin request');
    });
  });

  it('a * stands for one host label or the port, never a dot or a slash', () => {
    const m = originMatcher('https://192.168.*.*:3443');
    assert.equal(m('https://192.168.1.20:3443'), true);
    assert.equal(m('https://192.168.255.1:3443'), true);
    assert.equal(m('HTTPS://192.168.1.20:3443'), true, 'scheme and host are case-insensitive');
    assert.equal(m('https://192.168.1.20:3444'), false);
    assert.equal(m('https://192.168.1.20'), false);
    assert.equal(m('https://192.168.evil.com:3443'), false);
    assert.equal(m('https://192.168.1.20:3443/path'), false);
    assert.equal(m('https://192.168.1.20:3443.evil.com'), false);
    const anyPort = originMatcher('https://hrvo.local:*');
    assert.equal(anyPort('https://hrvo.local:3443'), true);
    assert.equal(anyPort('https://hrvo.local:8443'), true);
    assert.equal(anyPort('https://hrvo.local'), false);
    assert.equal(anyPort('https://hrvo.local.evil.com:3443'), false);
    const exact = originMatcher('https://app.example.com');
    assert.equal(exact('https://app.example.com'), true);
    assert.equal(exact('https://app.example.com:443'), false, 'exact means exact');
  });

  it('explicit CORS_ORIGINS mix exact origins and patterns', () => {
    withEnv({ CORS_ORIGINS: 'https://192.168.52.124:3443, https://localhost:3443,https://192.168.*.*:3443', NODE_ENV: 'test' }, () => {
      assert.equal(isOriginAllowed('https://192.168.52.124:3443'), true);
      assert.equal(isOriginAllowed('https://192.168.52.9:3443'), true, 'another device-facing address on the same network');
      assert.equal(isOriginAllowed('https://localhost:3443'), true);
      assert.equal(isOriginAllowed('http://localhost:3000'), false, 'the dev default no longer applies once CORS_ORIGINS is set');
    });
  });

  it('refuses "*", malformed entries, and patterns in production', () => {
    withEnv({ CORS_ORIGINS: '*', NODE_ENV: 'test' }, () => assert.throws(() => getCorsOrigins(), /not allowed/));
    withEnv({ CORS_ORIGINS: 'https://*', NODE_ENV: 'test' }, () => assert.throws(() => getCorsOrigins(), /CORS_ORIGINS/));
    withEnv({ CORS_ORIGINS: 'localhost:3000', NODE_ENV: 'test' }, () => assert.throws(() => getCorsOrigins(), /not an origin/));
    withEnv({ CORS_ORIGINS: 'https://app.example.com/path', NODE_ENV: 'test' }, () => assert.throws(() => getCorsOrigins(), /not an origin/));
    withEnv({ CORS_ORIGINS: 'https://192.168.*.*:3443', NODE_ENV: 'production' }, () => assert.throws(() => getCorsOrigins(), /not allowed in production/));
    withEnv({ CORS_ORIGINS: 'https://app.example.com', NODE_ENV: 'production' }, () => assert.deepEqual(getCorsOrigins(), ['https://app.example.com']));
  });
});

describe('The API listens on every interface unless HOST says otherwise', () => {
  it('defaults to 0.0.0.0', () => {
    withEnv({ HOST: undefined }, () => assert.equal(listenHost(), '0.0.0.0'));
    withEnv({ HOST: '' }, () => assert.equal(listenHost(), '0.0.0.0'));
    withEnv({ HOST: ' 127.0.0.1 ' }, () => assert.equal(listenHost(), '127.0.0.1'));
    withEnv({ HOST: '::' }, () => assert.equal(listenHost(), '::'));
  });
});

describe('E-mailed links and APP_WEB_URL (ADR 039)', () => {
  it('warns when APP_WEB_URL is localhost while other addresses point at the network', () => {
    const w = localhostLinkWarning({ APP_WEB_URL: 'http://localhost:3000', NEXT_PUBLIC_API_URL: 'https://192.168.1.20:3444', NEXT_PUBLIC_STORAGE_URL: 'http://localhost:9000' });
    assert.ok(w);
    assert.match(w, /APP_WEB_URL is http:\/\/localhost:3000, but NEXT_PUBLIC_API_URL points at the network/);
    assert.match(w, /LAN HTTPS address/);
  });
  it('says nothing when everything is local, or when APP_WEB_URL is the LAN or public address', () => {
    assert.equal(localhostLinkWarning({ APP_WEB_URL: 'http://localhost:3000', NEXT_PUBLIC_API_URL: 'http://localhost:3001' }), null);
    assert.equal(localhostLinkWarning({ APP_WEB_URL: 'https://192.168.1.20:3443', NEXT_PUBLIC_API_URL: 'https://192.168.1.20:3444' }), null);
    assert.equal(localhostLinkWarning({ APP_WEB_URL: 'https://hrvo.example.com', NEXT_PUBLIC_API_URL: 'https://api.hrvo.example.com' }), null);
  });
  it('the generated LAN settings never trigger it', () => {
    assert.equal(localhostLinkWarning(lanEnv({ host: '192.168.1.20' })), null);
  });
});

