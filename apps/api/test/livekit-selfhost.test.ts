/**
 * Self-hosted LiveKit switch-over (ADR 067).
 *  - Webhooks verify against the current key pair and, during a switch-over, the previous one, so a
 *    call still running on the old media server can close its participants (FR-MEET-004/005).
 *  - Access tokens and API calls always use the current pair only.
 *  - The web CSP lists every LiveKit endpoint a token may name, so switching servers (or rolling
 *    back) changes only the API's environment, not the web build.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { accessToken, liveKitConfig, signWebhook, verifyWebhook, webhookSigner } from '../src/media/livekit.ts';
import type { LiveKitConfig } from '../src/media/livekit.ts';
import { liveKitConnectSources, parseLiveKitUrlList } from '../../../packages/shared/src/net/livekit-urls.ts';

const current: LiveKitConfig = { url: 'wss://livekit.example.test', httpUrl: 'https://livekit.example.test', apiKey: 'APInew', apiSecret: 'n'.repeat(48) };
const previous = { apiKey: 'APIold', apiSecret: 'o'.repeat(48) };
const body = JSON.stringify({ event: 'participant_left', room: { name: 'r' } });

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('LiveKit webhooks across a server switch (ADR 067)', () => {
  it('accepts a webhook signed with the current pair and names it', () => {
    const auth = signWebhook(current, body);
    assert.equal(webhookSigner({ ...current, previous }, auth, Buffer.from(body)), 'current');
    assert.equal(verifyWebhook({ ...current, previous }, auth, Buffer.from(body)), true);
  });

  it('accepts a webhook from the previous server only while the previous pair is configured', () => {
    const auth = signWebhook({ ...current, ...previous }, body);
    assert.equal(webhookSigner({ ...current, previous }, auth, Buffer.from(body)), 'previous');
    assert.equal(verifyWebhook({ ...current, previous }, auth, Buffer.from(body)), true);
    assert.equal(webhookSigner(current, auth, Buffer.from(body)), null, 'refused once the previous pair is removed');
  });

  it('refuses a mixed pair: the previous secret with the current key name, and a tampered body', () => {
    const mixed = signWebhook({ ...current, apiSecret: previous.apiSecret }, body);
    assert.equal(webhookSigner({ ...current, previous }, mixed, Buffer.from(body)), null);
    const good = signWebhook({ ...current, ...previous }, body);
    assert.equal(webhookSigner({ ...current, previous }, good, Buffer.from(`${body} `)), null);
    assert.equal(webhookSigner({ ...current, previous }, undefined, Buffer.from(body)), null);
  });

  it('signs participant tokens with the current pair only', () => {
    const { token } = accessToken({ ...current, previous }, 'u1', 'U', { room: 'r', roomJoin: true });
    const claims = jwt.verify(token, current.apiSecret, { algorithms: ['HS256'], issuer: current.apiKey }) as { sub: string };
    assert.equal(claims.sub, 'u1');
    assert.throws(() => jwt.verify(token, previous.apiSecret, { algorithms: ['HS256'] }));
  });
});

describe('LiveKit configuration from the environment (ADR 067)', () => {
  const base = { LIVEKIT_URL: current.url, LIVEKIT_API_KEY: current.apiKey, LIVEKIT_API_SECRET: current.apiSecret, LIVEKIT_HTTP_URL: undefined };

  it('has no previous pair unless both its key and secret are set', () => {
    withEnv({ ...base, LIVEKIT_PREVIOUS_API_KEY: undefined, LIVEKIT_PREVIOUS_API_SECRET: undefined }, () => {
      assert.equal(liveKitConfig().previous, undefined);
    });
    withEnv({ ...base, LIVEKIT_PREVIOUS_API_KEY: previous.apiKey, LIVEKIT_PREVIOUS_API_SECRET: previous.apiSecret }, () => {
      assert.deepEqual(liveKitConfig().previous, previous);
    });
  });

  it('refuses half a previous pair, and in production a short or reused previous secret', () => {
    withEnv({ ...base, LIVEKIT_PREVIOUS_API_KEY: previous.apiKey, LIVEKIT_PREVIOUS_API_SECRET: undefined }, () => {
      assert.throws(() => liveKitConfig(), /LIVEKIT_PREVIOUS_API_KEY and LIVEKIT_PREVIOUS_API_SECRET/);
    });
    withEnv({ ...base, NODE_ENV: 'production', LIVEKIT_PREVIOUS_API_KEY: previous.apiKey, LIVEKIT_PREVIOUS_API_SECRET: 'short' }, () => {
      assert.throws(() => liveKitConfig(), /at least 32 characters/);
    });
    withEnv({ ...base, NODE_ENV: 'production', LIVEKIT_PREVIOUS_API_KEY: current.apiKey, LIVEKIT_PREVIOUS_API_SECRET: previous.apiSecret }, () => {
      assert.throws(() => liveKitConfig(), /must differ/);
    });
  });

  it('derives the HTTP address from the signalling URL unless LIVEKIT_HTTP_URL is set', () => {
    withEnv(base, () => assert.equal(liveKitConfig().httpUrl, 'https://livekit.example.test'));
  });
});

describe('LiveKit endpoints the browser may connect to (ADR 067)', () => {
  it('parses a comma or space separated list, keeps only ws/wss URLs, and drops trailing slashes', () => {
    assert.deepEqual(parseLiveKitUrlList(' wss://a.example.test/, wss://b.example.test  ws://localhost:7880,https://x.test,,javascript:alert(1)'), [
      'wss://a.example.test', 'wss://b.example.test', 'ws://localhost:7880',
    ]);
    assert.deepEqual(parseLiveKitUrlList(undefined), []);
  });

  it('lists the primary and every extra endpoint in both ws and http forms, once each', () => {
    assert.deepEqual(liveKitConnectSources('wss://livekit.example.test', ['wss://p.livekit.cloud', 'wss://livekit.example.test/']), [
      'wss://livekit.example.test', 'https://livekit.example.test', 'wss://p.livekit.cloud', 'https://p.livekit.cloud',
    ]);
  });
});
