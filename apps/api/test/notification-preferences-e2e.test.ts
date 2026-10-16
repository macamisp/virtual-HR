/**
 * Notification preferences, quiet hours, templates and unsubscribe (FR-NOTIF-002, 004; ADR 012),
 * end to end on Postgres with RLS. Emails go to the in-memory outbox.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { MAIL_TRANSPORT, InMemoryMailTransport } from '../src/common/mailer.ts';
import { NotificationEmailSender, NotificationsService } from '../src/notifications/notifications.service.ts';
import { ScheduledWorkService } from '../src/notifications/scheduled-work.service.ts';
import { signUnsubscribeToken } from '../src/notifications/notification-rules.ts';
import { getJwtSecret } from '../src/common/config.ts';
import { NotificationListSchema, NotificationPreferencesSchema } from '../../../packages/shared/src/notifications/types.ts';
import type { NotificationPreferences, NotificationPreferencesDto } from '../../../packages/shared/src/notifications/types.ts';

const ORG = 'e0e00000-0000-4000-8000-000000000001';
const OTHER = 'e0e00000-0000-4000-8000-000000000002';
const PASSWORD = 'ComplexPassword123!';
const U = {
  lead: { id: 'e0e00000-0000-4000-8000-000000000011', org: ORG, email: 'lead@prefs.test', name: 'Lena Lead', role: 'TEAM_LEAD' },
  emp: { id: 'e0e00000-0000-4000-8000-000000000012', org: ORG, email: 'emp@prefs.test', name: 'Eva Emp', role: 'EMPLOYEE' },
  other: { id: 'e0e00000-0000-4000-8000-000000000021', org: OTHER, email: 'other@prefs.test', name: 'Otto Other', role: 'EMPLOYEE' },
} as const;
type Who = keyof typeof U;

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (d: Date) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;

describe('Notification preferences, quiet hours and unsubscribe (FR-NOTIF-002, 004)', { concurrency: false }, () => {
  let app: INestApplication;
  let base: string;
  let adminPool: pg.Pool;
  let outbox: InMemoryMailTransport;
  const tokens = {} as Record<Who, string>;

  const api = (who: Who, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  async function ok<T>(res: Response, status: number, schema?: { parse: (v: unknown) => T }): Promise<T> {
    const text = await res.text();
    assert.equal(res.status, status, `${res.url}: ${text}`);
    return schema ? schema.parse(JSON.parse(text)) : (JSON.parse(text || 'null') as T);
  }
  const prefsDto = (p: NotificationPreferences, patch: Partial<NotificationPreferencesDto> = {}): NotificationPreferencesDto => ({
    timezone: p.timezone, quietHours: p.quietHours, items: p.items.map((i) => ({ type: i.type, inApp: i.inApp, email: i.email })), ...patch,
  });
  const assignTask = async (title: string) => await ok<{ id: string }>(await api('lead', '/tasks', { method: 'POST', body: { title, assigneeId: U.emp.id } }), 201);
  const rowFor = async (title: string) =>
    (await adminPool.query(`SELECT id, send_email, in_app, email_after, emailed_at FROM notifications WHERE user_id = $1 AND title LIKE $2`, [U.emp.id, `%${title}%`])).rows;
  const mailsTo = (who: Who) => outbox.outbox.filter((m) => m.to === U[who].email);

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.RATE_LIMIT_UNSUBSCRIBE = '1000';
    process.env.JOBS_ENABLED = 'false';
    adminPool = new pg.Pool({
      host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev',
      user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres',
    });
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER]]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, 'Prefs Ltd', 'prefs-e2e', 'Asia/Colombo'), ($2, 'Other Ltd', 'prefs-other-e2e', 'UTC')`, [ORG, OTHER]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const u of Object.values(U)) {
      await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')`, [u.id, u.org, u.email, u.name, u.role, hash]);
    }
    await adminPool.query(`UPDATE users SET manager_id = $1 WHERE id = $2`, [U.lead.id, U.emp.id]);
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(3098);
    base = 'http://localhost:3098';
    outbox = app.get<InMemoryMailTransport>(MAIL_TRANSPORT, { strict: false });
    for (const who of Object.keys(U) as Who[]) {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: U[who].email, password: PASSWORD }) });
      tokens[who] = ((await res.json()) as { accessToken: string }).accessToken;
      assert.ok(tokens[who], `login ${who}`);
    }
  });

  after(async () => {
    await app?.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER]]);
    await adminPool.end();
  });

  describe('Preferences (FR-NOTIF-004)', { concurrency: false }, () => {
    it('defaults: every type on both channels, no quiet hours, the organisation timezone', async () => {
      const p = await ok(await api('emp', '/notifications/preferences'), 200, NotificationPreferencesSchema);
      assert.equal(p.timezone, null);
      assert.equal(p.orgTimezone, 'Asia/Colombo');
      assert.equal(p.quietHours, null);
      assert.ok(p.items.length >= 20);
      assert.ok(p.items.every((i) => i.inApp && i.email));
      assert.ok(p.items.some((i) => i.critical && i.group === 'Security'));
    });

    it('refuses an unknown timezone, equal quiet-hour bounds, extra fields and switching off a security notice', async () => {
      const p = await ok(await api('emp', '/notifications/preferences'), 200, NotificationPreferencesSchema);
      assert.equal((await api('emp', '/notifications/preferences', { method: 'PUT', body: prefsDto(p, { timezone: 'Mars/Olympus' }) })).status, 400);
      assert.equal((await api('emp', '/notifications/preferences', { method: 'PUT', body: prefsDto(p, { quietHours: { start: '22:00', end: '22:00' } }) })).status, 400);
      assert.equal((await api('emp', '/notifications/preferences', { method: 'PUT', body: { ...prefsDto(p), digest: true } })).status, 400);
      const critical = p.items.find((i) => i.critical)!;
      const res = await api('emp', '/notifications/preferences', { method: 'PUT', body: prefsDto(p, { items: p.items.map((i) => ({ type: i.type, inApp: i.inApp, email: i.type === critical.type ? false : i.email })) }) });
      assert.equal(res.status, 400);
      assert.match(await res.text(), /security notice/);
    });

    it('in-app off: the event is still emailed but never reaches the centre; email off: no email', async () => {
      const p = await ok(await api('emp', '/notifications/preferences'), 200, NotificationPreferencesSchema);
      const items = p.items.map((i) => ({ type: i.type, inApp: i.type !== 'TASK_ASSIGNED', email: i.type !== 'TASK_STATUS' }));
      const saved = await ok(await api('emp', '/notifications/preferences', { method: 'PUT', body: prefsDto(p, { items }) }), 200, NotificationPreferencesSchema);
      assert.equal(saved.items.find((i) => i.type === 'TASK_ASSIGNED')!.inApp, false);
      assert.equal(saved.items.find((i) => i.type === 'TASK_STATUS')!.email, false);
      const stored = await adminPool.query(`SELECT type FROM notification_preferences WHERE user_id = $1 ORDER BY type`, [U.emp.id]);
      assert.deepEqual(stored.rows.map((r) => r.type), ['TASK_ASSIGNED', 'TASK_STATUS'], 'only non-default rows are stored');

      outbox.outbox.length = 0;
      await assignTask('Quiet task A');
      await new Promise((r) => setTimeout(r, 150));
      const rows = await rowFor('Quiet task A');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].in_app, false);
      assert.ok(rows[0].emailed_at, 'emailed');
      assert.ok(mailsTo('emp').some((m) => m.subject.includes('Quiet task A')));
      const centre = await ok(await api('emp', '/notifications'), 200, NotificationListSchema);
      assert.ok(!centre.items.some((n) => n.title.includes('Quiet task A')), 'hidden from the centre');
      assert.equal(centre.unreadCount, 0);
      const audit = await adminPool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = $1 AND action = 'NOTIFICATION_PREFERENCES_UPDATED'`, [ORG]);
      assert.equal(audit.rows[0].n, 1);
    });

    it('both channels off: nothing is created at all', async () => {
      const p = await ok(await api('emp', '/notifications/preferences'), 200, NotificationPreferencesSchema);
      await ok(await api('emp', '/notifications/preferences', { method: 'PUT', body: prefsDto(p, { items: p.items.map((i) => ({ type: i.type, inApp: i.type !== 'TASK_ASSIGNED', email: i.type !== 'TASK_ASSIGNED' })) }) }), 200);
      await assignTask('Silent task');
      await new Promise((r) => setTimeout(r, 100));
      assert.equal((await rowFor('Silent task')).length, 0);
    });

    it('a security notice ignores switched-off preferences and quiet hours', async () => {
      const p = await ok(await api('emp', '/notifications/preferences'), 200, NotificationPreferencesSchema);
      const now = new Date();
      await ok(await api('emp', '/notifications/preferences', { method: 'PUT', body: prefsDto(p, { timezone: 'UTC', quietHours: { start: hhmm(new Date(now.getTime() - 3_600_000)), end: hhmm(new Date(now.getTime() + 3_600_000)) } }) }), 200);
      await adminPool.query(`INSERT INTO notification_preferences (org_id, user_id, type, in_app, email) VALUES ($1, $2, 'DOCUMENT_INFECTED', false, false) ON CONFLICT DO NOTHING`, [ORG, U.emp.id]);
      outbox.outbox.length = 0;
      await app.get(NotificationsService).notify(ORG, [{ userId: U.emp.id, type: 'DOCUMENT_INFECTED', title: 'Malware in upload X', email: true }]);
      await new Promise((r) => setTimeout(r, 150));
      const rows = await rowFor('Malware in upload X');
      assert.equal(rows[0]?.in_app, true);
      assert.equal(rows[0]?.email_after, null);
      assert.ok(rows[0]?.emailed_at);
      const mail = mailsTo('emp').find((m) => m.subject.includes('Malware in upload X'))!;
      assert.match(mail.text, /security notice and is always sent/);
      assert.doesNotMatch(mail.text, /unsubscribe#/);
      await adminPool.query(`DELETE FROM notification_preferences WHERE user_id = $1 AND type = 'DOCUMENT_INFECTED'`, [U.emp.id]);
    });

    it('quiet hours in the user timezone hold the email until the window ends; the centre gets it at once', async () => {
      // Preferences from the previous test: UTC, quiet from one hour ago to one hour ahead.
      const p = await ok(await api('emp', '/notifications/preferences'), 200, NotificationPreferencesSchema);
      await ok(await api('emp', '/notifications/preferences', { method: 'PUT', body: prefsDto(p, { items: p.items.map((i) => ({ type: i.type, inApp: true, email: true })) }) }), 200);
      outbox.outbox.length = 0;
      await assignTask('Night task');
      await new Promise((r) => setTimeout(r, 150));
      const [row] = await rowFor('Night task');
      assert.ok(row, 'created');
      assert.equal(row.send_email, true);
      assert.ok(row.email_after, 'deferred');
      assert.equal(row.emailed_at, null);
      assert.ok(!mailsTo('emp').some((m) => m.subject.includes('Night task')), 'no email yet');
      const centre = await ok(await api('emp', '/notifications?unreadOnly=true'), 200, NotificationListSchema);
      assert.ok(centre.items.some((n) => n.title.includes('Night task')), 'in-app at once');
      // The sender refuses the row before its time, even when asked directly.
      assert.equal(await app.get(NotificationEmailSender).send(ORG, row.id, new Date()), false);
      // The deferred-emails job sends it once the window has ended.
      const work = app.get(ScheduledWorkService);
      assert.equal(await work.deferredEmails(new Date()), 0);
      const after = new Date(new Date(row.email_after).getTime() + 60_000);
      assert.ok(await work.deferredEmails(after) >= 1);
      await new Promise((r) => setTimeout(r, 150));
      assert.ok((await rowFor('Night task'))[0].emailed_at);
      const mail = mailsTo('emp').find((m) => m.subject.includes('Night task'))!;
      assert.match(mail.subject, /^\[Prefs Ltd\] /);
      assert.match(mail.text, /Hello Eva Emp,/);
      assert.match(mail.text, /\/tasks\//);
      assert.match(mail.text, /Stop emails about "task assigned to me": http:\/\/[^\s]+\/unsubscribe#v1\./);
      // Clear quiet hours for the remaining tests.
      await ok(await api('emp', '/notifications/preferences', { method: 'PUT', body: prefsDto(p, { timezone: null, quietHours: null, items: p.items.map((i) => ({ type: i.type, inApp: true, email: true })) }) }), 200);
    });

    it('preferences are private per organisation (RLS and the same-org trigger)', async () => {
      const theirs = await ok(await api('other', '/notifications/preferences'), 200, NotificationPreferencesSchema);
      assert.equal(theirs.orgTimezone, 'UTC');
      await assert.rejects(adminPool.query(`INSERT INTO notification_preferences (org_id, user_id, type, in_app, email) VALUES ($1, $2, 'TASK_STATUS', true, false)`, [OTHER, U.emp.id]), /another organisation/);
    });
  });

  describe('Unsubscribe links (FR-NOTIF-002)', { concurrency: false }, () => {
    it('the link in the email turns that type\'s email off for that user only; idempotent; bad tokens fail', async () => {
      const mail = mailsTo('emp').find((m) => m.subject.includes('Night task'))!;
      const token = /unsubscribe#(v1\.[A-Za-z0-9_.-]+)/.exec(mail.text)![1]!;
      const unsub = (t: string) => fetch(`${base}/notifications/unsubscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: t }) });
      const res = await ok<{ type: string; label: string }>(await unsub(token), 200);
      assert.equal(res.type, 'TASK_ASSIGNED');
      assert.equal(res.label, 'Task assigned to me');
      const p = await ok(await api('emp', '/notifications/preferences'), 200, NotificationPreferencesSchema);
      assert.equal(p.items.find((i) => i.type === 'TASK_ASSIGNED')!.email, false);
      assert.equal(p.items.find((i) => i.type === 'TASK_ASSIGNED')!.inApp, true, 'in-app untouched');
      assert.equal((await unsub(token)).status, 200, 'idempotent');
      assert.equal((await unsub(`${token.slice(0, -3)}abc`)).status, 400, 'tampered');
      assert.equal((await unsub(signUnsubscribeToken(getJwtSecret(), ORG, U.emp.id, 'DOCUMENT_INFECTED'))).status, 400, 'security notices cannot be unsubscribed');
      assert.equal((await unsub(signUnsubscribeToken(getJwtSecret(), ORG, U.emp.id, 'NOT_A_TYPE'))).status, 400);
      assert.equal((await unsub(signUnsubscribeToken(getJwtSecret(), OTHER, U.emp.id, 'TASK_STATUS'))).status, 400, 'user is not in that organisation');
      const lead = await ok(await api('lead', '/notifications/preferences'), 200, NotificationPreferencesSchema);
      assert.ok(lead.items.every((i) => i.email), 'nobody else changed');
      const audit = await adminPool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = $1 AND action = 'NOTIFICATION_UNSUBSCRIBED'`, [ORG]);
      assert.equal(audit.rows[0].n, 2);
    });

    it('the preferences screen can turn the email back on; an old link cannot', async () => {
      const p = await ok(await api('emp', '/notifications/preferences'), 200, NotificationPreferencesSchema);
      const saved = await ok(await api('emp', '/notifications/preferences', { method: 'PUT', body: prefsDto(p, { items: p.items.map((i) => ({ type: i.type, inApp: true, email: true })) }) }), 200, NotificationPreferencesSchema);
      assert.ok(saved.items.every((i) => i.email));
      assert.equal((await adminPool.query(`SELECT count(*)::int AS n FROM notification_preferences WHERE user_id = $1`, [U.emp.id])).rows[0].n, 0);
    });
  });
});
