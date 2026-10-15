import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type pg from 'pg';
import { PrismaService } from '../common/prisma.service.ts';
import { hasPermission, Permission } from '../../../../packages/shared/src/auth/types.ts';
import {
  canTransition,
  extractMentionIds,
} from '../../../../packages/shared/src/tasks/types.ts';
import type {
  AcceptanceStatus,
  AttachmentDto,
  CreateTaskDto,
  TaskActivity,
  TaskActivityType,
  TaskComment,
  TaskDetail,
  TaskListQuery,
  TaskStatus,
  TaskSummary,
  UpdateTaskDto,
  UserRef,
} from '../../../../packages/shared/src/tasks/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import { canAssignTo, requiresAcceptance, seesAllTasks, taskPermissions } from './task-policy.ts';
import type { TaskActor, TaskFacts } from './task-policy.ts';
import { ACTUAL_TIME_PROVIDER, isOverrun } from './actual-time.ts';
import type { ActualTimeProvider } from './actual-time.ts';
import { TaskEvents } from './task-events.ts';
import type { TaskEventMap } from './task-events.ts';
import {
  READ_ALL_ROLES,
  READ_TEAM_ROLES,
  SUMMARY_COLUMNS,
  SUMMARY_FROM,
  mapSummary,
  teamScopeSql,
  toIso,
  userRef,
  viewerParams,
  visibleTo,
} from './tasks.sql.ts';

type Client = pg.PoolClient;
type PendingEvent = { [K in keyof TaskEventMap]: { name: K; payload: TaskEventMap[K] } }[keyof TaskEventMap];

export function actorOf(user: AuthenticatedUser): TaskActor {
  return { id: user.id, role: user.role, teamId: user.teamId ?? null };
}

interface LockedTask {
  id: string;
  title: string;
  status: TaskStatus;
  projectId: string | null;
  assigneeId: string | null;
  reporterId: string;
  acceptanceStatus: AcceptanceStatus;
  version: number;
  facts: TaskFacts;
  /** Previous values of editable fields, for the activity log. */
  before: Record<string, unknown>;
}

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: TaskEvents,
    @Inject(ACTUAL_TIME_PROVIDER) private readonly actualTime: ActualTimeProvider,
  ) {}

  // ---------------------------------------------------------------- queries

  async list(user: AuthenticatedUser, q: TaskListQuery): Promise<TaskSummary[]> {
    const actor = actorOf(user);
    const v = viewerParams(actor, 2);
    const params: unknown[] = [user.orgId, ...v.params];
    const where: string[] = ['t.org_id = $1', 't.deleted_at IS NULL', v.sql];
    const add = (sql: (n: string) => string, value: unknown) => {
      params.push(value);
      where.push(sql(`$${params.length}`));
    };

    switch (q.scope) {
      case 'mine':
        add((n) => `t.assignee_id = ${n}::uuid`, actor.id);
        break;
      case 'reported':
        add((n) => `t.reporter_id = ${n}::uuid`, actor.id);
        break;
      case 'team':
        if (!hasPermission(actor.role, Permission.TASKS_READ_TEAM)) {
          throw new ForbiddenException('Team view is for team leads, managers and HR');
        }
        if (!seesAllTasks(actor)) {
          params.push(actor.id, actor.teamId);
          where.push(teamScopeSql(`$${params.length - 1}`, `$${params.length}`));
        }
        break;
      case 'all':
        break;
    }
    if (q.status) add((n) => `t.status = ${n}`, q.status);
    if (!q.includeDone) where.push(`t.status <> 'DONE'`);
    if (q.projectId) add((n) => `t.project_id = ${n}::uuid`, q.projectId);
    if (q.assigneeId) add((n) => `t.assignee_id = ${n}::uuid`, q.assigneeId);
    if (q.priority) add((n) => `t.priority = ${n}`, q.priority);
    if (q.label) add((n) => `${n} = ANY(t.labels)`, q.label);
    if (q.dueFrom) add((n) => `t.due_date >= ${n}::date`, q.dueFrom);
    if (q.dueTo) add((n) => `t.due_date <= ${n}::date`, q.dueTo);
    if (q.plannedFrom) add((n) => `t.planned_date >= ${n}::date`, q.plannedFrom);
    if (q.plannedTo) add((n) => `t.planned_date <= ${n}::date`, q.plannedTo);
    if (q.q) add((n) => `t.title ILIKE ${n}`, `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    params.push(q.limit);

    const rows = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const res = await db.query(
        `SELECT ${SUMMARY_COLUMNS} ${SUMMARY_FROM}
         WHERE ${where.join(' AND ')}
         ORDER BY t.due_date ASC NULLS LAST,
                  CASE t.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
                  t.created_at ASC
         LIMIT $${params.length}`,
        params,
      );
      return res.rows;
    });
    const actual = await this.actualTime.actualMinutes(user.orgId, rows.map((r) => r.id as string));
    return rows.map((r) => mapSummary(r, actual.get(r.id) ?? null));
  }

  async get(user: AuthenticatedUser, taskId: string): Promise<TaskDetail> {
    const actor = actorOf(user);
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const row = await this.loadVisibleRow(db, user.orgId, actor, taskId);
      const facts = this.factsFromRow(row, actor);
      const [checklist, subtasks, attachments] = await Promise.all([
        db.query(
          `SELECT id, text, done, sort_order FROM task_checklist_items WHERE task_id = $1 ORDER BY sort_order, created_at`,
          [taskId],
        ),
        this.visibleSubtasks(db, user.orgId, actor, taskId),
        db.query(
          `SELECT ta.id, ta.name, ta.url, ta.mime_type, ta.size_bytes, ta.created_at,
                  u.id AS u_id, u.display_name AS u_name, u.email AS u_email, u.role AS u_role
           FROM task_attachments ta JOIN users u ON u.id = ta.added_by
           WHERE ta.task_id = $1 AND ta.deleted_at IS NULL ORDER BY ta.created_at`,
          [taskId],
        ),
      ]);
      const actual = (await this.actualTime.actualMinutes(user.orgId, [taskId])).get(taskId) ?? null;
      const summary = mapSummary(row, actual);
      return {
        ...summary,
        description: row.description,
        declineReason: row.decline_reason ?? null,
        acceptedAt: toIso(row.accepted_at),
        escalatedAt: toIso(row.escalated_at),
        createdAt: toIso(row.created_at)!,
        checklist: checklist.rows.map((c) => ({ id: c.id, text: c.text, done: c.done, sortOrder: c.sort_order })),
        subtasks,
        attachments: attachments.rows.map((a) => ({
          id: a.id,
          name: a.name,
          url: a.url,
          mimeType: a.mime_type ?? null,
          sizeBytes: a.size_bytes === null ? null : Number(a.size_bytes),
          addedBy: userRef(a.u_id, a.u_name, a.u_email, a.u_role),
          createdAt: toIso(a.created_at)!,
        })),
        permissions: taskPermissions(actor, facts),
        overrun: isOverrun(summary.estimateMinutes, summary.actualMinutes),
      };
    });
  }

  async comments(user: AuthenticatedUser, taskId: string): Promise<TaskComment[]> {
    const actor = actorOf(user);
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await this.loadVisibleRow(db, user.orgId, actor, taskId);
      const res = await db.query(
        `SELECT c.id, c.body, c.created_at, c.mentioned_user_ids,
                u.id AS u_id, u.display_name AS u_name, u.email AS u_email, u.role AS u_role
         FROM task_comments c JOIN users u ON u.id = c.author_id
         WHERE c.task_id = $1 AND c.deleted_at IS NULL ORDER BY c.created_at`,
        [taskId],
      );
      const mentionIds = [...new Set(res.rows.flatMap((r) => (r.mentioned_user_ids as string[]) ?? []))];
      const mentioned = mentionIds.length
        ? await db.query(`SELECT id, display_name, email, role FROM users WHERE id = ANY($1::uuid[])`, [mentionIds])
        : { rows: [] as pg.QueryResultRow[] };
      const byId = new Map(mentioned.rows.map((m) => [m.id as string, userRef(m.id, m.display_name, m.email, m.role)]));
      return res.rows.map((r) => ({
        id: r.id,
        body: r.body,
        author: userRef(r.u_id, r.u_name, r.u_email, r.u_role),
        mentions: ((r.mentioned_user_ids as string[]) ?? []).map((id) => byId.get(id)).filter((u): u is UserRef => !!u),
        createdAt: toIso(r.created_at)!,
      }));
    });
  }

  async activity(user: AuthenticatedUser, taskId: string): Promise<TaskActivity[]> {
    const actor = actorOf(user);
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await this.loadVisibleRow(db, user.orgId, actor, taskId);
      const res = await db.query(
        `SELECT ac.id, ac.type, ac.data, ac.created_at,
                u.id AS u_id, u.display_name AS u_name, u.email AS u_email, u.role AS u_role
         FROM task_activity ac JOIN users u ON u.id = ac.actor_id
         WHERE ac.task_id = $1 ORDER BY ac.id`,
        [taskId],
      );
      return res.rows.map((r) => ({
        id: String(r.id),
        type: r.type,
        actor: userRef(r.u_id, r.u_name, r.u_email, r.u_role),
        data: (r.data as Record<string, unknown>) ?? {},
        createdAt: toIso(r.created_at)!,
      }));
    });
  }

  /** People the caller may assign tasks to (FR-TASK-007), optionally widened by a project they manage. */
  async assignableUsers(user: AuthenticatedUser, projectId?: string): Promise<UserRef[]> {
    const actor = actorOf(user);
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      if (!hasPermission(actor.role, Permission.TASKS_ASSIGN)) {
        const me = await db.query(`SELECT id, display_name, email, role FROM users WHERE id = $1`, [actor.id]);
        return me.rows.map((u) => userRef(u.id, u.display_name, u.email, u.role));
      }
      const params: unknown[] = [user.orgId, actor.id, actor.teamId, seesAllTasks(actor), projectId ?? null];
      const res = await db.query(
        `SELECT u.id, u.display_name, u.email, u.role FROM users u
         WHERE u.org_id = $1 AND u.status = 'ACTIVE' AND (
           $4::boolean OR u.id = $2::uuid OR u.manager_id = $2::uuid
           OR ($3::uuid IS NOT NULL AND u.team_id = $3::uuid)
           OR ($5::uuid IS NOT NULL AND EXISTS (
                 SELECT 1 FROM projects pr JOIN project_members pm ON pm.project_id = pr.id
                 WHERE pr.id = $5::uuid AND pr.manager_id = $2::uuid AND pm.user_id = u.id)))
         ORDER BY u.display_name NULLS LAST, u.email`,
        params,
      );
      return res.rows.map((u) => userRef(u.id, u.display_name, u.email, u.role));
    });
  }

  /** People who can see the task, i.e. who may be @mentioned on it (FR-TASK-006). */
  async mentionableUsers(user: AuthenticatedUser, taskId: string): Promise<UserRef[]> {
    const actor = actorOf(user);
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await this.loadVisibleRow(db, user.orgId, actor, taskId);
      const res = await db.query(
        `SELECT u.id, u.display_name, u.email, u.role FROM users u
         WHERE u.org_id = $1 AND u.status = 'ACTIVE' AND EXISTS (
           SELECT 1 ${SUMMARY_FROM} WHERE t.id = $2 AND ${visibleTo({
             id: 'u.id',
             teamId: 'u.team_id',
             all: 'u.role = ANY($3::text[])',
             team: 'u.role = ANY($4::text[])',
           })})
         ORDER BY u.display_name NULLS LAST, u.email`,
        [user.orgId, taskId, READ_ALL_ROLES, READ_TEAM_ROLES],
      );
      return res.rows.map((u) => userRef(u.id, u.display_name, u.email, u.role));
    });
  }

  // ---------------------------------------------------------------- mutations

  async create(user: AuthenticatedUser, dto: CreateTaskDto): Promise<TaskDetail> {
    const actor = actorOf(user);
    const pending: PendingEvent[] = [];
    const taskId = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      let projectId = dto.projectId ?? null;
      if (dto.parentTaskId) {
        const parent = await this.loadVisibleRow(db, user.orgId, actor, dto.parentTaskId);
        if (parent.parent_task_id) throw new BadRequestException('Subtasks cannot have their own subtasks');
        projectId = projectId ?? parent.project_id ?? null;
      }
      if (projectId) await this.assertCanUseProject(db, user.orgId, actor, projectId);

      const assigneeId = dto.assigneeId ?? actor.id;
      const assignee = await this.resolveAssignee(db, user.orgId, actor, assigneeId, projectId);
      const acceptance: AcceptanceStatus = requiresAcceptance(actor, assignee) ? 'PENDING' : 'NOT_REQUIRED';

      const res = await db.query<{ id: string }>(
        `INSERT INTO tasks (org_id, project_id, parent_task_id, title, description, priority, assignee_id, reporter_id,
                            acceptance_status, acceptance_requested_at, due_date, planned_date, estimate_minutes, labels)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::varchar, CASE WHEN $9::varchar = 'PENDING' THEN now() END, $10, $11, $12, $13)
         RETURNING id`,
        [
          user.orgId, projectId, dto.parentTaskId ?? null, dto.title, dto.description, dto.priority, assignee.id, actor.id,
          acceptance, dto.dueDate ?? null, dto.plannedDate ?? null, dto.estimateMinutes ?? null, dedupe(dto.labels),
        ],
      );
      const id = res.rows[0]!.id;
      for (const [i, text] of dto.checklist.entries()) {
        await db.query(
          `INSERT INTO task_checklist_items (org_id, task_id, text, sort_order) VALUES ($1, $2, $3, $4)`,
          [user.orgId, id, text, i],
        );
      }
      await this.log(db, user.orgId, id, actor.id, 'CREATED', { title: dto.title, assigneeId: assignee.id, acceptance });
      if (assignee.id !== actor.id) {
        pending.push({
          name: 'task.assigned',
          payload: { orgId: user.orgId, taskId: id, title: dto.title, assigneeId: assignee.id, actorId: actor.id, requiresAcceptance: acceptance === 'PENDING' },
        });
      }
      return id;
    });
    this.flush(pending);
    return await this.get(user, taskId);
  }

  async update(user: AuthenticatedUser, taskId: string, dto: UpdateTaskDto): Promise<TaskDetail> {
    const actor = actorOf(user);
    const pending: PendingEvent[] = [];
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const task = await this.lockTask(db, user.orgId, actor, taskId);
      if (task.version !== dto.version) {
        throw new ConflictException('This task was changed by someone else. Reload and try again.');
      }
      const perms = taskPermissions(actor, task.facts);
      const isAssignee = task.assigneeId === actor.id;
      const sets: string[] = [];
      const params: unknown[] = [];
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const set = (column: string, value: unknown, sqlCast = '') => {
        params.push(value);
        sets.push(`${column} = $${params.length}${sqlCast}`);
      };

      const editOnly = ['title', 'description', 'priority', 'dueDate', 'estimateMinutes', 'labels', 'projectId'] as const;
      if (editOnly.some((k) => dto[k] !== undefined) && !perms.canEdit) {
        throw new ForbiddenException('Only the reporter, their managers or HR can edit this task');
      }
      if (dto.title !== undefined) set('title', dto.title);
      if (dto.description !== undefined) set('description', dto.description);
      if (dto.priority !== undefined) set('priority', dto.priority);
      if (dto.dueDate !== undefined) set('due_date', dto.dueDate, '::date');
      if (dto.estimateMinutes !== undefined) set('estimate_minutes', dto.estimateMinutes);
      if (dto.labels !== undefined) set('labels', dedupe(dto.labels));

      if (dto.plannedDate !== undefined) {
        if (!perms.canEdit && !isAssignee) throw new ForbiddenException('Only the assignee or a manager can plan this task');
        set('planned_date', dto.plannedDate, '::date');
      }

      let projectId = task.projectId;
      if (dto.projectId !== undefined && dto.projectId !== task.projectId) {
        if (dto.projectId) await this.assertCanUseProject(db, user.orgId, actor, dto.projectId);
        projectId = dto.projectId;
        set('project_id', dto.projectId);
        changes.projectId = { from: task.projectId, to: dto.projectId };
      }

      if (dto.status !== undefined && dto.status !== task.status) {
        if (!perms.canChangeStatus) {
          throw new ForbiddenException(
            task.acceptanceStatus === 'PENDING' || task.acceptanceStatus === 'DECLINED'
              ? 'Accept the task before changing its status'
              : 'You cannot change the status of this task',
          );
        }
        if (!canTransition(task.status, dto.status)) {
          throw new BadRequestException(`A task cannot move from ${task.status} to ${dto.status}`);
        }
        set('status', dto.status);
        sets.push(dto.status === 'DONE' ? 'completed_at = now()' : 'completed_at = NULL');
        await this.log(db, user.orgId, taskId, actor.id, 'STATUS_CHANGED', { from: task.status, to: dto.status });
        pending.push({
          name: 'task.status',
          payload: { orgId: user.orgId, taskId, title: task.title, from: task.status, to: dto.status, actorId: actor.id, reporterId: task.reporterId, assigneeId: task.assigneeId },
        });
      }

      if (dto.assigneeId !== undefined && dto.assigneeId !== task.assigneeId) {
        if (!perms.canAssign) throw new ForbiddenException('You cannot reassign this task');
        if (dto.assigneeId === null) {
          set('assignee_id', null);
          sets.push(`acceptance_status = 'NOT_REQUIRED'`, 'acceptance_requested_at = NULL', 'escalated_at = NULL');
        } else {
          const assignee = await this.resolveAssignee(db, user.orgId, actor, dto.assigneeId, projectId);
          const acceptance: AcceptanceStatus = requiresAcceptance(actor, assignee) ? 'PENDING' : 'NOT_REQUIRED';
          set('assignee_id', assignee.id);
          set('acceptance_status', acceptance, '::varchar');
          // SET expressions see the old row, so test the new value's parameter, not the column.
          sets.push(
            `acceptance_requested_at = CASE WHEN $${params.length}::varchar = 'PENDING' THEN now() END`,
            'accepted_at = NULL', 'declined_at = NULL', 'decline_reason = NULL', 'escalated_at = NULL',
          );
          if (assignee.id !== actor.id) {
            pending.push({
              name: 'task.assigned',
              payload: { orgId: user.orgId, taskId, title: task.title, assigneeId: assignee.id, actorId: actor.id, requiresAcceptance: acceptance === 'PENDING' },
            });
          }
        }
        await this.log(db, user.orgId, taskId, actor.id, 'ASSIGNED', { from: task.assigneeId, to: dto.assigneeId });
      }

      for (const k of ['title', 'priority', 'dueDate', 'plannedDate', 'estimateMinutes', 'labels'] as const) {
        if (dto[k] !== undefined && JSON.stringify(dto[k]) !== JSON.stringify(task.before[k])) {
          changes[k] = { from: task.before[k], to: dto[k] };
        }
      }
      // The description can be long; record that it changed, not its content.
      if (dto.description !== undefined) changes.description = { from: '(previous)', to: '(edited)' };
      if (sets.length === 0) return;
      params.push(taskId, user.orgId);
      await db.query(
        `UPDATE tasks SET ${sets.join(', ')}, version = version + 1, updated_at = now()
         WHERE id = $${params.length - 1} AND org_id = $${params.length}`,
        params,
      );
      if (Object.keys(changes).length > 0) {
        await this.log(db, user.orgId, taskId, actor.id, 'UPDATED', { changes });
      }
    });
    this.flush(pending);
    return await this.get(user, taskId);
  }

  async accept(user: AuthenticatedUser, taskId: string): Promise<TaskDetail> {
    return await this.respond(user, taskId, 'ACCEPTED');
  }

  async decline(user: AuthenticatedUser, taskId: string, reason: string): Promise<TaskDetail> {
    return await this.respond(user, taskId, 'DECLINED', reason);
  }

  private async respond(user: AuthenticatedUser, taskId: string, outcome: 'ACCEPTED' | 'DECLINED', reason?: string) {
    const actor = actorOf(user);
    const pending: PendingEvent[] = [];
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const task = await this.lockTask(db, user.orgId, actor, taskId);
      if (!taskPermissions(actor, task.facts).canRespond) {
        throw new ConflictException('This task is not waiting for your acceptance');
      }
      if (outcome === 'ACCEPTED') {
        await db.query(
          `UPDATE tasks SET acceptance_status = 'ACCEPTED', accepted_at = now(), version = version + 1, updated_at = now() WHERE id = $1`,
          [taskId],
        );
        await this.log(db, user.orgId, taskId, actor.id, 'ACCEPTED', {});
        pending.push({ name: 'task.accepted', payload: { orgId: user.orgId, taskId, title: task.title, assigneeId: actor.id, reporterId: task.reporterId } });
      } else {
        await db.query(
          `UPDATE tasks SET acceptance_status = 'DECLINED', declined_at = now(), decline_reason = $2,
                            version = version + 1, updated_at = now() WHERE id = $1`,
          [taskId, reason],
        );
        await this.log(db, user.orgId, taskId, actor.id, 'DECLINED', { reason });
        pending.push({ name: 'task.declined', payload: { orgId: user.orgId, taskId, title: task.title, assigneeId: actor.id, reporterId: task.reporterId, reason: reason ?? '' } });
      }
    });
    this.flush(pending);
    return await this.get(user, taskId);
  }

  async remove(user: AuthenticatedUser, taskId: string): Promise<void> {
    const actor = actorOf(user);
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const task = await this.lockTask(db, user.orgId, actor, taskId);
      if (!taskPermissions(actor, task.facts).canDelete) {
        throw new ForbiddenException('Only the reporter or HR can delete this task');
      }
      await db.query(
        `UPDATE tasks SET deleted_at = now(), updated_at = now(), version = version + 1
         WHERE org_id = $1 AND (id = $2 OR parent_task_id = $2) AND deleted_at IS NULL`,
        [user.orgId, taskId],
      );
      await this.log(db, user.orgId, taskId, actor.id, 'DELETED', {});
    });
  }

  async addComment(user: AuthenticatedUser, taskId: string, body: string): Promise<TaskComment> {
    const actor = actorOf(user);
    const pending: PendingEvent[] = [];
    const commentId = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const row = await this.loadVisibleRow(db, user.orgId, actor, taskId);
      const mentionIds = extractMentionIds(body).filter((id) => id !== actor.id);
      if (mentionIds.length > 0) {
        const ok = await db.query<{ id: string }>(
          `SELECT u.id FROM users u
           WHERE u.org_id = $1 AND u.id = ANY($2::uuid[]) AND u.status = 'ACTIVE' AND EXISTS (
             SELECT 1 ${SUMMARY_FROM} WHERE t.id = $3 AND ${visibleTo({
               id: 'u.id',
               teamId: 'u.team_id',
               all: 'u.role = ANY($4::text[])',
               team: 'u.role = ANY($5::text[])',
             })})`,
          [user.orgId, mentionIds, taskId, READ_ALL_ROLES, READ_TEAM_ROLES],
        );
        const allowed = new Set(ok.rows.map((r) => r.id));
        const blocked = mentionIds.filter((id) => !allowed.has(id));
        if (blocked.length > 0) {
          throw new BadRequestException('You can only mention people who can see this task');
        }
      }
      const res = await db.query<{ id: string }>(
        `INSERT INTO task_comments (org_id, task_id, author_id, body, mentioned_user_ids)
         VALUES ($1, $2, $3, $4, $5::uuid[]) RETURNING id`,
        [user.orgId, taskId, actor.id, body, mentionIds],
      );
      const id = res.rows[0]!.id;
      await this.log(db, user.orgId, taskId, actor.id, 'COMMENTED', { commentId: id, mentions: mentionIds.length });
      if (mentionIds.length > 0) {
        pending.push({ name: 'task.mentioned', payload: { orgId: user.orgId, taskId, title: row.title, commentId: id, userIds: mentionIds, actorId: actor.id } });
      }
      return id;
    });
    this.flush(pending);
    const all = await this.comments(user, taskId);
    return all.find((c) => c.id === commentId)!;
  }

  // ---- checklist

  async addChecklistItem(user: AuthenticatedUser, taskId: string, text: string): Promise<TaskDetail> {
    await this.mutateChecklist(user, taskId, async (db, actor) => {
      await db.query(
        `INSERT INTO task_checklist_items (org_id, task_id, text, sort_order)
         VALUES ($1, $2, $3, COALESCE((SELECT max(sort_order) + 1 FROM task_checklist_items WHERE task_id = $2), 0))`,
        [user.orgId, taskId, text],
      );
      await this.log(db, user.orgId, taskId, actor.id, 'CHECKLIST_CHANGED', { added: text });
    });
    return await this.get(user, taskId);
  }

  async updateChecklistItem(user: AuthenticatedUser, taskId: string, itemId: string, patch: { text?: string; done?: boolean }) {
    await this.mutateChecklist(user, taskId, async (db, actor) => {
      const res = await db.query(
        `UPDATE task_checklist_items
         SET text = COALESCE($3, text), done = COALESCE($4, done),
             done_at = CASE WHEN $4::boolean IS TRUE THEN now() WHEN $4::boolean IS FALSE THEN NULL ELSE done_at END
         WHERE id = $1 AND task_id = $2 RETURNING text, done`,
        [itemId, taskId, patch.text ?? null, patch.done ?? null],
      );
      if (res.rowCount === 0) throw new NotFoundException('Checklist item not found');
      await this.log(db, user.orgId, taskId, actor.id, 'CHECKLIST_CHANGED', { item: res.rows[0]!.text, done: res.rows[0]!.done });
    });
    return await this.get(user, taskId);
  }

  async removeChecklistItem(user: AuthenticatedUser, taskId: string, itemId: string) {
    await this.mutateChecklist(user, taskId, async (db, actor) => {
      const res = await db.query(`DELETE FROM task_checklist_items WHERE id = $1 AND task_id = $2 RETURNING text`, [itemId, taskId]);
      if (res.rowCount === 0) throw new NotFoundException('Checklist item not found');
      await this.log(db, user.orgId, taskId, actor.id, 'CHECKLIST_CHANGED', { removed: res.rows[0]!.text });
    });
    return await this.get(user, taskId);
  }

  private async mutateChecklist(user: AuthenticatedUser, taskId: string, fn: (db: Client, actor: TaskActor) => Promise<void>) {
    const actor = actorOf(user);
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const task = await this.lockTask(db, user.orgId, actor, taskId);
      const perms = taskPermissions(actor, task.facts);
      if (!perms.canEdit && !perms.canChangeStatus) throw new ForbiddenException('You cannot change this checklist');
      await fn(db, actor);
      await db.query(`UPDATE tasks SET version = version + 1, updated_at = now() WHERE id = $1`, [taskId]);
    });
  }

  // ---- attachments (references until the Documents module)

  async addAttachment(user: AuthenticatedUser, taskId: string, dto: AttachmentDto): Promise<TaskDetail> {
    const actor = actorOf(user);
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const task = await this.lockTask(db, user.orgId, actor, taskId);
      const perms = taskPermissions(actor, task.facts);
      if (!perms.canEdit && task.assigneeId !== actor.id) throw new ForbiddenException('You cannot add attachments to this task');
      await db.query(
        `INSERT INTO task_attachments (org_id, task_id, name, url, mime_type, size_bytes, added_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [user.orgId, taskId, dto.name, dto.url, dto.mimeType ?? null, dto.sizeBytes ?? null, actor.id],
      );
      await this.log(db, user.orgId, taskId, actor.id, 'ATTACHMENT_ADDED', { name: dto.name });
    });
    return await this.get(user, taskId);
  }

  async removeAttachment(user: AuthenticatedUser, taskId: string, attachmentId: string): Promise<TaskDetail> {
    const actor = actorOf(user);
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const task = await this.lockTask(db, user.orgId, actor, taskId);
      const res = await db.query(
        `SELECT name, added_by FROM task_attachments WHERE id = $1 AND task_id = $2 AND deleted_at IS NULL`,
        [attachmentId, taskId],
      );
      const att = res.rows[0];
      if (!att) throw new NotFoundException('Attachment not found');
      if (!taskPermissions(actor, task.facts).canEdit && att.added_by !== actor.id) {
        throw new ForbiddenException('You cannot remove this attachment');
      }
      await db.query(`UPDATE task_attachments SET deleted_at = now() WHERE id = $1`, [attachmentId]);
      await this.log(db, user.orgId, taskId, actor.id, 'ATTACHMENT_REMOVED', { name: att.name });
    });
    return await this.get(user, taskId);
  }

  // ---------------------------------------------------------------- helpers

  /** The task row if the actor can see it; otherwise 404 (no existence leak). */
  private async loadVisibleRow(db: Client, orgId: string, actor: TaskActor, taskId: string, lock = false): Promise<pg.QueryResultRow> {
    const v = viewerParams(actor, 3);
    const res = await db.query(
      `SELECT ${SUMMARY_COLUMNS}, t.description, t.decline_reason, t.accepted_at, t.escalated_at, t.created_at,
              EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = t.project_id AND pm.user_id = $3::uuid) AS actor_is_member,
              (p.manager_id IS NOT NULL AND p.manager_id = $3::uuid) AS actor_is_pm
       ${SUMMARY_FROM}
       WHERE t.org_id = $1 AND t.id = $2 AND t.deleted_at IS NULL AND ${v.sql}
       ${lock ? 'FOR UPDATE OF t' : ''}`,
      [orgId, taskId, ...v.params],
    );
    if (res.rows.length === 0) throw new NotFoundException('Task not found');
    return res.rows[0]!;
  }

  private factsFromRow(row: pg.QueryResultRow, _actor: TaskActor): TaskFacts {
    return {
      reporterId: row.reporter_id,
      assigneeId: row.assignee_id ?? null,
      assigneeManagerId: row.a_manager_id ?? null,
      assigneeTeamId: row.a_team_id ?? null,
      actorIsProjectMember: row.actor_is_member === true,
      actorIsProjectManager: row.actor_is_pm === true,
      acceptanceStatus: row.acceptance_status,
    };
  }

  private async lockTask(db: Client, orgId: string, actor: TaskActor, taskId: string): Promise<LockedTask> {
    const row = await this.loadVisibleRow(db, orgId, actor, taskId, true);
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      projectId: row.project_id ?? null,
      assigneeId: row.assignee_id ?? null,
      reporterId: row.reporter_id,
      acceptanceStatus: row.acceptance_status,
      version: row.version,
      facts: this.factsFromRow(row, actor),
      before: {
        title: row.title,
        priority: row.priority,
        dueDate: row.due_date ?? null,
        plannedDate: row.planned_date ?? null,
        estimateMinutes: row.estimate_minutes ?? null,
        labels: row.labels ?? [],
      },
    };
  }

  private async visibleSubtasks(db: Client, orgId: string, actor: TaskActor, parentId: string): Promise<TaskSummary[]> {
    const v = viewerParams(actor, 3);
    const res = await db.query(
      `SELECT ${SUMMARY_COLUMNS} ${SUMMARY_FROM}
       WHERE t.org_id = $1 AND t.parent_task_id = $2 AND t.deleted_at IS NULL AND ${v.sql}
       ORDER BY t.created_at`,
      [orgId, parentId, ...v.params],
    );
    return res.rows.map((r) => mapSummary(r));
  }

  /** Validates an assignee: active member of the org and within the actor's assignment scope. */
  private async resolveAssignee(db: Client, orgId: string, actor: TaskActor, assigneeId: string, projectId: string | null) {
    const res = await db.query(
      `SELECT u.id, u.role, u.status, u.manager_id, u.team_id,
              EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = $3 AND pm.user_id = u.id) AS is_member,
              EXISTS (SELECT 1 FROM projects pr WHERE pr.id = $3 AND pr.manager_id = $4) AS actor_manages
       FROM users u WHERE u.org_id = $1 AND u.id = $2`,
      [orgId, assigneeId, projectId, actor.id],
    );
    const u = res.rows[0];
    if (!u || u.status !== 'ACTIVE') throw new BadRequestException('Assignee must be an active member of your organisation');
    const ok = canAssignTo(
      actor,
      { id: u.id, managerId: u.manager_id ?? null, teamId: u.team_id ?? null },
      { actorManagesProject: u.actor_manages === true, targetIsProjectMember: u.is_member === true },
    );
    if (!ok) throw new ForbiddenException('You cannot assign tasks to this person');
    return { id: u.id as string, role: u.role as string };
  }

  /** A task can be filed under a project the actor sees: HR/admin, the project manager, or a member. */
  private async assertCanUseProject(db: Client, orgId: string, actor: TaskActor, projectId: string): Promise<void> {
    const res = await db.query(
      `SELECT pr.status,
              (pr.manager_id = $3) AS is_pm,
              EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = pr.id AND pm.user_id = $3) AS is_member
       FROM projects pr WHERE pr.org_id = $1 AND pr.id = $2`,
      [orgId, projectId, actor.id],
    );
    const p = res.rows[0];
    const allowed = p && (seesAllTasks(actor) || hasPermission(actor.role, Permission.PROJECTS_MANAGE) || p.is_pm || p.is_member);
    if (!allowed) throw new BadRequestException('Project not found');
    if (p.status === 'ARCHIVED' || p.status === 'DONE') throw new BadRequestException('This project is closed for new work');
  }

  private async log(db: Client, orgId: string, taskId: string, actorId: string, type: TaskActivityType, data: Record<string, unknown>) {
    await db.query(
      `INSERT INTO task_activity (org_id, task_id, actor_id, type, data) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [orgId, taskId, actorId, type, JSON.stringify(data)],
    );
  }

  private flush(pending: PendingEvent[]): void {
    for (const e of pending) this.events.emit(e.name, e.payload as never);
  }
}

function dedupe(labels: string[]): string[] {
  return [...new Set(labels.map((l) => l.trim()).filter(Boolean))];
}
