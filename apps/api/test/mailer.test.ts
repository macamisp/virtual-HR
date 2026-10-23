/**
 * Dev SMTP transport (Mailhog) used for FR-AUTH-008 reset links: protocol, dot-stuffing,
 * header-injection rejection and transport selection.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
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
    assert.throws(() => createMailTransport({ ...prod, MAIL_TRANSPORT: 'smtp' }), /plaintext dev transport/);
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

