/**
 * Transactional mail transport (FR-AUTH-008 reset links; ADR 039).
 *
 * MAIL_TRANSPORT selects the implementation:
 *  - "smtp" (default outside production): minimal plaintext SMTP client for the local Mailhog
 *    container (docker-compose.yml, web UI on http://localhost:8025). No TLS or auth, so it is
 *    refused in production.
 *  - "resend": the Resend HTTPS API (https://resend.com). RESEND_API_KEY and MAIL_FROM come from
 *    the environment only. The production choice today; see docs/runbooks/mail.md.
 *  - "memory": in-process outbox for the API tests. Nothing is delivered.
 *  - "file": one JSON file per message in MAIL_FILE_DIR, for the browser tests (they read the
 *    e-mail and click its link). Nothing is delivered.
 * "memory" and "file" are refused in production, and outside tests the API warns that nothing is
 * delivered with them.
 *
 * Message bodies may contain single-use links; they are never logged.
 */
import net from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

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
  /** ADR 039: the same content as HTML, with a button; the text part keeps the plain link. */
  html?: string;
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

/** Browser tests: each message becomes `<time>-<random>.json` in the directory. Test only. */
export class FileMailTransport implements MailTransport {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  async send(message: MailMessage): Promise<void> {
    const name = `${Date.now()}-${randomBytes(4).toString('hex')}.json`;
    // Recreated on every send: the browser tests empty the directory between runs.
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, name), JSON.stringify({ ...message, sentAt: new Date().toISOString() }), { mode: 0o600 });
  }
}

/** Resend (https://resend.com/docs/api-reference/emails/send-email) over HTTPS; no extra package. */
export class ResendMailTransport implements MailTransport {
  private readonly apiKey: string;
  private readonly from: string;
  private readonly endpoint: string;

  constructor(apiKey: string, from: string, endpoint = 'https://api.resend.com/emails') {
    this.apiKey = apiKey;
    this.from = from;
    this.endpoint = endpoint;
  }

  async send(message: MailMessage): Promise<void> {
    assertNoHeaderInjection(message.to, 'recipient');
    assertNoHeaderInjection(message.subject, 'subject');
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: this.from, to: [message.to], subject: message.subject, text: message.text,
        ...(message.html ? { html: message.html } : {}),
        ...(message.attachments?.length ? { attachments: message.attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content, 'utf8').toString('base64'), content_type: a.contentType })) } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    // Only the status reaches the error: the body could echo the message.
    if (!res.ok) throw new Error(`Resend refused the message (HTTP ${res.status})`);
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
      const boundaryOf = (kind: string) => `hrvo-${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      // ADR 039: text and HTML as alternatives; mail programs show the HTML, Mailhog both.
      const htmlB64 = message.html ? Buffer.from(message.html, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n') : null;
      const alt = boundaryOf('alt');
      const bodyPart = htmlB64
        ? [`Content-Type: multipart/alternative; boundary="${alt}"`, '', `--${alt}`, 'Content-Type: text/plain; charset=utf-8', '', body, `--${alt}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', htmlB64, `--${alt}--`]
        : ['Content-Type: text/plain; charset=utf-8', '', body];
      let content: string[];
      if (message.attachments?.length) {
        const boundary = boundaryOf('mix');
        content = [`Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, ...bodyPart];
        for (const a of message.attachments) {
          assertNoHeaderInjection(a.filename, 'attachment name');
          assertNoHeaderInjection(a.contentType, 'attachment type');
          const b64 = Buffer.from(a.content, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
          content.push(`--${boundary}`, `Content-Type: ${a.contentType}; charset=utf-8; name="${a.filename}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${a.filename}"`, '', b64);
        }
        content.push(`--${boundary}--`);
      } else content = bodyPart;
      const data = [...headers, ...content, '.'].join('\r\n');
      await command(data, [250]);
      await command('QUIT', [221]);
    } finally {
      socket.end();
    }
  }
}

export function createMailTransport(env: Record<string, string | undefined> = process.env): MailTransport {
  const mode = env.MAIL_TRANSPORT ?? 'smtp';
  const production = env.NODE_ENV === 'production';
  const nothingDelivered = (why: string) => {
    if (production) throw new Error(`MAIL_TRANSPORT=${mode} delivers nothing and is refused in production; use resend (docs/runbooks/mail.md)`);
    if (env.NODE_ENV !== 'test') console.warn(`MAIL_TRANSPORT=${mode}: e-mails are ${why} and never delivered. Sign-up, invitation and reset links will not arrive. Use smtp with Mailhog (http://localhost:8025) or resend (docs/runbooks/mail.md).`);
  };
  if (mode === 'memory') {
    nothingDelivered('kept in memory');
    return new InMemoryMailTransport();
  }
  if (mode === 'file') {
    nothingDelivered('written to MAIL_FILE_DIR');
    if (!env.MAIL_FILE_DIR) throw new Error('MAIL_TRANSPORT=file needs MAIL_FILE_DIR');
    return new FileMailTransport(env.MAIL_FILE_DIR);
  }
  if (mode === 'resend') {
    const key = env.RESEND_API_KEY ?? '';
    const from = env.MAIL_FROM ?? '';
    if (!key) throw new Error('MAIL_TRANSPORT=resend needs RESEND_API_KEY');
    if (!from) throw new Error('MAIL_TRANSPORT=resend needs MAIL_FROM (an address on a domain verified in Resend)');
    return new ResendMailTransport(key, from);
  }
  if (mode !== 'smtp') {
    throw new Error(`Unknown MAIL_TRANSPORT: ${mode}`);
  }
  if (production) {
    throw new Error('MAIL_TRANSPORT=smtp is a plaintext dev transport (Mailhog); use resend in production (docs/runbooks/mail.md)');
  }
  return new SmtpMailTransport(
    env.SMTP_HOST || 'localhost',
    Number.parseInt(env.SMTP_PORT || '1025', 10),
    env.MAIL_FROM || env.SMTP_FROM || 'no-reply@hrvo.local',
  );
}
