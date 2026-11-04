/**
 * ADR 039: every account e-mail has one clear button and the same link as plain text, in both the
 * HTML and the text part, so it works in any mail program (and in Mailhog, which shows text).
 *
 * Links are built from APP_WEB_URL only. Opening the e-mail on another device needs APP_WEB_URL to
 * be an address that device can reach (the LAN HTTPS address or the public HTTPS address), never
 * localhost: see docs/runbooks/mail.md.
 */
export interface ActionEmail {
  subject: string;
  /** First line, also the hidden preview text of the HTML part. */
  intro: string;
  /** Plain sentences before the button. */
  paragraphs?: string[];
  buttonLabel: string;
  url: string;
  /** After the link: expiry and "if this was not you". */
  footer: string[];
}

export function appWebUrl(env: Record<string, string | undefined> = process.env): string {
  return (env.APP_WEB_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function renderActionEmail(e: ActionEmail): { subject: string; text: string; html: string } {
  const text = [
    e.intro,
    ...(e.paragraphs?.length ? ['', ...e.paragraphs] : []),
    '',
    `${e.buttonLabel}: ${e.url}`,
    '',
    'If the button or link does not open, copy the whole address above into your browser.',
    '',
    ...e.footer,
  ].join('\n');
  const p = (s: string) => `<p style="margin:0 0 16px;font-size:15px;line-height:22px;color:#1f2937">${escapeHtml(s)}</p>`;
  const small = (s: string) => `<p style="margin:0 0 8px;font-size:13px;line-height:19px;color:#6b7280">${escapeHtml(s)}</p>`;
  const url = escapeHtml(e.url);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(e.subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<span style="display:none;max-height:0;overflow:hidden">${escapeHtml(e.intro)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;padding:32px">
<tr><td>
<p style="margin:0 0 24px;font-size:13px;font-weight:600;letter-spacing:.04em;color:#4b5563">HRVO</p>
${p(e.intro)}
${(e.paragraphs ?? []).map(p).join('\n')}
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"><tr><td style="border-radius:6px;background:#1d4ed8">
<a href="${url}" data-testid="email-action" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px">${escapeHtml(e.buttonLabel)}</a>
</td></tr></table>
${small('If the button does not work, open this link:')}
<p style="margin:0 0 24px;font-size:13px;line-height:19px;word-break:break-all"><a href="${url}" data-testid="email-link" style="color:#1d4ed8">${url}</a></p>
${e.footer.map(small).join('\n')}
</td></tr></table>
</td></tr></table>
</body></html>`;
  return { subject: e.subject, text, html };
}
