/**
 * FR-REP-008: every report sees only the people its viewer may see.
 *  - reports.all: the whole organisation.
 *  - reports.team: the viewer, their direct reports and their own team.
 * Optional team / person filters narrow within that scope, never beyond it. Exports are
 * audited with their filters and row count (FR-REP-006).
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { appendAuditEntry } from '../common/audit-chain.ts';
import { toCsv, toPdf, toXlsx } from '../common/export-format.ts';
import type { Cell } from '../common/export-format.ts';
import { Permission, userCan } from '../../../../packages/shared/src/auth/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import type { ReportFormat, ReportUserRef } from '../../../../packages/shared/src/reports/types.ts';

export type Scope = 'team' | 'all';

export function reportScope(user: AuthenticatedUser): Scope {
  if (userCan(user, Permission.REPORTS_ALL)) return 'all';
  if (userCan(user, Permission.REPORTS_TEAM)) return 'team';
  throw new ForbiddenException('Reports need team or organisation report access');
}

/** A condition on the users alias `u`; placeholders are appended to `params`. */
export function scopeSql(user: AuthenticatedUser, scope: Scope, params: unknown[], filters: { teamId?: string; userId?: string } = {}, alias = 'u'): string {
  const parts: string[] = [`${alias}.org_id = $1`];
  if (scope === 'team') {
    params.push(user.id);
    const me = `$${params.length}`;
    params.push(user.teamId ?? null);
    const team = `$${params.length}::uuid`;
    parts.push(`(${alias}.id = ${me} OR ${alias}.manager_id = ${me} OR (${team} IS NOT NULL AND ${alias}.team_id = ${team}))`);
  }
  if (filters.teamId) {
    params.push(filters.teamId);
    parts.push(`${alias}.team_id = $${params.length}`);
  }
  if (filters.userId) {
    params.push(filters.userId);
    parts.push(`${alias}.id = $${params.length}`);
  }
  return parts.join(' AND ');
}

export const USER_REF_SELECT = (alias = 'u', team = 't') => `${alias}.id AS user_id, ${alias}.display_name, ${alias}.email, ${team}.name AS team_name`;

export function userRef(r: { user_id: string; display_name: string | null; email: string; team_name: string | null }): ReportUserRef {
  return { id: r.user_id, displayName: r.display_name, email: r.email, teamName: r.team_name };
}

export const personLabel = (r: { display_name: string | null; email: string }): string => r.display_name ?? r.email;

export function ensureRange(from: string, to: string, maxDays: number): void {
  if (to < from) throw new BadRequestException('"to" is before "from"');
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
  if (days > maxDays) throw new BadRequestException(`At most ${maxDays} days at a time`);
}

export interface ExportFile {
  body: Buffer | string;
  contentType: string;
  filename: string;
}

/** CSV, XLSX or PDF of a rendered table, audited as REPORT_EXPORTED. */
export async function exportTable(
  db: pg.PoolClient,
  user: AuthenticatedUser,
  opts: { report: string; title: string; subtitle: string; header: string[]; rows: Cell[][]; format: Exclude<ReportFormat, 'json'>; filters: Record<string, unknown> },
): Promise<ExportFile> {
  await appendAuditEntry(db, {
    orgId: user.orgId, actorId: user.id, action: 'REPORT_EXPORTED', entityType: 'EXPORT', entityId: randomUUID(),
    after: { report: opts.report, format: opts.format, filters: opts.filters, rowCount: opts.rows.length },
  });
  const base = `${opts.report}-${new Date().toISOString().slice(0, 10)}`;
  if (opts.format === 'xlsx') {
    return { body: await toXlsx(opts.title, opts.header, opts.rows), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `${base}.xlsx` };
  }
  if (opts.format === 'pdf') {
    return { body: await toPdf(opts.title, opts.subtitle, opts.header, opts.rows), contentType: 'application/pdf', filename: `${base}.pdf` };
  }
  return { body: toCsv(opts.header, opts.rows), contentType: 'text/csv; charset=utf-8', filename: `${base}.csv` };
}

export const minutes = (seconds: number | string | null): number => Math.round(Number(seconds ?? 0) / 60);
export const hours = (m: number): number => Math.round((m / 60) * 100) / 100;
