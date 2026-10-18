/**
 * Teams and the manager hierarchy (FR-ORG-006; ADR 031).
 *
 * Changes take a per-organisation advisory lock, so two placements running at the same time
 * cannot build a cycle that neither would build alone. A person's team is also a claim in their
 * access token: like a role change, a move takes effect at the next token refresh (at most 15
 * minutes), and every change is in the audit log.
 */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import { PrismaService } from '../common/prisma.service.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import type { RequestContext } from '../common/decorators/request-context.decorator.ts';
import type { AuthenticatedUser, OrgStructure, OrgTeam, PlacementDto, TeamDto, TeamUpdateDto } from '../../../../packages/shared/src/index.ts';

interface TeamRow { id: string; name: string; lead_id: string | null; lead_name: string | null; lead_email: string | null; member_count: number }
const TEAM_SELECT = `SELECT t.id, t.name, t.lead_id, l.display_name AS lead_name, l.email AS lead_email,
    (SELECT count(*)::int FROM users m WHERE m.team_id = t.id AND m.status <> 'OFFBOARDED') AS member_count
  FROM teams t LEFT JOIN users l ON l.id = t.lead_id`;
const toTeam = (r: TeamRow): OrgTeam => ({
  id: r.id, name: r.name, memberCount: r.member_count,
  lead: r.lead_id ? { id: r.lead_id, displayName: r.lead_name, email: r.lead_email ?? '' } : null,
});

@Injectable()
export class OrgService {
  constructor(private readonly prisma: PrismaService) {}

  async structure(user: AuthenticatedUser): Promise<OrgStructure> {
    return this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const teams = (await db.query<TeamRow>(`${TEAM_SELECT} ORDER BY lower(t.name)`)).rows.map(toTeam);
      const people = (await db.query<{ id: string; display_name: string | null; email: string; role: string; status: string; team_id: string | null; manager_id: string | null }>(
        `SELECT id, display_name, email, role, status, team_id, manager_id FROM users
         WHERE anonymised_at IS NULL ORDER BY lower(coalesce(display_name, email))`,
      )).rows.map((p) => ({ id: p.id, displayName: p.display_name, email: p.email, role: p.role, status: p.status, teamId: p.team_id, managerId: p.manager_id }));
      return { teams, people };
    });
  }

  async createTeam(user: AuthenticatedUser, dto: TeamDto, ctx: RequestContext): Promise<OrgTeam> {
    return this.write(user, async (db) => {
      if (dto.leadId) await this.activePerson(db, dto.leadId, 'lead');
      const id = (await db.query<{ id: string }>(`INSERT INTO teams (org_id, name, lead_id) VALUES ($1, $2, $3) RETURNING id`, [user.orgId, dto.name, dto.leadId ?? null])).rows[0]!.id;
      const team = await this.team(db, id);
      await this.audit(db, user, ctx, 'TEAM_CREATED', 'TEAM', id, null, { name: team.name, leadId: team.lead?.id ?? null });
      return team;
    });
  }

  async updateTeam(user: AuthenticatedUser, id: string, dto: TeamUpdateDto, ctx: RequestContext): Promise<OrgTeam> {
    return this.write(user, async (db) => {
      const before = await this.team(db, id);
      if (dto.leadId) await this.activePerson(db, dto.leadId, 'lead');
      await db.query(`UPDATE teams SET name = coalesce($2, name), lead_id = CASE WHEN $3 THEN $4::uuid ELSE lead_id END WHERE id = $1`,
        [id, dto.name ?? null, dto.leadId !== undefined, dto.leadId ?? null]);
      const after = await this.team(db, id);
      await this.audit(db, user, ctx, 'TEAM_UPDATED', 'TEAM', id, { name: before.name, leadId: before.lead?.id ?? null }, { name: after.name, leadId: after.lead?.id ?? null });
      return after;
    });
  }

  /** Only an empty team can be removed: its members' approvals and schedules would change silently otherwise. */
  async deleteTeam(user: AuthenticatedUser, id: string, ctx: RequestContext): Promise<{ deleted: true }> {
    return this.write(user, async (db) => {
      const before = await this.team(db, id);
      const members = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE team_id = $1`, [id])).rows[0]!.n;
      if (members > 0) throw new ConflictException(`Move the team's ${members} ${members === 1 ? 'member' : 'members'} to another team first`);
      await db.query(`DELETE FROM teams WHERE id = $1`, [id]);
      await this.audit(db, user, ctx, 'TEAM_DELETED', 'TEAM', id, { name: before.name, leadId: before.lead?.id ?? null }, null);
      return { deleted: true as const };
    });
  }

  async setPlacement(user: AuthenticatedUser, personId: string, dto: PlacementDto, ctx: RequestContext): Promise<OrgStructure['people'][number]> {
    await this.write(user, async (db) => {
      const person = (await db.query<{ id: string; team_id: string | null; manager_id: string | null }>(
        `SELECT id, team_id, manager_id FROM users WHERE id = $1 AND anonymised_at IS NULL`, [personId])).rows[0];
      if (!person) throw new NotFoundException('Person not found');
      if (dto.teamId) await this.team(db, dto.teamId);
      if (dto.managerId) {
        if (dto.managerId === personId) throw new BadRequestException('A person cannot be their own manager');
        await this.activePerson(db, dto.managerId, 'manager');
        // Everyone who reports to this person, directly or through others, cannot become their manager.
        const loop = await db.query(
          `WITH RECURSIVE below AS (SELECT id FROM users WHERE manager_id = $1
             UNION SELECT u.id FROM users u JOIN below b ON u.manager_id = b.id)
           SELECT 1 FROM below WHERE id = $2`,
          [personId, dto.managerId],
        );
        if (loop.rowCount) throw new BadRequestException('That manager already reports to this person; the hierarchy cannot loop');
      }
      await db.query(`UPDATE users SET team_id = $2, manager_id = $3 WHERE id = $1`, [personId, dto.teamId, dto.managerId]);
      await this.audit(db, user, ctx, 'USER_PLACEMENT_CHANGED', 'USER', personId,
        { teamId: person.team_id, managerId: person.manager_id }, { teamId: dto.teamId, managerId: dto.managerId });
    });
    const row = (await this.structure(user)).people.find((p) => p.id === personId);
    if (!row) throw new NotFoundException('Person not found');
    return row;
  }

  // ---------------------------------------------------------------- helpers

  private write<T>(user: AuthenticatedUser, fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
    return this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await db.query(`SELECT pg_advisory_xact_lock(hashtext('org-structure:' || $1::text))`, [user.orgId]);
      try {
        return await fn(db);
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new ConflictException('A team with this name already exists');
        throw err;
      }
    });
  }

  private async team(db: pg.PoolClient, id: string): Promise<OrgTeam> {
    const row = (await db.query<TeamRow>(`${TEAM_SELECT} WHERE t.id = $1`, [id])).rows[0];
    if (!row) throw new NotFoundException('Team not found');
    return toTeam(row);
  }

  private async activePerson(db: pg.PoolClient, id: string, what: 'lead' | 'manager'): Promise<void> {
    const row = (await db.query<{ status: string }>(`SELECT status FROM users WHERE id = $1 AND anonymised_at IS NULL`, [id])).rows[0];
    if (!row) throw new NotFoundException(`The chosen ${what} was not found`);
    if (row.status !== 'ACTIVE') throw new BadRequestException(`The chosen ${what} is not an active user`);
  }

  private audit(db: pg.PoolClient, user: AuthenticatedUser, ctx: RequestContext, action: string, entityType: string, entityId: string, before: unknown, after: unknown): Promise<void> {
    return appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action, entityType, entityId, before, after, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined });
  }
}
