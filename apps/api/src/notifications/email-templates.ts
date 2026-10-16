/**
 * FR-NOTIF-002 email templates. Plain text (the SMTP transport is text-only): a greeting, the
 * event, a deep link, and a footer that explains why the mail arrived and, for non-critical
 * types, how to unsubscribe from that type. Confidential titles never reach here (ADR 010).
 */
import { isCriticalNotification, NOTIFICATION_TYPE_META } from '../../../../packages/shared/src/notifications/types.ts';
import type { NotificationType } from '../../../../packages/shared/src/notifications/types.ts';

export interface EmailContext {
  type: string;
  title: string;
  body: string;
  link: string | null;
  recipientName: string | null;
  orgName: string;
  webUrl: string;
  unsubscribeUrl: string | null;
}

export function renderEmail(ctx: EmailContext): { subject: string; text: string } {
  const meta = NOTIFICATION_TYPE_META[ctx.type as NotificationType];
  const critical = isCriticalNotification(ctx.type);
  const greeting = ctx.recipientName ? `Hello ${ctx.recipientName},` : 'Hello,';
  const lines: Array<string | null> = [
    greeting,
    ctx.body || ctx.title,
    ctx.link ? `Open in HR Virtual Office: ${ctx.webUrl}${ctx.link}` : null,
    '—',
    `You receive this from ${ctx.orgName} on HR Virtual Office because of your role there.`,
    critical
      ? 'This is a security notice and is always sent.'
      : meta && ctx.unsubscribeUrl
        ? `Stop emails about "${meta.label.toLowerCase()}": ${ctx.unsubscribeUrl}\nAll notification settings: ${ctx.webUrl}/account/notifications`
        : `Notification settings: ${ctx.webUrl}/account/notifications`,
  ];
  return { subject: `[${ctx.orgName}] ${ctx.title}`.slice(0, 200), text: lines.filter((l): l is string => !!l).join('\n\n') };
}
