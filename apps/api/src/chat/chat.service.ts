import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import { PrismaService } from '../common/prisma.service.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import { AttendanceGateway } from '../attendance/attendance.gateway.ts';
import { NotificationsService } from '../notifications/notifications.service.ts';
import { loadDocument } from '../documents/documents.sql.ts';
import { LEVEL } from '../documents/document-policy.ts';
import { logAccess } from '../documents/access-log.ts';
import { Permission, userCan } from '../../../../packages/shared/src/auth/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import { mentionedIds } from '../../../../packages/shared/src/chat/types.ts';
import type { Channel, ChannelCreateDto, ChannelKind, ChatEvent, ChatMessage, MembersDto, MessageDto, MessageQuery } from '../../../../packages/shared/src/chat/types.ts';

interface ChannelRow {
  id: string;
  kind: ChannelKind;
  name: string;
  topic: string;
  created_by: string;
  archived_at: Date | null;
  member_role: string | null;
}

interface MessageRow {
  id: string;
  channel_id: string;
  author_id: string;
  display_name: string | null;
  email: string;
  parent_id: string | null;
  body: string;
  mentions: string[];
  document_id: string | null;
  doc_title: string | null;
  doc_size: string | null;
  doc_mime: string | null;
  reply_count: number;
  created_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
}

const MESSAGE_SELECT = `
  SELECT m.id, m.channel_id, m.author_id, u.display_name, u.email, m.parent_id, m.body, m.mentions, m.document_id,
         CASE WHEN d.confidentiality = 'NORMAL' THEN d.title ELSE '(confidential)' END AS doc_title, v.size_bytes::text AS doc_size, v.mime_type AS doc_mime,
         (SELECT count(*)::int FROM messages r WHERE r.parent_id = m.id AND r.deleted_at IS NULL) AS reply_count,
         m.created_at, m.edited_at, m.deleted_at
  FROM messages m JOIN users u ON u.id = m.author_id
  LEFT JOIN documents d ON d.id = m.document_id LEFT JOIN document_versions v ON v.id = d.current_version_id`;

function mapMessage(r: MessageRow): ChatMessage {
  const deleted = !!r.deleted_at;
  return {
    id: r.id, channelId: r.channel_id, author: { id: r.author_id, displayName: r.display_name, email: r.email },
    body: deleted ? '' : r.body, parentId: r.parent_id, replyCount: r.reply_count, mentions: deleted ? [] : r.mentions ?? [],
    attachment: !deleted && r.document_id ? { documentId: r.document_id, title: r.doc_title ?? 'Document', sizeBytes: r.doc_size ? Number(r.doc_size) : null, mimeType: r.doc_mime } : null,
    createdAt: r.created_at.toISOString(), editedAt: r.edited_at?.toISOString() ?? null, deleted,
  };
}

/**
 * FR-MEET-012, 013 (ADR 017). Visibility:
 *  - PUBLIC channels: visible and joinable with chat.channels.public (employees, not subcontractors);
 *  - PRIVATE, GROUP and DM: members only;
 *  - chat.moderate (HR, admins) archives channels and removes messages, without reading private ones.
 * A channel a user may not see answers 404. Files are documents: the sender must be able to manage
 * them, they must be scanned clean and not confidential, and members receive a DOWNLOAD grant.
 */
@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AttendanceGateway,
    private readonly notifications: NotificationsService,
  ) {}

  private async channelFor(db: pg.PoolClient, user: AuthenticatedUser, channelId: string, opts: { write?: boolean; manage?: boolean } = {}): Promise<ChannelRow> {
    const r = (await db.query<ChannelRow>(
      `SELECT c.id, c.kind, c.name, c.topic, c.created_by, c.archived_at, cm.role AS member_role
       FROM channels c LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $2 WHERE c.id = $1`, [channelId, user.id],
    )).rows[0];
    const publicReader = r?.kind === 'PUBLIC' && userCan(user, Permission.CHAT_PUBLIC_CHANNELS);
    if (!r || (!r.member_role && !publicReader)) throw new NotFoundException('Channel not found');
    if (opts.write) {
      if (r.archived_at) throw new ConflictException('This channel is archived');
      if (!r.member_role) throw new ForbiddenException('Join the channel to post');
    }
    if (opts.manage && !(r.member_role === 'OWNER' || userCan(user, Permission.CHAT_MODERATE))) throw new ForbiddenException('Only the channel owner or a moderator can do this');
    return r;
  }

  private async members(db: pg.PoolClient, channelId: string): Promise<string[]> {
    return (await db.query<{ user_id: string }>(`SELECT user_id FROM channel_members WHERE channel_id = $1`, [channelId])).rows.map((r) => r.user_id);
  }

  private push(userIds: string[], e: ChatEvent): void {
    for (const u of userIds) this.gateway.notifyUser(u, 'chat:message', e as unknown as Record<string, unknown>);
  }

  async list(user: AuthenticatedUser): Promise<{ items: Channel[] }> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const res = await db.query<{ id: string; kind: ChannelKind; name: string; topic: string; archived_at: Date | null; role: string | null; last_read_at: Date | null; members: number; last_at: Date | null; unread: number; other_id: string | null; other_name: string | null }>(
        `SELECT c.id, c.kind, c.name, c.topic, c.archived_at, cm.role, cm.last_read_at,
                (SELECT count(*)::int FROM channel_members x WHERE x.channel_id = c.id) AS members,
                (SELECT max(m.created_at) FROM messages m WHERE m.channel_id = c.id) AS last_at,
                CASE WHEN cm.user_id IS NULL THEN 0 ELSE (SELECT count(*)::int FROM messages m WHERE m.channel_id = c.id AND m.created_at > cm.last_read_at AND m.author_id <> $1 AND m.deleted_at IS NULL AND m.parent_id IS NULL) END AS unread,
                o.id AS other_id, COALESCE(o.display_name, o.email) AS other_name
         FROM channels c
         LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $1
         LEFT JOIN LATERAL (SELECT u.id, u.display_name, u.email FROM channel_members x JOIN users u ON u.id = x.user_id WHERE c.kind = 'DM' AND x.channel_id = c.id AND x.user_id <> $1 LIMIT 1) o ON TRUE
         WHERE cm.user_id IS NOT NULL OR (c.kind = 'PUBLIC' AND $2::boolean AND c.archived_at IS NULL)
         ORDER BY last_at DESC NULLS LAST, c.name`,
        [user.id, userCan(user, Permission.CHAT_PUBLIC_CHANNELS)],
      );
      return {
        items: res.rows.map((r) => ({
          id: r.id, kind: r.kind, name: r.kind === 'DM' ? r.other_name ?? 'Direct message' : r.name || 'Group chat', topic: r.topic, memberCount: r.members,
          isMember: !!r.role, unread: r.unread, archived: !!r.archived_at, lastMessageAt: r.last_at?.toISOString() ?? null, otherUserId: r.other_id,
          canManage: r.role === 'OWNER' || userCan(user, Permission.CHAT_MODERATE),
        })),
      };
    });
  }

  async create(user: AuthenticatedUser, dto: ChannelCreateDto): Promise<{ id: string }> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const ensureUsers = async (ids: string[]) => {
        if (!ids.length) return;
        const found = await db.query<{ id: string }>(`SELECT id FROM users WHERE id = ANY($1::uuid[]) AND status = 'ACTIVE'`, [ids]);
        if (found.rows.length !== new Set(ids).size) throw new NotFoundException('Some people were not found');
      };
      if (dto.kind === 'DM') {
        if (dto.userId === user.id) throw new BadRequestException('Start a DM with someone else');
        await ensureUsers([dto.userId]);
        const key = [user.id, dto.userId].sort().join(':');
        const existing = await db.query<{ id: string }>(`SELECT id FROM channels WHERE dm_key = $1`, [key]);
        if (existing.rows[0]) return { id: existing.rows[0].id };
        const c = (await db.query<{ id: string }>(`INSERT INTO channels (org_id, kind, dm_key, created_by) VALUES ($1, 'DM', $2, $3) ON CONFLICT (org_id, dm_key) DO NOTHING RETURNING id`, [user.orgId, key, user.id])).rows[0];
        if (!c) return { id: (await db.query<{ id: string }>(`SELECT id FROM channels WHERE dm_key = $1`, [key])).rows[0]!.id };
        await db.query(`INSERT INTO channel_members (org_id, channel_id, user_id) VALUES ($1, $2, $3), ($1, $2, $4)`, [user.orgId, c.id, user.id, dto.userId]);
        return { id: c.id };
      }
      if (dto.kind === 'PUBLIC' && !userCan(user, Permission.CHAT_PUBLIC_CHANNELS)) throw new ForbiddenException('You cannot create public channels');
      const memberIds = dto.kind === 'PUBLIC' ? [] : [...new Set((dto.memberIds ?? []).filter((x) => x !== user.id))];
      await ensureUsers(memberIds);
      let id: string;
      try {
        id = (await db.query<{ id: string }>(`INSERT INTO channels (org_id, kind, name, topic, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [user.orgId, dto.kind, dto.name ?? '', 'topic' in dto ? dto.topic ?? '' : '', user.id])).rows[0]!.id;
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new ConflictException('A channel with this name exists');
        throw err;
      }
      await db.query(`INSERT INTO channel_members (org_id, channel_id, user_id, role) VALUES ($1, $2, $3, 'OWNER')`, [user.orgId, id, user.id]);
      for (const m of memberIds) await db.query(`INSERT INTO channel_members (org_id, channel_id, user_id) VALUES ($1, $2, $3)`, [user.orgId, id, m]);
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'CHANNEL_CREATED', entityType: 'CHANNEL', entityId: id, after: { kind: dto.kind, members: memberIds.length + 1 } });
      return { id };
    });
  }

  async join(user: AuthenticatedUser, channelId: string): Promise<{ ok: true }> {
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const c = await this.channelFor(db, user, channelId);
      if (c.kind !== 'PUBLIC') throw new ForbiddenException('Only public channels can be joined');
      if (c.archived_at) throw new ConflictException('This channel is archived');
      await db.query(`INSERT INTO channel_members (org_id, channel_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [user.orgId, channelId, user.id]);
      await this.grantChannelFiles(db, user, channelId, [user.id]);
    });
    return { ok: true };
  }

  async leave(user: AuthenticatedUser, channelId: string): Promise<{ ok: true }> {
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const c = await this.channelFor(db, user, channelId);
      if (c.kind === 'DM') throw new BadRequestException('Direct messages cannot be left');
      await db.query(`DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2`, [channelId, user.id]);
    });
    return { ok: true };
  }

  async setMembers(user: AuthenticatedUser, channelId: string, dto: MembersDto): Promise<{ ok: true }> {
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const c = await this.channelFor(db, user, channelId, { manage: true });
      if (c.kind === 'DM') throw new BadRequestException('Direct messages have exactly two people');
      const add = [...new Set(dto.add ?? [])];
      if (add.length) {
        const found = await db.query<{ id: string }>(`SELECT id FROM users WHERE id = ANY($1::uuid[]) AND status = 'ACTIVE'`, [add]);
        if (found.rows.length !== add.length) throw new NotFoundException('Some people were not found');
        for (const u of add) await db.query(`INSERT INTO channel_members (org_id, channel_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [user.orgId, channelId, u]);
        await this.grantChannelFiles(db, user, channelId, add);
      }
      if (dto.remove?.length) await db.query(`DELETE FROM channel_members WHERE channel_id = $1 AND user_id = ANY($2::uuid[]) AND role <> 'OWNER'`, [channelId, dto.remove]);
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'CHANNEL_MEMBERS_CHANGED', entityType: 'CHANNEL', entityId: channelId, after: { added: add.length, removed: dto.remove?.length ?? 0 } });
    });
    return { ok: true };
  }

  async archive(user: AuthenticatedUser, channelId: string): Promise<{ ok: true }> {
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const c = (await db.query<{ kind: string; created_by: string; role: string | null }>(
        `SELECT c.kind, c.created_by, cm.role FROM channels c LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $2 WHERE c.id = $1`, [channelId, user.id])).rows[0];
      if (!c || c.kind === 'DM') throw new NotFoundException('Channel not found');
      if (!(c.role === 'OWNER' || userCan(user, Permission.CHAT_MODERATE))) throw new ForbiddenException('Only the channel owner or a moderator can archive');
      await db.query(`UPDATE channels SET archived_at = now() WHERE id = $1 AND archived_at IS NULL`, [channelId]);
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'CHANNEL_ARCHIVED', entityType: 'CHANNEL', entityId: channelId });
    });
    return { ok: true };
  }

  async messages(user: AuthenticatedUser, channelId: string, q: MessageQuery): Promise<{ items: ChatMessage[]; hasMore: boolean }> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const c = await this.channelFor(db, user, channelId);
      const params: unknown[] = [channelId, q.limit + 1];
      let where = 'm.channel_id = $1';
      if (q.parentId) { params.push(q.parentId); where += ` AND (m.parent_id = $${params.length} OR m.id = $${params.length})`; }
      else where += ' AND m.parent_id IS NULL';
      if (q.before) { params.push(q.before); where += ` AND m.created_at < $${params.length}::timestamptz`; }
      const rows = (await db.query<MessageRow>(`${MESSAGE_SELECT} WHERE ${where} ORDER BY m.created_at ${q.parentId ? 'ASC' : 'DESC'} LIMIT $2`, params)).rows;
      const hasMore = rows.length > q.limit;
      const page = rows.slice(0, q.limit);
      if (c.member_role && !q.parentId && !q.before) await db.query(`UPDATE channel_members SET last_read_at = now() WHERE channel_id = $1 AND user_id = $2`, [channelId, user.id]);
      return { items: (q.parentId ? page : page.reverse()).map(mapMessage), hasMore };
    });
  }

  async post(user: AuthenticatedUser, channelId: string, dto: MessageDto): Promise<ChatMessage> {
    const { message, members, mentions, channelName } = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const c = await this.channelFor(db, user, channelId, { write: true });
      const members = await this.members(db, channelId);
      // Mentions only count for people who can read the channel.
      const mentions = mentionedIds(dto.body ?? '').filter((m) => members.includes(m) || c.kind === 'PUBLIC');
      if (dto.documentId) await this.attach(db, user, channelId, dto.documentId, members);
      let id: string;
      try {
        id = (await db.query<{ id: string }>(`INSERT INTO messages (org_id, channel_id, author_id, parent_id, body, mentions, document_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [user.orgId, channelId, user.id, dto.parentId ?? null, dto.body ?? '', mentions, dto.documentId ?? null])).rows[0]!.id;
      } catch (err) {
        if (/a reply must answer/.test((err as Error).message)) throw new BadRequestException('Replies answer a top-level message of the same channel');
        throw err;
      }
      await db.query(`UPDATE channel_members SET last_read_at = now() WHERE channel_id = $1 AND user_id = $2`, [channelId, user.id]);
      const message = mapMessage((await db.query<MessageRow>(`${MESSAGE_SELECT} WHERE m.id = $1`, [id])).rows[0]!);
      return { message, members, mentions, channelName: c.kind === 'DM' ? 'a direct message' : c.name || 'a group chat' };
    });
    this.push(members, { type: 'message', channelId, message });
    // FR-MEET-012 mentions reach people as notifications (not the author).
    const notify = mentions.filter((m) => m !== user.id);
    if (notify.length) {
      await this.notifications.notify(user.orgId, notify.map((userId) => ({
        userId, type: 'CHAT_MENTION' as const, title: `${message.author.displayName ?? message.author.email} mentioned you in ${channelName}`,
        body: message.body.replace(/@\[([^\]]+)\]\(user:[0-9a-f-]{36}\)/g, '@$1').slice(0, 280), link: `/chat?channel=${channelId}`, entityType: 'CHANNEL', entityId: channelId,
      })));
    }
    return message;
  }

  /** FR-MEET-013: a clean, non-confidential document the sender manages; every member may download it. */
  private async attach(db: pg.PoolClient, user: AuthenticatedUser, channelId: string, documentId: string, members: string[]): Promise<void> {
    const doc = await loadDocument(db, user, documentId, LEVEL.MANAGE);
    if (doc.current_status !== 'CLEAN') throw new ConflictException(doc.current_status === 'PENDING' || doc.current_status === 'UPLOADING' ? 'The file is still being scanned' : 'This file did not pass the virus scan');
    if (doc.confidentiality !== 'NORMAL') throw new ForbiddenException('Confidential documents cannot be shared in chat');
    if (doc.password_protected) throw new ForbiddenException('Password-protected documents cannot be shared in chat');
    await this.grant(db, user, documentId, members.filter((m) => m !== user.id));
    await logAccess(db, { orgId: user.orgId, documentId, userId: user.id, action: 'SHARE', ctx: { ip: null, userAgent: null }, detail: { via: 'CHAT', channelId, members: members.length } });
  }

  private async grant(db: pg.PoolClient, user: AuthenticatedUser, documentId: string, userIds: string[]): Promise<void> {
    for (const u of userIds) {
      await db.query(
        `INSERT INTO document_acl (org_id, document_id, principal_type, principal_id, permission, granted_by) VALUES ($1, $2, 'USER', $3, 'DOWNLOAD', $4) ON CONFLICT DO NOTHING`,
        [user.orgId, documentId, u, user.id],
      );
    }
  }

  /** People who join later get the channel's files too. */
  private async grantChannelFiles(db: pg.PoolClient, user: AuthenticatedUser, channelId: string, userIds: string[]): Promise<void> {
    const docs = (await db.query<{ document_id: string; author_id: string }>(`SELECT DISTINCT document_id, author_id FROM messages WHERE channel_id = $1 AND document_id IS NOT NULL AND deleted_at IS NULL`, [channelId])).rows;
    for (const d of docs) {
      for (const u of userIds) {
        if (u === d.author_id) continue;
        await db.query(`INSERT INTO document_acl (org_id, document_id, principal_type, principal_id, permission, granted_by) VALUES ($1, $2, 'USER', $3, 'DOWNLOAD', $4) ON CONFLICT DO NOTHING`, [user.orgId, d.document_id, u, d.author_id]);
      }
    }
  }

  async edit(user: AuthenticatedUser, messageId: string, body: string): Promise<ChatMessage> {
    const { message, members } = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const m = (await db.query<{ channel_id: string; author_id: string; deleted_at: Date | null }>(`SELECT channel_id, author_id, deleted_at FROM messages WHERE id = $1 FOR UPDATE`, [messageId])).rows[0];
      if (!m) throw new NotFoundException('Message not found');
      await this.channelFor(db, user, m.channel_id, { write: true });
      if (m.author_id !== user.id) throw new ForbiddenException('Only the author can edit a message');
      if (m.deleted_at) throw new ConflictException('This message was deleted');
      const members = await this.members(db, m.channel_id);
      await db.query(`UPDATE messages SET body = $2, mentions = $3, edited_at = now() WHERE id = $1`, [messageId, body, mentionedIds(body).filter((x) => members.includes(x))]);
      return { message: mapMessage((await db.query<MessageRow>(`${MESSAGE_SELECT} WHERE m.id = $1`, [messageId])).rows[0]!), members };
    });
    this.push(members, { type: 'edit', channelId: message.channelId, message });
    return message;
  }

  async remove(user: AuthenticatedUser, messageId: string): Promise<ChatMessage> {
    const { message, members } = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const m = (await db.query<{ channel_id: string; author_id: string }>(`SELECT channel_id, author_id FROM messages WHERE id = $1 FOR UPDATE`, [messageId])).rows[0];
      if (!m) throw new NotFoundException('Message not found');
      const moderator = userCan(user, Permission.CHAT_MODERATE);
      if (m.author_id !== user.id && !moderator) { await this.channelFor(db, user, m.channel_id); throw new ForbiddenException('Only the author or a moderator can delete a message'); }
      if (m.author_id === user.id) await this.channelFor(db, user, m.channel_id);
      await db.query(`UPDATE messages SET body = '', mentions = '{}', deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [messageId]);
      if (m.author_id !== user.id) await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'CHAT_MESSAGE_REMOVED', entityType: 'MESSAGE', entityId: messageId, after: { authorId: m.author_id } });
      return { message: mapMessage((await db.query<MessageRow>(`${MESSAGE_SELECT} WHERE m.id = $1`, [messageId])).rows[0]!), members: await this.members(db, m.channel_id) };
    });
    this.push(members, { type: 'delete', channelId: message.channelId, message });
    return message;
  }

  /** FR-MEET-012 search: only channels the user can read. */
  async search(user: AuthenticatedUser, q: string, limit: number) {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const rows = (await db.query<MessageRow & { channel_name: string; kind: ChannelKind }>(
        `${MESSAGE_SELECT.replace('SELECT m.id', 'SELECT c.name AS channel_name, c.kind, m.id')}
         JOIN channels c ON c.id = m.channel_id
         LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $2
         WHERE m.search @@ plainto_tsquery('simple', $1) AND m.deleted_at IS NULL
           AND (cm.user_id IS NOT NULL OR (c.kind = 'PUBLIC' AND $3::boolean))
         ORDER BY ts_rank(m.search, plainto_tsquery('simple', $1)) DESC, m.created_at DESC LIMIT $4`,
        [q, user.id, userCan(user, Permission.CHAT_PUBLIC_CHANNELS), limit],
      )).rows;
      return { items: rows.map((r) => ({ ...mapMessage(r), channelName: r.kind === 'DM' ? 'Direct message' : r.channel_name || 'Group chat' })) };
    });
  }
}
