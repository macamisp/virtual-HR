/**
 * ADR 039: the account e-mails (address confirmation, invitation, password reset) and what their
 * links can do once they are old: the state of a link, a fresh link to the address the old one
 * went to, and the per-address cooldown on "Resend e-mail".
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import argon2 from 'argon2';
import pg from 'pg';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { MAIL_TRANSPORT } from '../src/common/mailer.ts';
import type { InMemoryMailTransport, MailMessage } from '../src/common/mailer.ts';
import type { LinkStatus, SignupResponse } from '../../../packages/shared/src/auth/workspace.ts';

const PORT = 3045;
const WEB = 'https://hrvo.example.test';
const PASSWORD = 'AccountEmailsPass!2026';
const ORG = 'e3a11000-0000-4000-8000-000000000001';
const HR = 'e3a11000-0000-4000-8000-000000000011';
const EMP = 'e3a11000-0000-4000-8000-000000000012';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('Account e-mails and their links (ADR 039)', { concurrency: false }, () => {
  let app: INestApplication;
  let base: string;
  let adminPool: pg.Pool;
  let outbox: InMemoryMailTransport;

  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const status = async (kind: string, token: string) => (await (await post('/auth/links/status', { kind, token })).json()) as LinkStatus;
  const mailsTo = (to: string) => outbox.outbox.filter((m) => m.to === to);
  const lastTo = (to: string) => mailsTo(to).at(-1);
  const tokenOf = (m: MailMessage | undefined, page: string) => new RegExp(`${page}#token=([0-9a-f]{64})`).exec(m?.text ?? '')?.[1];

  /** The button and the plain link carry the same APP_WEB_URL address, in both parts. */
  function assertActionEmail(m: MailMessage | undefined, page: string, button: string): string {
    assert.ok(m, 'an e-mail was sent');
    assert.ok(m.html, 'an HTML part');
    const token = tokenOf(m, page);
    assert.ok(token, `the text part links to ${WEB}${page}`);
    const url = `${WEB}${page}#token=${token}`;
    assert.ok(m.text.includes(`${button}: ${url}`), 'the text part names the action and gives the link');
    const hrefs = [...m.html.matchAll(/href="([^"]+)"/g)].map((x) => x[1]);
    assert.deepEqual(hrefs, [url, url], 'one button and one plain link, same address');
    assert.match(m.html, new RegExp(`data-testid="email-action"[^>]*>${button}</a>`));
    return token;
  }

  before(async () => {
    Object.assign(process.env, {
      BREACHED_PASSWORD_CHECK: 'local', MAIL_TRANSPORT: 'memory', RATE_LIMIT_SIGNUP: '1000', RATE_LIMIT_LOGIN: '1000',
      JOBS_ENABLED: 'false', AUTH_MFA_ENFORCEMENT: '', APP_WEB_URL: `${WEB}/`, VERIFICATION_RESEND_COOLDOWN_SECONDS: '60',
    });
    adminPool = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await adminPool.query(`DELETE FROM organizations WHERE id = $1 OR slug LIKE 'mail-flow-co%'`, [ORG]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Mail Flow Ltd', 'mail-flow-ltd')`, [ORG]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    await adminPool.query(
      `INSERT INTO users (id, org_id, email, display_name, role, password_hash, status) VALUES
         ($1, $3, 'hilda@mail-flow.test', 'Hilda HR', 'HR_MANAGER', $4, 'ACTIVE'),
         ($2, $3, 'evan@mail-flow.test', 'Evan Employee', 'EMPLOYEE', $4, 'ACTIVE')`,
      [HR, EMP, ORG, hash]);
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(PORT);
    base = `http://localhost:${PORT}`;
    outbox = app.get<InMemoryMailTransport>(MAIL_TRANSPORT, { strict: false });
  });

  after(async () => {
    await app?.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = $1 OR slug LIKE 'mail-flow-co%'`, [ORG]);
    await adminPool.end();
  });

  it('signup: the confirmation e-mail has a button and the link; the link is valid, then "already verified" when opened again', async () => {
    const res = await post('/auth/signup', { workspaceName: 'Mail Flow Co', displayName: 'Olive Owner', email: 'olive@mail-flow-co.test', password: PASSWORD });
    assert.equal(res.status, 201);
    const body = (await res.json()) as SignupResponse;
    assert.equal(body.resendAfterSeconds, 60, 'the page knows when "Resend e-mail" opens again');
    const mail = lastTo('olive@mail-flow-co.test');
    assert.equal(mail?.subject, 'Confirm your e-mail to open Mail Flow Co on HRVO');
    const token = assertActionEmail(mail, '/verify-email', 'Confirm e-mail and sign in');
    assert.deepEqual(await status('verify', token), { state: 'valid', email: 'olive@mail-flow-co.test', workspace: 'Mail Flow Co', alreadyVerified: false });

    // Resend straight away: the cooldown holds it back, with the same answer as always.
    const resend = await post('/auth/email/resend', { email: 'olive@mail-flow-co.test' });
    assert.equal(resend.status, 202);
    assert.equal(mailsTo('olive@mail-flow-co.test').length, 1, 'no second e-mail within the cooldown');
    assert.equal((await status('verify', token)).state, 'valid', 'the first link still works');

    const verified = await post('/auth/email/verify', { token });
    assert.deepEqual(await verified.json(), { success: true, email: 'olive@mail-flow-co.test', alreadyVerified: false });
    const again = await post('/auth/email/verify', { token });
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as { alreadyVerified: boolean }).alreadyVerified, true);
    assert.deepEqual(await status('verify', token), { state: 'used', email: 'olive@mail-flow-co.test', workspace: 'Mail Flow Co', alreadyVerified: true });
    // Renewing a link of a confirmed address sends nothing.
    await post('/auth/links/renew', { kind: 'verify', token });
    assert.equal(mailsTo('olive@mail-flow-co.test').length, 1);
  });

  it('an expired confirmation link is reported as expired; "Send a new link" mails the address it was sent to', async () => {
    await post('/auth/signup', { workspaceName: 'Mail Flow Co Two', displayName: 'Paul Owner', email: 'paul@mail-flow-co.test', password: PASSWORD });
    const old = tokenOf(lastTo('paul@mail-flow-co.test'), '/verify-email')!;
    await adminPool.query(`UPDATE email_verification_tokens SET expires_at = now() - interval '1 minute', created_at = now() - interval '25 hours' WHERE token_hash = $1`, [sha256(old)]);
    assert.equal((await status('verify', old)).state, 'expired');
    const failed = await post('/auth/email/verify', { token: old });
    assert.equal(failed.status, 400);
    assert.match(await failed.text(), /expired or was replaced/);
    const renew = await post('/auth/links/renew', { kind: 'verify', token: old });
    assert.equal(renew.status, 202);
    assert.match(((await renew.json()) as { message: string }).message, /address it was sent to/);
    const fresh = assertActionEmail(lastTo('paul@mail-flow-co.test'), '/verify-email', 'Confirm e-mail and sign in');
    assert.notEqual(fresh, old);
    assert.equal((await status('verify', fresh)).state, 'valid');
  });

  it('invitation: valid, accepted (used), withdrawn and expired links; an expired one is renewed to the invited address only, audited', async () => {
    const invite = async (email: string, extra = '') => {
      const token = randomBytes(32).toString('hex');
      const id = (await adminPool.query<{ id: string }>(
        `INSERT INTO invitations (org_id, email, role, token_hash, invited_by, expires_at${extra ? `, ${extra}` : ''}) VALUES ($1, $2, 'EMPLOYEE', $3, $4, now() + interval '1 day'${extra ? ', now()' : ''}) RETURNING id`,
        [ORG, email, sha256(token), HR])).rows[0]!.id;
      return { token, id };
    };
    const fresh = await invite('nina@mail-flow.test');
    assert.deepEqual(await status('invite', fresh.token), { state: 'valid', email: 'nina@mail-flow.test', workspace: 'Mail Flow Ltd', alreadyVerified: false });
    const accepted = await post('/auth/invitations/accept', { inviteToken: fresh.token, displayName: 'Nina New', password: PASSWORD });
    assert.equal(accepted.status, 201, await accepted.text());
    assert.equal((await status('invite', fresh.token)).state, 'used');

    const withdrawn = await invite('wanda@mail-flow.test', 'revoked_at');
    assert.equal((await status('invite', withdrawn.token)).state, 'revoked');
    await post('/auth/links/renew', { kind: 'invite', token: withdrawn.token });
    assert.equal(mailsTo('wanda@mail-flow.test').length, 0, 'a withdrawn invitation is never renewed');

    const expired = await invite('xena@mail-flow.test');
    await adminPool.query(`UPDATE invitations SET expires_at = now() - interval '1 hour', last_sent_at = now() - interval '8 days' WHERE id = $1`, [expired.id]);
    assert.equal((await status('invite', expired.token)).state, 'expired');
    // FR-AUTH-001: an expired invitation cannot be accepted.
    const late = await post('/auth/invitations/accept', { inviteToken: expired.token, displayName: 'Xena Late', password: PASSWORD });
    assert.equal(late.status, 400, 'expired invitations are refused');
    assert.equal((await adminPool.query(`SELECT count(*)::int AS n FROM users WHERE email = 'xena@mail-flow.test'`)).rows[0].n, 0);
    await post('/auth/links/renew', { kind: 'invite', token: expired.token });
    const mail = lastTo('xena@mail-flow.test');
    assert.equal(mail?.subject, 'Hilda HR invited you to Mail Flow Ltd on HRVO');
    const renewed = assertActionEmail(mail, '/accept-invitation', 'Accept invitation');
    assert.equal((await status('invite', renewed)).state, 'valid');
    assert.equal((await status('invite', expired.token)).state, 'invalid', 'the old link is replaced');
    const audit = (await adminPool.query(`SELECT actor_id, after->>'by' AS by FROM audit_logs WHERE org_id = $1 AND action = 'INVITATION_RESENT' AND entity_id = $2`, [ORG, expired.id])).rows;
    assert.deepEqual(audit, [{ actor_id: HR, by: 'invitee_expired_link' }]);
    // Renewing a link that still works sends nothing (it can simply be used).
    await post('/auth/links/renew', { kind: 'invite', token: renewed });
    assert.equal(mailsTo('xena@mail-flow.test').length, 1);
  });

  it('password reset: the e-mail has a button and the link; a used link is renewed with a new reset e-mail', async () => {
    await post('/auth/password/forgot', { email: 'evan@mail-flow.test' });
    const mail = lastTo('evan@mail-flow.test');
    assert.equal(mail?.subject, 'Reset your HRVO password');
    const token = assertActionEmail(mail, '/reset-password', 'Choose a new password');
    assert.deepEqual(await status('reset', token), { state: 'valid', email: 'evan@mail-flow.test', workspace: 'Mail Flow Ltd', alreadyVerified: false });
    const done = await post('/auth/password/reset', { token, newPassword: `${PASSWORD}-new` });
    assert.equal(done.status, 200, await done.text());
    assert.equal((await status('reset', token)).state, 'used');
    await post('/auth/links/renew', { kind: 'reset', token });
    const again = assertActionEmail(lastTo('evan@mail-flow.test'), '/reset-password', 'Choose a new password');
    assert.notEqual(again, token);
    assert.equal(mailsTo('evan@mail-flow.test').length, 2);
  });

  it('an unknown token says "invalid" and renews nothing; input is validated', async () => {
    const unknown = randomBytes(32).toString('hex');
    for (const kind of ['verify', 'invite', 'reset']) {
      assert.deepEqual(await status(kind, unknown), { state: 'invalid', email: null, workspace: null, alreadyVerified: false });
    }
    const before = outbox.outbox.length;
    assert.equal((await post('/auth/links/renew', { kind: 'reset', token: unknown })).status, 202);
    assert.equal(outbox.outbox.length, before);
    assert.equal((await post('/auth/links/status', { kind: 'other', token: unknown })).status, 400);
    assert.equal((await post('/auth/links/status', { kind: 'verify', token: 'short' })).status, 400);
  });
});
