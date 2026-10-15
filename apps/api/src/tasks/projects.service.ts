import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import { PrismaService } from '../common/prisma.service.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import { hasPermission, Permission } from '../../../../packages/shared/src/auth/types.ts';
import type { Project, ProjectDto, ProjectUpdateDto, UserRef } from '../../../../packages/shared/src/tasks/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import { userRef } from './tasks.sql.ts';

type Client = pg.PoolClient;

const PROJECT_SELECT = `
  SELECT pr.id, pr.name, pr.code, pr.client_name, pr.billable, pr.status,
         to_char(pr.start_date, 'YYYY-MM-DD') AS start_date, to_char(pr.end_date, 'YYYY-MM-DD') AS end_date,
         m.id AS m_id, m.display_name AS m_name, m.email AS m_email, m.role AS m_role,
         (SELECT count(*) FROM project_members pm WHERE pm.project_id = pr.id)::int AS member_count,
         EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = pr.id AND pm.user_id = $2) AS is_member
  FROM projects pr LEFT JOIN users m ON m.id = pr.manager_id`;

function mapProject(r: pg.QueryResultRow): Project {
  return {
    id: r.id,
    name: r.name,
    code: r.code,
    clientName: r.client_name ?? null,
    manager: r.m_id ? userRef(r.m_id, r.m_name, r.m_email, r.m_role) : null,
    billable: r.billable,
    status: r.status,
    startDate: r.start_date ?? null,
    endDate: r.end_date ?? null,
    memberCount: r.member_count,
    isMember: r.is_member === true,
  };
}

/** Minimal project administration for the TASK slice (full ORG features come later). */
@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  private managesAll(user: AuthenticatedUser): boolean {
    return hasPermission(user.role, Permission.PROJECTS_MANAGE) || hasPermission(user.role, Permission.TASKS_READ_ALL);
  }

  /** HR/managers see all projects; everyone else sees projects they belong to or manage. */
  async list(user: AuthenticatedUser): Promise<Project[]> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const res = await db.query(
        `${PROJECT_SELECT}
         WHERE pr.org_id = $1 AND ($3::boolean OR pr.manager_id = $2
               OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = pr.id AND pm.user_id = $2))
         ORDER BY pr.status = 'ARCHIVED', pr.name`,
        [user.orgId, user.id, this.managesAll(user)],
      );
      return res.rows.map(mapProject);
    });
  }

  async create(user: AuthenticatedUser, dto: ProjectDto): Promise<Project> {
    if (!hasPermission(user.role, Permission.PROJECTS_MANAGE)) throw new ForbiddenException('You cannot create projects');
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      if (dto.managerId) await this.assertActiveUser(db, user.orgId, dto.managerId);
      try {
        const res = await db.query<{ id: string }>(
          `INSERT INTO projects (org_id, name, code, client_name, manager_id, billable, status, start_date, end_date, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [user.orgId, dto.name, dto.code, dto.clientName ?? null, dto.managerId ?? null, dto.billable, dto.status,
            dto.startDate ?? null, dto.endDate ?? null, user.id],
        );
        const id = res.rows[0]!.id;
        await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'PROJECT_CREATED', entityType: 'PROJECT', entityId: id, after: { code: dto.code, name: dto.name } });
        return await this.getIn(db, user, id);
      } catch (err) {
        throw this.mapDbError(err);
      }
    });
  }

  async update(user: AuthenticatedUser, projectId: string, dto: ProjectUpdateDto): Promise<Project> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await this.assertCanAdminister(db, user, projectId);
      if (dto.managerId) await this.assertActiveUser(db, user.orgId, dto.managerId);
      const map: Record<string, string> = {
        name: 'name', code: 'code', clientName: 'client_name', managerId: 'manager_id', billable: 'billable',
        status: 'status', startDate: 'start_date', endDate: 'end_date',
      };
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [k, col] of Object.entries(map)) {
        const value = (dto as Record<string, unknown>)[k];
        if (value === undefined) continue;
        params.push(value);
        sets.push(`${col} = $${params.length}`);
      }
      if (sets.length === 0) throw new BadRequestException('Nothing to update');
      params.push(projectId, user.orgId);
      try {
        await db.query(`UPDATE projects SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length - 1} AND org_id = $${params.length}`, params);
      } catch (err) {
        throw this.mapDbError(err);
      }
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'PROJECT_UPDATED', entityType: 'PROJECT', entityId: projectId, after: dto });
      return await this.getIn(db, user, projectId);
    });
  }

  async members(user: AuthenticatedUser, projectId: string): Promise<UserRef[]> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await this.getIn(db, user, projectId); // visibility
      const res = await db.query(
        `SELECT u.id, u.display_name, u.email, u.role FROM project_members pm JOIN users u ON u.id = pm.user_id
         WHERE pm.project_id = $1 ORDER BY u.display_name NULLS LAST, u.email`,
        [projectId],
      );
      return res.rows.map((u) => userRef(u.id, u.display_name, u.email, u.role));
    });
  }

  async addMember(user: AuthenticatedUser, projectId: string, memberId: string): Promise<UserRef[]> {
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await this.assertCanAdminister(db, user, projectId);
      await this.assertActiveUser(db, user.orgId, memberId);
      const res = await db.query(
        `INSERT INTO project_members (org_id, project_id, user_id, added_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id, user_id) DO NOTHING`,
        [user.orgId, projectId, memberId, user.id],
      );
      if (res.rowCount) {
        // Membership grants visibility of the project's tasks: audit it.
        await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'PROJECT_MEMBER_ADDED', entityType: 'PROJECT', entityId: projectId, after: { userId: memberId } });
      }
    });
    return await this.members(user, projectId);
  }

  async removeMember(user: AuthenticatedUser, projectId: string, memberId: string): Promise<UserRef[]> {
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await this.assertCanAdminister(db, user, projectId);
      const res = await db.query(`DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`, [projectId, memberId]);
      if (res.rowCount) {
        await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'PROJECT_MEMBER_REMOVED', entityType: 'PROJECT', entityId: projectId, before: { userId: memberId } });
      }
    });
    return await this.members(user, projectId);
  }

  /** People who can be added to projects (org directory for project admins only). */
  async candidates(user: AuthenticatedUser): Promise<UserRef[]> {
    if (!hasPermission(user.role, Permission.PROJECTS_MANAGE)) throw new ForbiddenException('You cannot manage projects');
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const res = await db.query(
        `SELECT id, display_name, email, role FROM users WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY display_name NULLS LAST, email`,
        [user.orgId],
      );
      return res.rows.map((u) => userRef(u.id, u.display_name, u.email, u.role));
    });
  }

  private async getIn(db: Client, user: AuthenticatedUser, projectId: string): Promise<Project> {
    const res = await db.query(
      `${PROJECT_SELECT}
       WHERE pr.org_id = $1 AND pr.id = $4 AND ($3::boolean OR pr.manager_id = $2
             OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = pr.id AND pm.user_id = $2))`,
      [user.orgId, user.id, this.managesAll(user), projectId],
    );
    if (res.rows.length === 0) throw new NotFoundException('Project not found');
    return mapProject(res.rows[0]!);
  }

  private async assertCanAdminister(db: Client, user: AuthenticatedUser, projectId: string): Promise<void> {
    const res = await db.query(`SELECT manager_id FROM projects WHERE org_id = $1 AND id = $2`, [user.orgId, projectId]);
    if (res.rows.length === 0) throw new NotFoundException('Project not found');
    if (!hasPermission(user.role, Permission.PROJECTS_MANAGE) && res.rows[0]!.manager_id !== user.id) {
      throw new ForbiddenException('Only project admins or the project manager can change this project');
    }
  }

  private async assertActiveUser(db: Client, orgId: string, userId: string): Promise<void> {
    const res = await db.query(`SELECT 1 FROM users WHERE org_id = $1 AND id = $2 AND status = 'ACTIVE'`, [orgId, userId]);
    if (res.rows.length === 0) throw new BadRequestException('User must be an active member of your organisation');
  }

  private mapDbError(err: unknown): unknown {
    const code = (err as { code?: string }).code;
    if (code === '23505') return new ConflictException('A project with this code already exists');
    if (code === '23514') return new BadRequestException('Project dates or status are invalid');
    return err;
  }
}
