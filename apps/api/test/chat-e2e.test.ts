/**
 * Chat end to end (FR-MEET-012, 013; ADR 017): DMs, groups, public and private channels with the
 * subcontractor rule, threads, mentions, live delivery, editing and moderation, search limited to
 * readable channels, and file sharing through the document module (clean, not confidential, ACL).
 */
import 'reflect-metadata';
import { freshCode } from './support/totp.ts';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { io, type Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { ChannelListSchema, ChatSearchSchema, MessageListSchema, MessageSchema } from '../../../packages/shared/src/chat/types.ts';
import type { ChatEvent, ChatMessage } from '../../../packages/shared/src/chat/types.ts';

const ORG = 'c4c40000-0000-4000-8000-000000000001';
const OTHER = 'c4c40000-0000-4000-8000-000000000002';
const PORT = 3087;
const PASSWORD = 'ComplexPassword123!';
const SECRET = 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD';
const U = {
  hr: { id: 'c4c40000-0000-4000-8000-000000000011', org: ORG, email: 'hr@chat.test', name: 'Hal HR', role: 'HR', mfa: true },
  a: { id: 'c4c40000-0000-4000-8000-000000000012', org: ORG, email: 'anna@chat.test', name: 'Anna A', role: 'EMPLOYEE', mfa: false },
  b: { id: 'c4c40000-0000-4000-8000-000000000013', org: ORG, email: 'ben@chat.test', name: 'Ben B', role: 'EMPLOYEE', mfa: false },
  sub: { id: 'c4c40000-0000-4000-8000-000000000014', org: ORG, email: 'sid@chat.test', name: 'Sid Sub', role: 'SUBCONTRACTOR', mfa: false },
  other: { id: 'c4c40000-0000-4000-8000-000000000021', org: OTHER, email: 'otto@chat-other.test', name: 'Otto Other', role: 'EMPLOYEE', mfa: false },
} as const;
type Who = keyof typeof U;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mention = (who: Who) => `@[${U[who].name}](user:${U[who].id})`;

describe('Chat (FR-MEET-012, 013)', { concurrency: false }, () => {
  let app: INestApplication;
  let adminPool: pg.Pool;
  const base = `http://localhost:${PORT}`;
  const tokens = {} as Record<Who, string>;
  const sockets: Socket[] = [];
  const inbox = { a: [] as ChatEvent[], b: [] as ChatEvent[], sub: [] as ChatEvent[] };
  let general = '';
  let secret = '';
  let topMessage: ChatMessage;

  const api = (who: Who, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  async function ok<T>(res: Response, status: number, schema?: { parse: (v: unknown) => T }): Promise<T> {
    const text = await res.text();
    assert.equal(res.status, status, `${res.url}: ${text}`);
    return schema ? schema.parse(JSON.parse(text)) : (JSON.parse(text || 'null') as T);
  }
  /** A document row with one version in the given scan state (normally produced by the upload flow). */
  async function doc(owner: Who, title: string, opts: { status?: string; confidentiality?: string } = {}): Promise<string> {
    const d = (await adminPool.query(`INSERT INTO documents (org_id, title, title_enc, meta_key_wrapped, category, confidentiality, owner_id) VALUES ($1, $2, $3, $4, 'OTHER', $5, $6) RETURNING id`,
      [U[owner].org, opts.confidentiality && opts.confidentiality !== 'NORMAL' ? null : title, opts.confidentiality && opts.confidentiality !== 'NORMAL' ? Buffer.from('x') : null, opts.confidentiality && opts.confidentiality !== 'NORMAL' ? Buffer.from('x') : null, opts.confidentiality ?? 'NORMAL', U[owner].id])).rows[0].id as string;
    // A clean version carries its encrypted object's metadata (the check constraint); placeholders here.
    const v = (await adminPool.query(`INSERT INTO document_versions (org_id, document_id, version_no, declared_size, size_bytes, mime_type, kms_key_id, uploaded_by, scan_status, storage_key, iv, auth_tag, sha256)
      VALUES ($1, $2, 1, 1234, 1234, 'application/pdf', 'local', $3, $4, 'test/none', decode('00', 'hex'), decode('00', 'hex'), repeat('0', 64)) RETURNING id`,
      [U[owner].org, d, U[owner].id, opts.status ?? 'CLEAN'])).rows[0].id;
    await adminPool.query(`UPDATE documents SET current_version_id = $2 WHERE id = $1`, [d, v]);
    return d;
  }

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.JOBS_ENABLED = 'false';
    adminPool = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER]]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Chat Ltd', 'chat-e2e'), ($2, 'Other Ltd', 'chat-other-e2e')`, [ORG, OTHER]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const u of Object.values(U)) {
      await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status, mfa_enabled, mfa_secret) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8)`,
        [u.id, u.org, u.email, u.name, u.role, hash, u.mfa, u.mfa ? SECRET : null]);
    }
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(PORT);
    for (const who of Object.keys(U) as Who[]) {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: U[who].email, password: PASSWORD, ...(U[who].mfa ? { totpCode: await freshCode(SECRET) } : {}) }) });
      tokens[who] = ((await res.json()) as { accessToken: string }).accessToken;
    }
    for (const who of ['a', 'b', 'sub'] as const) {
      const s = io(base, { transports: ['websocket'], reconnection: false, auth: { token: tokens[who] } });
      sockets.push(s);
      s.on('chat:message', (e: ChatEvent) => inbox[who].push(e));
      await new Promise<void>((res) => s.once('connect', () => res()));
    }
  });

  after(async () => {
    for (const s of sockets) s.disconnect();
    await app?.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER]]);
    await adminPool.end();
  });

  describe('Channels and visibility', { concurrency: false }, () => {
    it('public channels: employees create and join; subcontractors neither see nor create them', async () => {
      general = (await ok<{ id: string }>(await api('a', '/channels', { method: 'POST', body: { kind: 'PUBLIC', name: 'general', topic: 'Everything' } }), 201)).id;
      assert.equal((await api('b', '/channels', { method: 'POST', body: { kind: 'PUBLIC', name: 'General' } })).status, 409, 'names are unique, case-insensitive');
      assert.equal((await api('sub', '/channels', { method: 'POST', body: { kind: 'PUBLIC', name: 'subs' } })).status, 403);
      const bList = await ok(await api('b', '/channels'), 200, ChannelListSchema);
      assert.deepEqual(bList.items.map((c) => [c.name, c.isMember]), [['general', false]]);
      assert.deepEqual((await ok(await api('sub', '/channels'), 200, ChannelListSchema)).items, []);
      assert.equal((await api('sub', `/channels/${general}/messages`)).status, 404);
      assert.equal((await api('sub', `/channels/${general}/join`, { method: 'POST' })).status, 404);
      assert.equal((await api('b', `/channels/${general}/messages`, { method: 'POST', body: { body: 'hi' } })).status, 403, 'join first');
      await ok(await api('b', `/channels/${general}/join`, { method: 'POST' }), 200);
      assert.equal((await api('other', `/channels/${general}/messages`)).status, 404, 'other organisations');
    });

    it('private channels and group chats are for members only; a subcontractor can be added', async () => {
      secret = (await ok<{ id: string }>(await api('a', '/channels', { method: 'POST', body: { kind: 'PRIVATE', name: 'project-x', memberIds: [U.sub.id] } }), 201)).id;
      assert.equal((await api('b', `/channels/${secret}/messages`)).status, 404);
      assert.equal((await api('b', `/channels/${secret}/join`, { method: 'POST' })).status, 404);
      assert.ok((await ok(await api('sub', '/channels'), 200, ChannelListSchema)).items.some((c) => c.id === secret));
      assert.equal((await api('sub', `/channels/${secret}/members`, { method: 'PUT', body: { add: [U.b.id] } })).status, 403, 'only the owner manages members');
      const group = await ok<{ id: string }>(await api('b', '/channels', { method: 'POST', body: { kind: 'GROUP', memberIds: [U.a.id, U.sub.id] } }), 201);
      assert.equal((await ok(await api('sub', '/channels'), 200, ChannelListSchema)).items.find((c) => c.id === group.id)?.memberCount, 3);
      assert.equal((await api('a', '/channels', { method: 'POST', body: { kind: 'GROUP', memberIds: [U.b.id, U.other.id] } })).status, 404, 'no members from other organisations');
    });

    it('direct messages: one per pair, named after the other person', async () => {
      const dm1 = await ok<{ id: string }>(await api('a', '/channels', { method: 'POST', body: { kind: 'DM', userId: U.sub.id } }), 201);
      const dm2 = await ok<{ id: string }>(await api('sub', '/channels', { method: 'POST', body: { kind: 'DM', userId: U.a.id } }), 201);
      assert.equal(dm1.id, dm2.id);
      assert.equal((await ok(await api('sub', '/channels'), 200, ChannelListSchema)).items.find((c) => c.id === dm1.id)?.name, U.a.name);
      assert.equal((await api('a', '/channels', { method: 'POST', body: { kind: 'DM', userId: U.other.id } })).status, 404);
      assert.equal((await api('a', '/channels', { method: 'POST', body: { kind: 'DM', userId: U.a.id } })).status, 400);
      assert.equal((await api('a', `/channels/${dm1.id}/leave`, { method: 'POST' })).status, 400);
    });
  });

  describe('Messages, threads and mentions', { concurrency: false }, () => {
    it('a message reaches the members live; mentions notify the mentioned member only', async () => {
      inbox.a.length = 0; inbox.b.length = 0; inbox.sub.length = 0;
      topMessage = await ok(await api('a', `/channels/${general}/messages`, { method: 'POST', body: { body: `Welcome ${mention('b')} and ${mention('sub')}! Kickoff at nine.` } }), 201, MessageSchema);
      assert.deepEqual(topMessage.mentions, [U.b.id, U.sub.id], 'public channel: mentions recorded');
      await wait(200);
      assert.equal(inbox.b.length, 1);
      assert.equal(inbox.b[0]!.message.id, topMessage.id);
      assert.equal(inbox.sub.length, 0, 'not a member, not delivered');
      const notes = await adminPool.query(`SELECT user_id, title FROM notifications WHERE org_id = $1 AND type = 'CHAT_MENTION'`, [ORG]);
      assert.deepEqual(notes.rows.map((r) => r.user_id).sort(), [U.b.id, U.sub.id].sort());
      assert.match(notes.rows[0].title, /Anna A mentioned you in general/);
      const pm = await ok(await api('a', `/channels/${secret}/messages`, { method: 'POST', body: { body: `Hey ${mention('b')}` } }), 201, MessageSchema);
      assert.deepEqual(pm.mentions, [], 'in a private channel, only members can be mentioned');
    });

    it('threads: replies to a top-level message; no replies to replies; counts and unread', async () => {
      const reply = await ok(await api('b', `/channels/${general}/messages`, { method: 'POST', body: { body: 'Thanks!', parentId: topMessage.id } }), 201, MessageSchema);
      assert.equal((await api('b', `/channels/${general}/messages`, { method: 'POST', body: { body: 'nested', parentId: reply.id } })).status, 400);
      assert.equal((await api('b', `/channels/${secret}/messages`, { method: 'POST', body: { body: 'x', parentId: topMessage.id } })).status, 404);
      const top = await ok(await api('a', `/channels/${general}/messages`), 200, MessageListSchema);
      assert.deepEqual(top.items.map((m) => [m.id, m.replyCount]), [[topMessage.id, 1]]);
      const thread = await ok(await api('a', `/channels/${general}/messages?parentId=${topMessage.id}`), 200, MessageListSchema);
      assert.deepEqual(thread.items.map((m) => m.body), [topMessage.body, 'Thanks!']);
      await ok(await api('a', `/channels/${general}/messages`, { method: 'POST', body: { body: 'Agenda posted' } }), 201);
      const bList = await ok(await api('b', '/channels'), 200, ChannelListSchema);
      assert.equal(bList.items.find((c) => c.id === general)?.unread, 1);
      await ok(await api('b', `/channels/${general}/messages`), 200);
      assert.equal((await ok(await api('b', '/channels'), 200, ChannelListSchema)).items.find((c) => c.id === general)?.unread, 0, 'reading clears it');
    });

    it('authors edit their own messages; moderators remove anyone\'s (audited); deleted messages are empty', async () => {
      assert.equal((await api('b', `/messages/${topMessage.id}`, { method: 'PUT', body: { body: 'hijack' } })).status, 403);
      const edited = await ok(await api('a', `/messages/${topMessage.id}`, { method: 'PUT', body: { body: 'Welcome everyone! Kickoff at ten.' } }), 200, MessageSchema);
      assert.ok(edited.editedAt);
      assert.equal((await api('b', `/messages/${topMessage.id}`, { method: 'DELETE' })).status, 403);
      await ok(await api('hr', `/messages/${topMessage.id}`, { method: 'DELETE' }), 200, MessageSchema);
      const after = await ok(await api('a', `/channels/${general}/messages`), 200, MessageListSchema);
      const gone = after.items.find((m) => m.id === topMessage.id)!;
      assert.deepEqual([gone.deleted, gone.body], [true, '']);
      const audit = await adminPool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = $1 AND action = 'CHAT_MESSAGE_REMOVED'`, [ORG]);
      assert.equal(audit.rows[0].n, 1);
    });

    it('search only finds messages in channels the user can read', async () => {
      await ok(await api('a', `/channels/${secret}/messages`, { method: 'POST', body: { body: 'The launch codename is Bluebird' } }), 201);
      const aHits = await ok(await api('a', '/chat/search?q=bluebird'), 200, ChatSearchSchema);
      assert.equal(aHits.items.length, 1);
      assert.equal(aHits.items[0]!.channelName, 'project-x');
      assert.equal((await ok(await api('b', '/chat/search?q=bluebird'), 200, ChatSearchSchema)).items.length, 0, 'Ben is not in project-x');
      assert.equal((await ok(await api('b', '/chat/search?q=agenda'), 200, ChatSearchSchema)).items.length, 1);
      assert.equal((await ok(await api('a', '/chat/search?q=kickoff'), 200, ChatSearchSchema)).items.length, 0, 'deleted messages are not searchable');
      assert.equal((await api('a', '/chat/search?q=x')).status, 400);
    });

    it('archived channels are read-only; only owners and moderators archive', async () => {
      assert.equal((await api('b', `/channels/${general}/archive`, { method: 'POST' })).status, 403);
      await ok(await api('hr', `/channels/${general}/archive`, { method: 'POST' }), 200);
      assert.equal((await api('a', `/channels/${general}/messages`, { method: 'POST', body: { body: 'still here?' } })).status, 409);
      assert.ok((await ok(await api('a', '/channels'), 200, ChannelListSchema)).items.find((c) => c.id === general)?.archived);
    });
  });

  describe('Files through the document module (FR-MEET-013)', { concurrency: false }, () => {
    it('only clean, non-confidential documents you manage; members get download access, later members too', async () => {
      const pending = await doc('a', 'Draft plan', { status: 'PENDING' });
      assert.equal((await api('a', `/channels/${secret}/messages`, { method: 'POST', body: { documentId: pending } })).status, 409, 'not scanned yet');
      const infected = await doc('a', 'Bad file', { status: 'INFECTED' });
      assert.equal((await api('a', `/channels/${secret}/messages`, { method: 'POST', body: { documentId: infected } })).status, 409);
      const conf = await doc('a', 'Salaries', { confidentiality: 'CONFIDENTIAL' });
      assert.equal((await api('a', `/channels/${secret}/messages`, { method: 'POST', body: { documentId: conf } })).status, 403);
      const hers = await doc('hr', 'HR handbook');
      assert.equal((await api('a', `/channels/${secret}/messages`, { method: 'POST', body: { documentId: hers } })).status, 404, 'not yours to share');
      const plan = await doc('a', 'Project plan');
      const msg = await ok(await api('a', `/channels/${secret}/messages`, { method: 'POST', body: { body: 'Here is the plan', documentId: plan } }), 201, MessageSchema);
      assert.deepEqual(msg.attachment, { documentId: plan, title: 'Project plan', sizeBytes: 1234, mimeType: 'application/pdf' });
      const acl = async (userId: string) => (await adminPool.query(`SELECT permission FROM document_acl WHERE document_id = $1 AND principal_id = $2`, [plan, userId])).rows.map((r) => r.permission);
      assert.deepEqual(await acl(U.sub.id), ['DOWNLOAD'], 'the subcontractor member can download it');
      assert.deepEqual(await acl(U.b.id), [], 'Ben is not a member');
      const sidDoc = await api('sub', `/documents/${plan}`);
      assert.equal(sidDoc.status, 200, 'visible through the document module');
      await ok(await api('a', `/channels/${secret}/members`, { method: 'PUT', body: { add: [U.b.id] } }), 200);
      assert.deepEqual(await acl(U.b.id), ['DOWNLOAD'], 'new members get the channel\'s files');
      const log = await adminPool.query(`SELECT action, detail->>'via' AS via FROM document_access_logs WHERE document_id = $1 AND action = 'SHARE'`, [plan]);
      assert.deepEqual(log.rows, [{ action: 'SHARE', via: 'CHAT' }]);
    });

    it('chat tables are tenant-isolated and messages are never deleted by the app', async () => {
      const app2 = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGUSER || 'hrvo_app', password: process.env.PGPASSWORD });
      const c = await app2.connect();
      try {
        assert.equal((await c.query(`SELECT count(*)::int AS n FROM messages`)).rows[0].n, 0, 'no tenant context, no rows');
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.org_id', $1, true)`, [OTHER]);
        assert.equal((await c.query(`SELECT count(*)::int AS n FROM channels`)).rows[0].n, 0);
        await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG]);
        await assert.rejects(c.query(`DELETE FROM messages`), /permission denied/);
      } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); await app2.end(); }
    });
  });
});
