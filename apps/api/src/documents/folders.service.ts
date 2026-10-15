import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import type { AccessLogEntry, AccessLogQuery, Folder, FolderDto, ShareTargets } from '../../../../packages/shared/src/documents/types.ts';
import { UserRole } from '../../../../packages/shared/src/auth/types.ts';
import { toCsv } from '../common/export-format.ts';
import { toIso, userRef } from '../tasks/tasks.sql.ts';
import { LEVEL } from './document-policy.ts';
import { docActor, folderLevelSql, levelSql } from './documents.sql.ts';

const MAX_DEPTH = 8;

/** FR-DOC-002 folder tree, and FR-DOC-012 access-log queries. */
@Injectable()
export class FoldersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Folders the user can see (HR: all; others: through a grant on it or an ancestor). */
  async list(user: AuthenticatedUser): Promise<{ items: Folder[]; canCreateTopLevel: boolean }> {
    const a = docActor(user);
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const params: unknown[] = [];
      const level = folderLevelSql(a, params, 'f.id');
      const res = await db.query<{ id: string; name: string; parent_id: string | null; level: number }>(
        `SELECT * FROM (SELECT f.id, f.name, f.parent_id, ${level} AS level FROM document_folders f) x WHERE x.level > 0 ORDER BY lower(x.name)`,
        params,
      );
      return {
        items: res.rows.map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id, canEdit: r.level >= LEVEL.EDIT, canManage: r.level >= LEVEL.MANAGE })),
        canCreateTopLevel: a.isHr,
      };
    });
  }

  async create(user: AuthenticatedUser, dto: FolderDto): Promise<Folder> {
    const a = docActor(user);
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      if (dto.parentId) {
        const params: unknown[] = [dto.parentId];
        const level = folderLevelSql(a, params, '$1::uuid');
        const p = await db.query<{ level: number }>(`SELECT ${level} AS level FROM document_folders WHERE id = $1`, params);
        if (!p.rows[0] || p.rows[0].level < LEVEL.VIEW) throw new NotFoundException('Parent folder not found');
        if (p.rows[0].level < LEVEL.MANAGE) throw new ForbiddenException('You do not manage the parent folder');
        const depth = await db.query<{ d: number }>(
          `WITH RECURSIVE up(id, d) AS (SELECT $1::uuid, 1 UNION ALL SELECT f.parent_id, up.d + 1 FROM document_folders f JOIN up ON f.id = up.id WHERE f.parent_id IS NOT NULL AND up.d < 32)
           SELECT MAX(d) AS d FROM up`,
          [dto.parentId],
        );
        if ((depth.rows[0]?.d ?? 0) >= MAX_DEPTH) throw new BadRequestException(`Folders nest at most ${MAX_DEPTH} levels deep`);
      } else if (!a.isHr) {
        throw new ForbiddenException('Only HR creates top-level folders');
      }
      try {
        const res = await db.query<{ id: string }>(
          `INSERT INTO document_folders (org_id, parent_id, name, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
          [user.orgId, dto.parentId ?? null, dto.name.trim(), user.id],
        );
        return { id: res.rows[0]!.id, name: dto.name.trim(), parentId: dto.parentId ?? null, canEdit: true, canManage: true };
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new ConflictException('A folder with this name already exists here');
        throw err;
      }
    });
  }

  async remove(user: AuthenticatedUser, id: string): Promise<{ deleted: true }> {
    const a = docActor(user);
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const params: unknown[] = [id];
      const level = folderLevelSql(a, params, '$1::uuid');
      const f = await db.query<{ level: number }>(`SELECT ${level} AS level FROM document_folders WHERE id = $1`, params);
      if (!f.rows[0] || f.rows[0].level < LEVEL.VIEW) throw new NotFoundException('Folder not found');
      if (f.rows[0].level < LEVEL.MANAGE) throw new ForbiddenException('You do not manage this folder');
      const busy = await db.query(
        `SELECT 1 FROM document_folders WHERE parent_id = $1 UNION ALL SELECT 1 FROM documents WHERE folder_id = $1 AND deleted_at IS NULL LIMIT 1`,
        [id],
      );
      if ((busy.rowCount ?? 0) > 0) throw new ConflictException('Only empty folders can be deleted');
      await db.query(`UPDATE documents SET folder_id = NULL WHERE folder_id = $1`, [id]);
      await db.query(`DELETE FROM document_folders WHERE id = $1`, [id]);
      return { deleted: true as const };
    });
  }

  /**
   * FR-DOC-012: the access trail. Per document for its managers; org-wide for audit readers.
   * CSV export is formula-injection safe.
   */
  async accessLog(user: AuthenticatedUser, q: AccessLogQuery, orgWide: boolean): Promise<{ items: AccessLogEntry[] }> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const params: unknown[] = [user.orgId];
      const where = ['l.org_id = $1'];
      if (q.documentId) {
        params.push(q.documentId);
        where.push(`l.document_id = $${params.length}`);
        if (!orgWide) {
          const p2: unknown[] = [q.documentId];
          const level = levelSql(docActor(user), p2);
          const d = await db.query<{ level: number }>(`SELECT ${level} AS level FROM documents d WHERE d.id = $1`, p2);
          if (!d.rows[0] || d.rows[0].level < LEVEL.VIEW) throw new NotFoundException('Document not found');
          if (d.rows[0].level < LEVEL.MANAGE) throw new ForbiddenException('Only managers of this document see its access log');
        }
      } else if (!orgWide) {
        throw new ForbiddenException('The organisation-wide access log needs audit access');
      }
      if (q.userId) {
        params.push(q.userId);
        where.push(`l.user_id = $${params.length}`);
      }
      if (q.action) {
        params.push(q.action);
        where.push(`l.action = $${params.length}`);
      }
      if (q.from) {
        params.push(q.from);
        where.push(`l.created_at >= $${params.length}::date`);
      }
      if (q.to) {
        params.push(q.to);
        where.push(`l.created_at < $${params.length}::date + 1`);
      }
      params.push(q.limit);
      const res = await db.query<{ id: string; document_id: string | null; title: string | null; version_no: number | null; user_id: string | null; display_name: string | null; email: string | null; role: string | null; action: AccessLogEntry['action']; ip: string | null; user_agent: string | null; detail: Record<string, unknown> | null; created_at: Date }>(
        `SELECT l.id::text AS id, l.document_id, d.title, v.version_no, l.user_id, u.display_name, u.email, u.role, l.action, l.ip, l.user_agent, l.detail, l.created_at
         FROM document_access_logs l
         LEFT JOIN documents d ON d.id = l.document_id
         LEFT JOIN document_versions v ON v.id = l.version_id
         LEFT JOIN users u ON u.id = l.user_id
         WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT $${params.length}`,
        params,
      );
      return {
        items: res.rows.map((r) => ({
          id: r.id, documentId: r.document_id, documentTitle: r.title, versionNo: r.version_no,
          user: r.user_id && r.email ? userRef(r.user_id, r.display_name, r.email, r.role) : null,
          action: r.action, ip: r.ip, userAgent: r.user_agent, detail: r.detail, createdAt: toIso(r.created_at)!,
        })),
      };
    });
  }

  /**
   * People, teams and roles a document can be shared with. Subcontractors only see HR, their
   * manager and their team's leads (they do not get the staff directory).
   */
  async shareTargets(user: AuthenticatedUser): Promise<ShareTargets> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const sub = user.role === 'SUBCONTRACTOR';
      const users = await db.query<{ id: string; display_name: string | null; email: string; role: string }>(
        sub
          ? `SELECT u.id, u.display_name, u.email, u.role FROM users u, users me
             WHERE me.id = $1 AND u.status = 'ACTIVE' AND u.id <> me.id
               AND (u.role IN ('HR', 'HR_MANAGER') OR u.id = me.manager_id OR (u.team_id = me.team_id AND u.role IN ('TEAM_LEAD', 'MANAGER')))
             ORDER BY u.display_name NULLS LAST, u.email`
          : `SELECT id, display_name, email, role FROM users WHERE status = 'ACTIVE' AND id <> $1 ORDER BY display_name NULLS LAST, email`,
        [user.id],
      );
      const teams = sub ? { rows: [] } : await db.query<{ id: string; name: string }>(`SELECT id, name FROM teams ORDER BY name`);
      return {
        users: users.rows.map((r) => userRef(r.id, r.display_name, r.email, r.role)),
        teams: teams.rows,
        roles: sub ? [] : Object.values(UserRole),
      };
    });
  }

  accessLogCsv(items: AccessLogEntry[]): string {
    return toCsv(
      ['Time (UTC)', 'Action', 'Document', 'Version', 'User', 'IP', 'User agent', 'Detail'],
      items.map((e) => [e.createdAt, e.action, e.documentTitle ?? e.documentId ?? '', e.versionNo, e.user ? (e.user.displayName ?? e.user.email) : 'system', e.ip ?? '', e.userAgent ?? '', e.detail ? JSON.stringify(e.detail) : '']),
    );
  }
}
