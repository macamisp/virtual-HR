/**
 * Dev SMTP transport (Mailhog) used for FR-AUTH-008 reset links: protocol, dot-stuffing,
 * header-injection rejection and transport selection.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { InMemoryMailTransport, SmtpMailTransport, createMailTransport } from '../src/common/mailer.ts';

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
