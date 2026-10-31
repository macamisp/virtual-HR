/**
 * Transactional mail transport (FR-AUTH-008 reset links).
 *
 * MAIL_TRANSPORT selects the implementation:
 *  - "smtp" (default outside production): minimal plaintext SMTP client for the local
 *    Mailhog container (docker-compose.yml). No TLS/auth, so it is refused in production.
 *  - "memory": in-process outbox for tests.
 *  - "resend": production HTTPS delivery using RESEND_API_KEY and RESEND_FROM.
 * Production refuses both development transports.
 *
 * Message bodies may contain single-use links; they are never logged.
 */
import net from 'node:net';
import { z } from 'zod';
import { isProduction } from './config.ts';

export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

export interface MailAttachment {
  filename: string;
  /** e.g. "text/calendar; method=REQUEST" */
  contentType: string;
  content: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** ADR 016: calendar invites (.ics). Text attachments only. */
  attachments?: MailAttachment[];
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
      const headers = [`From: <${this.from}>`, `To: <${message.to}>`, `Subject: ${message.subject}`, `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0'];
      let content: string[];
      if (message.attachments?.length) {
        const boundary = `hrvo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        content = [`Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', body];
        for (const a of message.attachments) {
          assertNoHeaderInjection(a.filename, 'attachment name');
          assertNoHeaderInjection(a.contentType, 'attachment type');
          const b64 = Buffer.from(a.content, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
          content.push(`--${boundary}`, `Content-Type: ${a.contentType}; charset=utf-8; name="${a.filename}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${a.filename}"`, '', b64);
        }
        content.push(`--${boundary}--`);
      } else content = ['Content-Type: text/plain; charset=utf-8', '', body];
      const data = [...headers, ...content, '.'].join('\r\n');
      await command(data, [250]);
      await command('QUIT', [221]);
    } finally {
      socket.end();
    }
  }
}

/** Resend HTTPS API (FR-AUTH-001/008, FR-NOTIF-002, FR-MEET-003). One request, no retries. */
export class ResendMailTransport implements MailTransport {
  private readonly apiKey: string;
  private readonly from: string;

  constructor(apiKey: string, from: string) {
    if (!apiKey.trim()) throw new Error('RESEND_API_KEY is required for MAIL_TRANSPORT=resend');
    if (/\s/.test(apiKey)) throw new Error('RESEND_API_KEY must not contain whitespace');
    if (!from.trim()) throw new Error('RESEND_FROM is required for MAIL_TRANSPORT=resend');
    assertNoHeaderInjection(from, 'sender');
    this.from = from.trim();
    const address = this.from.includes('<') ? this.from.match(/^[^<>]+<([^<>]+)>$/)?.[1] : this.from;
    if (!z.email().safeParse(address).success) throw new Error('RESEND_FROM must be an email address or Name <email>');
    this.apiKey = apiKey;
  }

  async send(message: MailMessage): Promise<void> {
    assertNoHeaderInjection(message.to, 'recipient');
    assertNoHeaderInjection(message.subject, 'subject');
    const attachments = message.attachments?.map((attachment) => {
      assertNoHeaderInjection(attachment.filename, 'attachment name');
      assertNoHeaderInjection(attachment.contentType, 'attachment type');
      return {
        filename: attachment.filename,
        content_type: attachment.contentType,
        content: Buffer.from(attachment.content, 'utf8').toString('base64'),
      };
    });
    const signal = AbortSignal.timeout(10_000);
    let response: Response;
    try {
      response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject, text: message.text, attachments }),
        signal,
        // Do not forward credentials or message content to a redirect target.
        redirect: 'error',
      });
    } catch {
      // Fetch errors and provider bodies may contain sensitive data. Never attach them as causes.
      throw new Error(signal.aborted ? 'Resend request timed out' : 'Resend request failed');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Resend delivery failed (HTTP ${response.status})`);
    }
    try {
      const result: unknown = await response.json();
      if (!z.object({ id: z.string().min(1) }).safeParse(result).success) throw new Error('Missing email id');
    } catch {
      throw new Error(signal.aborted ? 'Resend request timed out' : 'Resend returned an invalid response');
    }
  }
}

export function createMailTransport(): MailTransport {
  const mode = process.env.MAIL_TRANSPORT ?? 'smtp';
  if (mode === 'resend') {
    return new ResendMailTransport(process.env.RESEND_API_KEY ?? '', process.env.RESEND_FROM ?? '');
  }
  if (mode === 'memory') {
    if (isProduction()) throw new Error('MAIL_TRANSPORT=memory is not allowed in production');
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
