/**
 * Dev SMTP transport (Mailhog) used for FR-AUTH-008 reset links: protocol, dot-stuffing,
 * header-injection rejection and transport selection.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileMailTransport, InMemoryMailTransport, ResendMailTransport, SmtpMailTransport, createMailTransport } from '../src/common/mailer.ts';
import { appWebUrl, renderActionEmail } from '../src/common/email-layout.ts';

/** Minimal SMTP server: records commands and the DATA payload. */
function fakeSmtpServer() {
  const received: { commands: string[]; data: string } = { commands: [], data: '' };
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    sock.write('220 fake.smtp ready\r\n');
    let inData = false;
    let buf = '';
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            sock.write('250 queued\r\n');
          } else {
            received.data += `${line}\n`;
          }
          continue;
        }
        received.commands.push(line);
        if (line.startsWith('EHLO')) sock.write('250-fake.smtp\r\n250 OK\r\n');
        else if (line === 'DATA') { inData = true; sock.write('354 go ahead\r\n'); }
        else if (line === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 OK\r\n');
      }
    });
  });
  return { server, received };
}

describe('SMTP mail transport (dev / Mailhog)', () => {
  const { server, received } = fakeSmtpServer();
  let port: number;

  before(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  it('speaks SMTP, handles multi-line EHLO replies and dot-stuffs the body', async () => {
    const t = new SmtpMailTransport('127.0.0.1', port, 'no-reply@hrvo.local');
    await t.send({ to: 'user@example.test', subject: 'Reset', text: 'line one\n.starts with dot\nend' });
    assert.deepEqual(received.commands, [
      'EHLO hrvo.local',
      'MAIL FROM:<no-reply@hrvo.local>',
      'RCPT TO:<user@example.test>',
      'DATA',
      'QUIT',
    ]);
    assert.match(received.data, /^Subject: Reset$/m);
    assert.match(received.data, /^To: <user@example.test>$/m);
    assert.match(received.data, /^\.\.starts with dot$/m);
  });

  it('rejects CR/LF in recipient or subject (header injection)', async () => {
    const t = new SmtpMailTransport('127.0.0.1', port, 'no-reply@hrvo.local');
    await assert.rejects(t.send({ to: 'a@b.test\r\nBcc: x@y.test', subject: 's', text: 't' }), /line breaks/);
    await assert.rejects(t.send({ to: 'a@b.test', subject: 's\nBcc: x@y.test', text: 't' }), /line breaks/);
  });

  it('fails cleanly when the server is unreachable', async () => {
    const t = new SmtpMailTransport('127.0.0.1', 1, 'no-reply@hrvo.local');
    await assert.rejects(t.send({ to: 'a@b.test', subject: 's', text: 't' }));
  });

  it('createMailTransport selects memory or smtp and rejects unknown modes', () => {
    const saved = process.env.MAIL_TRANSPORT;
    try {
      process.env.MAIL_TRANSPORT = 'memory';
      assert.ok(createMailTransport() instanceof InMemoryMailTransport);
      process.env.MAIL_TRANSPORT = 'smtp';
      assert.ok(createMailTransport() instanceof SmtpMailTransport);
      process.env.MAIL_TRANSPORT = 'carrier-pigeon';
      assert.throws(() => createMailTransport(), /Unknown MAIL_TRANSPORT/);
    } finally {
      if (saved === undefined) delete process.env.MAIL_TRANSPORT;
      else process.env.MAIL_TRANSPORT = saved;
    }
  });
});

/** Throwaway self-signed certificate for 127.0.0.1 (the client trusts it through `ca`). */
function selfSignedCert(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'hrvo-smtp-tls-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
    return { key: readFileSync(join(dir, 'key.pem'), 'utf8'), cert: readFileSync(join(dir, 'cert.pem'), 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * SMTP submission server (port 587 style): offers STARTTLS, and AUTH PLAIN only after TLS.
 * Each command is recorded with whether it arrived over TLS.
 */
function fakeSubmissionServer(tlsCert: { key: string; cert: string }, opts: { offerStartTls?: boolean; acceptLogin?: boolean } = {}) {
  const { offerStartTls = true, acceptLogin = true } = opts;
  const received: { commands: Array<{ line: string; secure: boolean }>; data: string } = { commands: [], data: '' };
  const server = net.createServer((raw) => {
    let sock: net.Socket = raw;
    let secure = false;
    let inData = false;
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === '.') { inData = false; sock.write('250 queued\r\n'); } else received.data += `${line}\n`;
          continue;
        }
        received.commands.push({ line, secure });
        if (line.startsWith('EHLO')) {
          const caps = secure ? ['AUTH LOGIN PLAIN'] : offerStartTls ? ['STARTTLS'] : [];
          sock.write(['fake.smtp', ...caps, 'OK'].map((c, i, all) => `250${i === all.length - 1 ? ' ' : '-'}${c}\r\n`).join(''));
        } else if (line === 'STARTTLS' && offerStartTls && !secure) {
          sock.write('220 go ahead\r\n');
          sock.removeListener('data', onData);
          const upgraded = new tls.TLSSocket(sock, { isServer: true, key: tlsCert.key, cert: tlsCert.cert });
          upgraded.on('error', () => undefined);
          upgraded.on('data', onData);
          sock = upgraded;
          secure = true;
        } else if (line.startsWith('AUTH ')) {
          sock.write(secure && acceptLogin ? '235 accepted\r\n' : '535 5.7.8 credentials rejected\r\n');
        } else if (line === 'DATA') { inData = true; sock.write('354 go ahead\r\n'); }
        else if (line === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 OK\r\n');
      }
    };
    raw.on('error', () => undefined);
    raw.on('data', onData);
    raw.write('220 fake.smtp ready\r\n');
  });
  return { server, received };
}

describe('SMTP submission with STARTTLS and AUTH (Gmail and other providers; ADR 043)', () => {
  const cert = selfSignedCert();
  const auth = { user: 'sender@example.test', password: 'app password value' };
  const listen = async (s: net.Server) => {
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    return (s.address() as AddressInfo).port;
  };
  const close = (s: net.Server) => new Promise<void>((r) => s.close(() => r()));

  it('upgrades with STARTTLS, says EHLO again, logs in over TLS only, then sends', async () => {
    const { server, received } = fakeSubmissionServer(cert);
    const port = await listen(server);
    try {
      await new SmtpMailTransport('127.0.0.1', port, 'sender@example.test', { auth, ca: cert.cert }).send({ to: 'user@example.test', subject: 'Verify', text: 'hello' });
      const plainB64 = Buffer.from(`\0${auth.user}\0${auth.password}`, 'utf8').toString('base64');
      assert.deepEqual(received.commands, [
        { line: 'EHLO hrvo.local', secure: false },
        { line: 'STARTTLS', secure: false },
        { line: 'EHLO hrvo.local', secure: true },
        { line: `AUTH PLAIN ${plainB64}`, secure: true },
        { line: 'MAIL FROM:<sender@example.test>', secure: true },
        { line: 'RCPT TO:<user@example.test>', secure: true },
        { line: 'DATA', secure: true },
        { line: 'QUIT', secure: true },
      ]);
      assert.match(received.data, /^Subject: Verify$/m);
    } finally {
      await close(server);
    }
  });

  it('never sends credentials in plaintext: a server without STARTTLS is refused before AUTH', async () => {
    const { server, received } = fakeSubmissionServer(cert, { offerStartTls: false });
    const port = await listen(server);
    try {
      await assert.rejects(
        new SmtpMailTransport('127.0.0.1', port, 'sender@example.test', { auth, ca: cert.cert }).send({ to: 'u@example.test', subject: 's', text: 't' }),
        /STARTTLS/,
      );
      assert.ok(!received.commands.some((c) => c.line.startsWith('AUTH') || c.line.startsWith('MAIL')), 'no AUTH or MAIL after a refused upgrade');
    } finally {
      await close(server);
    }
  });

  it('verifies the server certificate: an untrusted certificate fails and no credentials are sent', async () => {
    const { server, received } = fakeSubmissionServer(cert);
    const port = await listen(server);
    try {
      await assert.rejects(new SmtpMailTransport('127.0.0.1', port, 'sender@example.test', { auth }).send({ to: 'u@example.test', subject: 's', text: 't' }));
      assert.ok(!received.commands.some((c) => c.line.startsWith('AUTH')), 'AUTH never reached the server');
    } finally {
      await close(server);
    }
  });

  it('a refused login reports the reply code only, never the credentials', async () => {
    const { server } = fakeSubmissionServer(cert, { acceptLogin: false });
    const port = await listen(server);
    try {
      await assert.rejects(
        new SmtpMailTransport('127.0.0.1', port, 'sender@example.test', { auth, ca: cert.cert }).send({ to: 'u@example.test', subject: 's', text: 't' }),
        (err: Error) => /SMTP login refused \(reply 535\)/.test(err.message) && !err.message.includes(auth.password) && !err.message.includes(auth.user),
      );
    } finally {
      await close(server);
    }
  });

  it('createMailTransport: SMTP_USER and SMTP_PASSWORD go together; with both, smtp logs in', () => {
    const dev = { NODE_ENV: 'development', MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587' };
    assert.throws(() => createMailTransport({ ...dev, SMTP_USER: 'a@b.test' }), /SMTP_USER and SMTP_PASSWORD/);
    assert.throws(() => createMailTransport({ ...dev, SMTP_PASSWORD: 'x' }), /SMTP_USER and SMTP_PASSWORD/);
    const t = createMailTransport({ ...dev, SMTP_USER: 'a@b.test', SMTP_PASSWORD: 'x', MAIL_FROM: 'a@b.test' });
    assert.ok(t instanceof SmtpMailTransport);
    assert.equal(t.authenticated, true);
    assert.equal((createMailTransport(dev) as SmtpMailTransport).authenticated, false, 'Mailhog: no login');
  });

  it('certificate checks cannot be switched off from the environment (NODE_TLS_REJECT_UNAUTHORIZED=0)', async () => {
    const { server, received } = fakeSubmissionServer(cert);
    const port = await listen(server);
    const saved = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    const savedWarn = process.emitWarning;
    process.emitWarning = () => undefined; // Node warns once when the variable is read
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      await assert.rejects(new SmtpMailTransport('127.0.0.1', port, 'sender@example.test', { auth }).send({ to: 'u@example.test', subject: 's', text: 't' }));
      assert.ok(!received.commands.some((c) => c.line.startsWith('AUTH')), 'AUTH never reached the untrusted server');
    } finally {
      if (saved === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = saved;
      process.emitWarning = savedWarn;
      await close(server);
    }
  });
});

describe('SMTP in production: authenticated submission only (ADR 046)', () => {
  const ok = {
    NODE_ENV: 'production', MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '587',
    SMTP_USER: 'sender@example.test', SMTP_PASSWORD: 'app password value', MAIL_FROM: 'sender@example.test',
  };
  const without = (k: keyof typeof ok) => { const e: Record<string, string> = { ...ok }; delete e[k]; return e; };

  it('accepts a login on port 587 with a sender: STARTTLS and certificate checks are then mandatory', () => {
    const t = createMailTransport(ok);
    assert.ok(t instanceof SmtpMailTransport);
    assert.equal(t.authenticated, true);
    assert.equal(t.trustsExtraCa, false, 'production never adds a CA to the system trust store');
    const defaultPort = createMailTransport(without('SMTP_PORT'));
    assert.ok(defaultPort instanceof SmtpMailTransport && defaultPort.port === 587, 'unset port means 587 (submission)');
  });

  it('refuses an unauthenticated (plaintext, Mailhog-style) transport', () => {
    assert.throws(() => createMailTransport(without('SMTP_USER')), /needs SMTP_USER and SMTP_PASSWORD/);
    assert.throws(() => createMailTransport(without('SMTP_PASSWORD')), /needs SMTP_USER and SMTP_PASSWORD/);
    assert.throws(() => createMailTransport({ ...ok, SMTP_USER: '', SMTP_PASSWORD: '' }), /needs SMTP_USER and SMTP_PASSWORD/);
  });

  it('refuses a missing, local or IP-literal server (certificates are issued to public host names)', () => {
    assert.throws(() => createMailTransport(without('SMTP_HOST')), /SMTP_HOST/);
    for (const host of ['localhost', 'mailhog', '127.0.0.1', '10.0.0.5', '::1', 'smtp.local']) {
      assert.throws(() => createMailTransport({ ...ok, SMTP_HOST: host }), /SMTP_HOST/, host);
    }
  });

  it('refuses ports other than 587: 25 (relay, optional TLS), 465 (implicit TLS, not supported), others', () => {
    for (const port of ['25', '465', '1025', '2525', 'abc', '0']) {
      assert.throws(() => createMailTransport({ ...ok, SMTP_PORT: port }), /SMTP_PORT/, port);
    }
  });

  it('needs a plain sender address: no default sender, no display name, no line breaks', () => {
    assert.throws(() => createMailTransport(without('MAIL_FROM')), /MAIL_FROM/);
    for (const from of ['HR <sender@example.test>', 'not-an-address', 'a@b', 'sender@example.test\r\nBcc: x@y.test', 'a b@example.test']) {
      assert.throws(() => createMailTransport({ ...ok, MAIL_FROM: from }), /MAIL_FROM/, JSON.stringify(from));
    }
    const legacy = createMailTransport({ ...without('MAIL_FROM'), SMTP_FROM: 'sender@example.test' });
    assert.ok(legacy instanceof SmtpMailTransport, 'SMTP_FROM still works as the sender');
  });

  it('refuses to start when certificate checks are disabled process-wide', () => {
    assert.throws(() => createMailTransport({ ...ok, NODE_TLS_REJECT_UNAUTHORIZED: '0' }), /NODE_TLS_REJECT_UNAUTHORIZED/);
  });

  it('errors never contain the password or the login', () => {
    for (const bad of [without('SMTP_HOST'), { ...ok, SMTP_PORT: '25' }, { ...ok, MAIL_FROM: 'x' }, without('SMTP_USER')]) {
      try { createMailTransport(bad); assert.fail('should throw'); } catch (e) {
        const m = (e as Error).message;
        assert.ok(!m.includes(ok.SMTP_PASSWORD) && !m.includes('sender@example.test'), m);
      }
    }
  });

  it('development is unchanged: Mailhog without a login on localhost:1025', () => {
    const t = createMailTransport({ NODE_ENV: 'development', MAIL_TRANSPORT: 'smtp' });
    assert.ok(t instanceof SmtpMailTransport && !t.authenticated && t.port === 1025);
  });
});

describe('Account e-mails: layout and transports (ADR 039)', () => {
  const email = renderActionEmail({
    subject: 'Confirm <you>', intro: 'Welcome & hello', paragraphs: ['Then sign in.'], buttonLabel: 'Confirm e-mail and sign in',
    url: 'https://hrvo.example.test/verify-email#token=abc"def', footer: ['Expires in 24 hours.'],
  });

  it('has one button and the same link as plain text, in both the HTML and the text part; HTML is escaped', () => {
    assert.match(email.text, /^Confirm e-mail and sign in: https:\/\/hrvo\.example\.test\/verify-email#token=abc"def$/m);
    assert.match(email.text, /copy the whole address/);
    const hrefs = [...email.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(hrefs, ['https://hrvo.example.test/verify-email#token=abc&quot;def', 'https://hrvo.example.test/verify-email#token=abc&quot;def'], 'button and plain link');
    assert.match(email.html, /data-testid="email-action"[^>]*>Confirm e-mail and sign in<\/a>/);
    assert.match(email.html, /Welcome &amp; hello/);
    assert.match(email.html, /<title>Confirm &lt;you&gt;<\/title>/);
    assert.doesNotMatch(email.html, /<you>/);
  });

  it('links are built from APP_WEB_URL (no trailing slash), localhost only as the default', () => {
    assert.equal(appWebUrl({ APP_WEB_URL: 'https://192.168.1.20:3443/' }), 'https://192.168.1.20:3443');
    assert.equal(appWebUrl({}), 'http://localhost:3000');
  });

  it('SMTP sends text and HTML as multipart/alternative', async () => {
    const { server, received } = fakeSmtpServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      await new SmtpMailTransport('127.0.0.1', (server.address() as AddressInfo).port, 'no-reply@hrvo.local').send({ to: 'a@b.test', ...email });
      assert.match(received.data, /Content-Type: multipart\/alternative; boundary="hrvo-alt-/);
      assert.match(received.data, /Content-Type: text\/plain; charset=utf-8\n\nWelcome & hello/);
      const b64 = /Content-Type: text\/html; charset=utf-8\nContent-Transfer-Encoding: base64\n\n([A-Za-z0-9+/=\n]+)\n--/.exec(received.data)?.[1];
      assert.ok(b64, 'an HTML part');
      assert.match(Buffer.from(b64.replace(/\n/g, ''), 'base64').toString('utf8'), /data-testid="email-action"/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('the file transport writes one JSON message per e-mail (browser tests read it)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hrvo-mail-'));
    try {
      await new FileMailTransport(dir).send({ to: 'a@b.test', ...email });
      const files = readdirSync(dir);
      assert.equal(files.length, 1);
      const saved = JSON.parse(readFileSync(join(dir, files[0]!), 'utf8')) as { to: string; html: string; text: string };
      assert.equal(saved.to, 'a@b.test');
      assert.equal(saved.html, email.html);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Resend: posts text and HTML with the API key as a bearer token; a refusal reports only the status', async () => {
    const seen: Array<{ auth: string | undefined; body: Record<string, unknown> }> = [];
    let status = 200;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { seen.push({ auth: req.headers.authorization, body: JSON.parse(body) as Record<string, unknown> }); res.writeHead(status, { 'Content-Type': 'application/json' }).end('{"id":"x","echo":"secret body"}'); });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/emails`;
      const t = new ResendMailTransport('re_test_key', 'HRVO <no-reply@hrvo.example.test>', endpoint);
      await t.send({ to: 'a@b.test', ...email });
      assert.equal(seen[0]!.auth, 'Bearer re_test_key');
      assert.deepEqual(seen[0]!.body.to, ['a@b.test']);
      assert.equal(seen[0]!.body.from, 'HRVO <no-reply@hrvo.example.test>');
      assert.equal(seen[0]!.body.html, email.html);
      assert.equal(seen[0]!.body.text, email.text);
      status = 422;
      await assert.rejects(t.send({ to: 'a@b.test', ...email }), (err: Error) => err.message === 'Resend refused the message (HTTP 422)');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('production delivers for real: memory, file and smtp are refused; resend needs its key and sender', () => {
    const prod = { NODE_ENV: 'production' };
    assert.throws(() => createMailTransport({ ...prod, MAIL_TRANSPORT: 'memory' }), /delivers nothing/);
    assert.throws(() => createMailTransport({ ...prod, MAIL_TRANSPORT: 'file', MAIL_FILE_DIR: '/tmp/x' }), /delivers nothing/);
    assert.throws(() => createMailTransport({ ...prod, MAIL_TRANSPORT: 'smtp' }), /needs SMTP_USER and SMTP_PASSWORD/);
    assert.throws(() => createMailTransport({ ...prod, MAIL_TRANSPORT: 'resend', MAIL_FROM: 'a@b.test' }), /RESEND_API_KEY/);
    assert.throws(() => createMailTransport({ ...prod, MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 'k' }), /MAIL_FROM/);
    assert.ok(createMailTransport({ ...prod, MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 'k', MAIL_FROM: 'a@b.test' }) instanceof ResendMailTransport);
  });

  it('outside tests, a transport that delivers nothing says so at start', () => {
    const warn = console.warn;
    const lines: string[] = [];
    console.warn = (l: unknown) => { lines.push(String(l)); };
    try {
      createMailTransport({ NODE_ENV: 'development', MAIL_TRANSPORT: 'memory' });
      createMailTransport({ NODE_ENV: 'test', MAIL_TRANSPORT: 'memory' });
    } finally {
      console.warn = warn;
    }
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /never delivered/);
  });
});

