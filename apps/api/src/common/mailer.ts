/**
 * Transactional mail transport (FR-AUTH-008 reset links).
 *
 * MAIL_TRANSPORT selects the implementation:
 *  - "smtp" (default outside production): minimal plaintext SMTP client for the local
 *    Mailhog container (docker-compose.yml). No TLS/auth, so it is refused in production.
 *  - "memory": in-process outbox for tests.
 * A production provider (SES or Resend per SRS 4.1) is not implemented yet.
 *
 * Message bodies may contain single-use links; they are never logged.
 */
import net from 'node:net';
import { isProduction } from './config.ts';

export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface MailTransport {
  send(message: MailMessage): Promise<void>;
}

export class InMemoryMailTransport implements MailTransport {
  readonly outbox: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.outbox.push({ ...message });
  }
}

function assertNoHeaderInjection(value: string, field: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`Invalid ${field}: line breaks are not allowed`);
  }
}

export class SmtpMailTransport implements MailTransport {
  private readonly host: string;
  private readonly port: number;
  private readonly from: string;

  constructor(host: string, port: number, from: string) {
    this.host = host;
    this.port = port;
    this.from = from;
  }

  async send(message: MailMessage): Promise<void> {
    assertNoHeaderInjection(message.to, 'recipient');
    assertNoHeaderInjection(message.subject, 'subject');
    assertNoHeaderInjection(this.from, 'sender');

    const socket = net.createConnection({ host: this.host, port: this.port });
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => socket.destroy(new Error('SMTP timeout')));

    let buffer = '';
    const waiters: Array<{ resolve: (code: number) => void; reject: (err: Error) => void }> = [];
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        // Multi-line replies use "250-"; the final line uses "250 ".
        if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
          waiters.shift()?.resolve(Number.parseInt(line.slice(0, 3), 10));
        }
      }
    });
    socket.on('error', (err) => {
      for (const w of waiters.splice(0)) w.reject(err);
    });

    const reply = () => new Promise<number>((resolve, reject) => waiters.push({ resolve, reject }));
    const expect = async (pending: Promise<number>, ok: number[]) => {
      const code = await pending;
      if (!ok.includes(code)) throw new Error(`SMTP unexpected reply ${code}`);
    };
    const command = (line: string, ok: number[]) => {
      const pending = reply();
      socket.write(`${line}\r\n`);
      return expect(pending, ok);
    };

    try {
      await expect(reply(), [220]);
      await command('EHLO hrvo.local', [250]);
      await command(`MAIL FROM:<${this.from}>`, [250]);
      await command(`RCPT TO:<${message.to}>`, [250, 251]);
      await command('DATA', [354]);
      const body = message.text
        .replace(/\r?\n/g, '\r\n')
        .split('\r\n')
        .map((l) => (l.startsWith('.') ? `.${l}` : l))
        .join('\r\n');
      const data = [
        `From: <${this.from}>`,
        `To: <${message.to}>`,
        `Subject: ${message.subject}`,
        `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        body,
        '.',
      ].join('\r\n');
      await command(data, [250]);
      await command('QUIT', [221]);
    } finally {
      socket.end();
    }
  }
}

export function createMailTransport(): MailTransport {
  const mode = process.env.MAIL_TRANSPORT ?? 'smtp';
  if (mode === 'memory') {
    return new InMemoryMailTransport();
  }
  if (mode !== 'smtp') {
    throw new Error(`Unknown MAIL_TRANSPORT: ${mode}`);
  }
  if (isProduction()) {
    throw new Error('MAIL_TRANSPORT=smtp is a plaintext dev transport (Mailhog); configure a production provider before deploying');
  }
  return new SmtpMailTransport(
    process.env.SMTP_HOST || 'localhost',
    Number.parseInt(process.env.SMTP_PORT || '1025', 10),
    process.env.SMTP_FROM || 'no-reply@hrvo.local',
  );
}
