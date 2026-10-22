/**
 * A local OpenID Connect provider standing in for Google in tests (FR-AUTH-005; ADR 037): the
 * same endpoints HRVO calls, a signing key published as a JWKS, and a tiny sign-in page for the
 * browser tests. Test only: never deployed, never trusted outside NODE_ENV=test/development.
 *
 *   /auth?...            the "Google" sign-in page: a form (e-mail, name, verified?) that sends
 *                        the browser back to redirect_uri with code and state (or ?error=...)
 *   /token               checks the code, the PKCE verifier (S256), client id and secret;
 *                        answers with a signed ID token
 *   /certs               the JWKS
 *   /.well-known/openid-configuration
 *   /issue (POST, JSON)  test helper: mint a code without the page (API tests)
 */
import http from 'node:http';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';

export interface FakeAccount { email: string; sub?: string; name?: string; emailVerified?: boolean }
export interface CodeOptions extends FakeAccount {
  challenge: string;
  nonce: string;
  /** Deliberately broken ID tokens, for the negative tests. */
  badSignature?: boolean;
  expired?: boolean;
  wrongAudience?: boolean;
  wrongNonce?: boolean;
}

export class FakeGoogle {
  readonly keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  readonly otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  readonly kid = 'fake-google-key-1';
  private readonly codes = new Map<string, CodeOptions>();
  tokenCalls = 0;
  server: http.Server | null = null;

  readonly port: number;
  readonly clientId: string;
  readonly clientSecret: string;

  // No parameter properties: this file also runs under Node's strip-only TypeScript mode.
  constructor(port: number, clientId: string, clientSecret: string) {
    this.port = port;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  get issuer(): string { return `http://localhost:${this.port}`; }

  /** The environment the API needs to talk to this fake instead of Google. */
  env(apiBase: string): Record<string, string> {
    return {
      GOOGLE_CLIENT_ID: this.clientId,
      GOOGLE_CLIENT_SECRET: this.clientSecret,
      GOOGLE_REDIRECT_URI: `${apiBase}/auth/google/callback`,
      GOOGLE_OAUTH_AUTH_URL: `${this.issuer}/auth`,
      GOOGLE_OAUTH_TOKEN_URL: `${this.issuer}/token`,
      GOOGLE_OIDC_JWKS_URL: `${this.issuer}/certs`,
      GOOGLE_OIDC_ISSUER: this.issuer,
    };
  }

  issueCode(c: CodeOptions): string {
    const code = randomBytes(12).toString('hex');
    this.codes.set(code, c);
    return code;
  }

  private idToken(entry: CodeOptions): string {
    return jwt.sign(
      { sub: entry.sub ?? `sub-${createHash('sha1').update(entry.email.toLowerCase()).digest('hex').slice(0, 12)}`, email: entry.email, email_verified: entry.emailVerified ?? true, name: entry.name ?? entry.email.split('@')[0], nonce: entry.wrongNonce ? 'another-nonce' : entry.nonce },
      entry.badSignature ? this.otherKeys.privateKey : this.keys.privateKey,
      { algorithm: 'RS256', keyid: this.kid, issuer: this.issuer, audience: entry.wrongAudience ? 'someone-else' : this.clientId, expiresIn: entry.expired ? -60 : 300 },
    );
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', this.issuer);
      const json = (status: number, body: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
      if (url.pathname === '/.well-known/openid-configuration') {
        json(200, { issuer: this.issuer, authorization_endpoint: `${this.issuer}/auth`, token_endpoint: `${this.issuer}/token`, jwks_uri: `${this.issuer}/certs`, scopes_supported: ['openid', 'email', 'profile'], code_challenge_methods_supported: ['S256'] });
        return;
      }
      if (url.pathname === '/certs') {
        const jwk = this.keys.publicKey.export({ format: 'jwk' }) as Record<string, string>;
        json(200, { keys: [{ ...jwk, kid: this.kid, alg: 'RS256', use: 'sig' }] });
        return;
      }
      if (url.pathname === '/auth') {
        // The sign-in page. Query: the usual OIDC parameters from the API.
        const p = url.searchParams;
        if (p.get('client_id') !== this.clientId || p.get('code_challenge_method') !== 'S256' || !p.get('state') || !p.get('nonce') || !p.get('redirect_uri')) {
          res.writeHead(400, { 'Content-Type': 'text/plain' }).end('invalid_request');
          return;
        }
        const hidden = ['redirect_uri', 'state', 'nonce', 'code_challenge'].map((k) => `<input type="hidden" name="${k}" value="${p.get(k) ?? ''}">`).join('');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><html><head><title>Fake Google sign-in</title></head><body>
<h1>Fake Google</h1><p>Test provider: no real Google account is involved.</p>
<form method="GET" action="/auth/submit">${hidden}
<label>Email <input name="email" type="email" required></label><br>
<label>Name <input name="name"></label><br>
<label><input name="verified" type="checkbox" value="1" checked> Email verified</label><br>
<button type="submit">Sign in</button> <button type="submit" name="deny" value="1">Cancel</button>
</form></body></html>`);
        return;
      }
      if (url.pathname === '/auth/submit') {
        const p = url.searchParams;
        const back = new URL(p.get('redirect_uri') ?? '');
        back.searchParams.set('state', p.get('state') ?? '');
        if (p.get('deny')) back.searchParams.set('error', 'access_denied');
        else back.searchParams.set('code', this.issueCode({ challenge: p.get('code_challenge') ?? '', nonce: p.get('nonce') ?? '', email: p.get('email') ?? '', name: p.get('name') || undefined, emailVerified: p.get('verified') === '1' }));
        res.writeHead(302, { Location: back.toString() }).end();
        return;
      }
      if (url.pathname === '/issue' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => json(200, { code: this.issueCode(JSON.parse(body) as CodeOptions) }));
        return;
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          this.tokenCalls += 1;
          const p = new URLSearchParams(body);
          const entry = this.codes.get(p.get('code') ?? '');
          const challenge = createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url');
          if (!entry || p.get('grant_type') !== 'authorization_code' || p.get('client_id') !== this.clientId || p.get('client_secret') !== this.clientSecret || challenge !== entry.challenge) {
            json(400, { error: 'invalid_grant' });
            return;
          }
          this.codes.delete(p.get('code')!); // a code works once
          json(200, { access_token: 'ya29.fake', id_token: this.idToken(entry), token_type: 'Bearer', expires_in: 3600 });
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => this.server!.listen(this.port, '127.0.0.1', r));
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
