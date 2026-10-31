/**
 * Transactional email (FR-AUTH-001/008, FR-NOTIF-002, FR-MEET-003): dev SMTP,
 * memory, Resend requests and safe failures. Resend is always mocked; no real mail is sent.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { InMemoryMailTransport, ResendMailTransport, SmtpMailTransport, createMailTransport } from '../src/common/mailer.ts';
import type { MailMessage } from '../src/common/mailer.ts';

function withEnv(values: Record<string, string | undefined>, fn: () => void): void {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

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

  it('preserves text calendar attachments as multipart MIME', async () => {
    received.data = '';
    const content = 'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR';
    await new SmtpMailTransport('127.0.0.1', port, 'no-reply@hrvo.local').send({
      to: 'user@example.test', subject: 'Meeting', text: 'Join us',
      attachments: [{ filename: 'invite.ics', contentType: 'text/calendar; method=REQUEST', content }],
    });
    assert.match(received.data, /Content-Type: multipart\/mixed/);
    assert.match(received.data, /Content-Type: text\/calendar; method=REQUEST/);
    assert.match(received.data, /filename="invite.ics"/);
    assert.ok(received.data.includes(Buffer.from(content).toString('base64')));
  });

  it('fails cleanly when the server is unreachable', async () => {
    const t = new SmtpMailTransport('127.0.0.1', 1, 'no-reply@hrvo.local');
    await assert.rejects(t.send({ to: 'a@b.test', subject: 's', text: 't' }));
  });

  it('createMailTransport selects memory or smtp and rejects unknown modes', () => {
    withEnv({ NODE_ENV: 'test', MAIL_TRANSPORT: 'memory' }, () => assert.ok(createMailTransport() instanceof InMemoryMailTransport));
    withEnv({ NODE_ENV: 'test', MAIL_TRANSPORT: 'smtp' }, () => assert.ok(createMailTransport() instanceof SmtpMailTransport));
    withEnv({ NODE_ENV: 'test', MAIL_TRANSPORT: 'carrier-pigeon' }, () => assert.throws(() => createMailTransport(), /Unknown MAIL_TRANSPORT/));
  });
});

describe('Resend mail transport', () => {
  const message: MailMessage = {
    to: 'person@example.test', subject: 'Reset your password',
    text: 'https://app.example.test/reset-password#token=unit-test-token',
  };
  const create = () => new ResendMailTransport('unit-test-api-key', 'HRVO <no-reply@example.test>');

  it('sends the existing message over HTTPS with a timeout and no redirect following', async (t) => {
    const request = t.mock.method(globalThis, 'fetch', async (_url: string, _init: RequestInit) =>
      Response.json({ id: 'test-email-id' }));
    const timeout = t.mock.method(AbortSignal, 'timeout', AbortSignal.timeout);
    await create().send(message);
    assert.equal(request.mock.callCount(), 1);
    const [url, init] = request.mock.calls[0].arguments;
    assert.ok(init);
    assert.equal(url, 'https://api.resend.com/emails');
    assert.equal(init.method, 'POST');
    assert.deepEqual(init.headers, { Authorization: 'Bearer unit-test-api-key', 'Content-Type': 'application/json' });
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(timeout.mock.calls[0].arguments[0], 10_000);
    assert.deepEqual(JSON.parse(String(init.body)), { from: 'HRVO <no-reply@example.test>', to: [message.to], subject: message.subject, text: message.text });
  });

  it('preserves UTF-8 text attachments, filenames and calendar MIME parameters', async (t) => {
    const request = t.mock.method(globalThis, 'fetch', async (_url: string, _init: RequestInit) => Response.json({ id: 'test-id' }));
    const attachments = [
      { filename: 'invite.ics', contentType: 'text/calendar; method=REQUEST', content: 'BEGIN:VCALENDAR\r\nSUMMARY:Réunion\r\nEND:VCALENDAR' },
      { filename: 'notes.txt', contentType: 'text/plain', content: 'Meeting notes: ✓' },
    ];
    await create().send({ ...message, attachments });
    const init = request.mock.calls[0].arguments[1];
    assert.ok(init);
    assert.deepEqual(JSON.parse(String(init.body)).attachments, attachments.map((a) => ({
      filename: a.filename, content_type: a.contentType, content: Buffer.from(a.content, 'utf8').toString('base64'),
    })));
  });

  for (const status of [401, 403, 422, 429, 500]) {
    it(`sanitizes HTTP ${status} failures and makes no retry`, async (t) => {
      const request = t.mock.method(globalThis, 'fetch', async () => new Response(
        `Provider echoed unit-test-api-key and ${message.text}`, { status },
      ));
      await assert.rejects(create().send(message), { message: `Resend delivery failed (HTTP ${status})` });
      assert.equal(request.mock.callCount(), 1);
    });
  }

  it('sanitizes network errors without retaining a sensitive cause or retrying', async (t) => {
    const request = t.mock.method(globalThis, 'fetch', async () => { throw new Error(`unit-test-api-key ${message.text}`); });
    await assert.rejects(create().send(message), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'Resend request failed');
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(request.mock.callCount(), 1);
  });

  it('aborts a pending request at the deadline without retrying', async (t) => {
    const controller = new AbortController();
    t.mock.method(AbortSignal, 'timeout', () => controller.signal);
    const request = t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('sensitive fetch details')), { once: true });
    }));
    const sending = create().send(message);
    controller.abort();
    await assert.rejects(sending, { message: 'Resend request timed out' });
    assert.equal(request.mock.callCount(), 1);
  });

  for (const body of ['not JSON', '{}', '{"id":""}', '{"error":"sensitive provider details"}']) {
    it(`rejects an invalid success response (${body.slice(0, 12)})`, async (t) => {
      t.mock.method(globalThis, 'fetch', async () => new Response(body));
      await assert.rejects(create().send(message), { message: 'Resend returned an invalid response' });
    });
  }

  it('rejects header injection before calling the provider', async (t) => {
    const request = t.mock.method(globalThis, 'fetch', async () => Response.json({ id: 'unused' }));
    for (const invalid of [
      { ...message, to: 'a@example.test\r\nBcc: b@example.test' },
      { ...message, subject: 's\nBcc: b@example.test' },
      { ...message, attachments: [{ filename: 'invite.ics\r\nBad: header', contentType: 'text/calendar', content: '' }] },
      { ...message, attachments: [{ filename: 'invite.ics', contentType: 'text/calendar\nBad: header', content: '' }] },
    ]) await assert.rejects(create().send(invalid), /line breaks/);
    assert.equal(request.mock.callCount(), 0);
  });

  it('requires Resend configuration without falling back to another transport', () => {
    withEnv({ NODE_ENV: 'production', MAIL_TRANSPORT: 'resend', RESEND_API_KEY: undefined, RESEND_FROM: undefined }, () => {
      assert.throws(() => createMailTransport(), /RESEND_API_KEY is required/);
      process.env.RESEND_API_KEY = 'unit-test-api-key';
      assert.throws(() => createMailTransport(), /RESEND_FROM is required/);
      process.env.RESEND_FROM = 'HRVO <no-reply@example.test>';
      assert.ok(createMailTransport() instanceof ResendMailTransport);
    });
    assert.throws(() => new ResendMailTransport('   ', 'a@example.test'), /RESEND_API_KEY is required/);
    assert.throws(() => new ResendMailTransport('bad\nkey', 'a@example.test'), /RESEND_API_KEY must not contain whitespace/);
    assert.throws(() => new ResendMailTransport('unit-test-key', '   '), /RESEND_FROM is required/);
    assert.throws(() => new ResendMailTransport('unit-test-key', 'invalid-address'), /RESEND_FROM must be an email/);
    assert.throws(() => new ResendMailTransport('unit-test-key', 'a@example.test\r\nBcc: b@example.test'), /line breaks/);
    assert.ok(new ResendMailTransport('unit-test-key', 'a@example.test'));
  });

  it('refuses implicit SMTP, explicit SMTP and memory in production', () => {
    for (const mode of [undefined, 'smtp', 'memory', 'unknown']) {
      withEnv({ NODE_ENV: 'production', MAIL_TRANSPORT: mode }, () => assert.throws(() => createMailTransport()));
    }
  });

  it('keeps memory delivery and its attachments available for tests', async () => {
    const mail = { ...message, attachments: [{ filename: 'invite.ics', contentType: 'text/calendar; method=REQUEST', content: 'BEGIN:VCALENDAR' }] };
    const memory = new InMemoryMailTransport();
    await memory.send(mail);
    assert.deepEqual(memory.outbox, [mail]);
    withEnv({ NODE_ENV: 'test', MAIL_TRANSPORT: 'memory' }, () => assert.ok(createMailTransport() instanceof InMemoryMailTransport));
    withEnv({ NODE_ENV: 'development', MAIL_TRANSPORT: undefined }, () => assert.ok(createMailTransport() instanceof SmtpMailTransport));
  });
});
