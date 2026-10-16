import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import type { Cell } from '../common/export-format.ts';
import { Permission, userCan } from '../../../../packages/shared/src/auth/types.ts';
import { CATEGORY_LABEL } from '../../../../packages/shared/src/documents/types.ts';
import type { DocumentCategory } from '../../../../packages/shared/src/documents/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import type { ComplianceQuery, ComplianceReport, ComplianceRequirements, ComplianceRequirementsDto, ComplianceRow } from '../../../../packages/shared/src/reports/types.ts';
import { exportTable, personLabel, reportScope, scopeSql, USER_REF_SELECT, userRef } from './report-scope.ts';
import type { ExportFile } from './report-scope.ts';

const SOON_DAYS = 30;

interface DocRow { linked_user_id: string; id: string; title: string; category: DocumentCategory; expires_at: string | null }

/**
 * FR-REP-005 (as agreed): HR defines which document categories each role must have on file;
 * the report lists, per person in scope, categories with no valid document, expired documents
 * and those expiring within 30 days. Onboarding does not exist yet and is reported as such.
 * Confidential titles are never shown.
 */
@Injectable()
export class ComplianceService {
  constructor(private readonly prisma: PrismaService) {}

  async requirements(user: AuthenticatedUser): Promise<ComplianceRequirements> {
    reportScope(user);
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const res = await db.query<{ role: string; category: DocumentCategory }>(`SELECT role, category FROM required_document_categories ORDER BY role, category`);
      const byRole = new Map<string, DocumentCategory[]>();
      for (const r of res.rows) byRole.set(r.role, [...(byRole.get(r.role) ?? []), r.category]);
      return { items: [...byRole.entries()].map(([role, categories]) => ({ role: role as ComplianceRequirements['items'][number]['role'], categories })) };
    });
  }

  async updateRequirements(user: AuthenticatedUser, dto: ComplianceRequirementsDto): Promise<ComplianceRequirements> {
    const before = await this.requirements(user);
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await db.query(`DELETE FROM required_document_categories WHERE org_id = $1`, [user.orgId]);
      const pairs = dto.items.flatMap((i) => [...new Set(i.categories)].map((c) => [i.role, c] as const));
      if (pairs.length > 0) {
        await db.query(
          `INSERT INTO required_document_categories (org_id, role, category) SELECT $1, r, c FROM unnest($2::text[], $3::text[]) AS t(r, c) ON CONFLICT DO NOTHING`,
          [user.orgId, pairs.map((p) => p[0]), pairs.map((p) => p[1])],
        );
      }
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'COMPLIANCE_REQUIREMENTS_UPDATED', entityType: 'ORGANIZATION', entityId: user.orgId, before, after: dto });
    });
    return await this.requirements(user);
  }

  async report(user: AuthenticatedUser, q: ComplianceQuery, today: string = new Date().toISOString().slice(0, 10)): Promise<ComplianceReport> {
    const scope = reportScope(user);
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const required = await db.query<{ role: string; category: DocumentCategory }>(`SELECT role, category FROM required_document_categories`);
      const byRole = new Map<string, DocumentCategory[]>();
      for (const r of required.rows) byRole.set(r.role, [...(byRole.get(r.role) ?? []), r.category]);

      const params: unknown[] = [user.orgId];
      const people = await db.query<{ user_id: string; display_name: string | null; email: string; team_name: string | null; role: string }>(
        `SELECT ${USER_REF_SELECT()}, u.role FROM users u LEFT JOIN teams t ON t.id = u.team_id
         WHERE u.status = 'ACTIVE' AND ${scopeSql(user, scope, params, { teamId: q.teamId, userId: q.userId })} ORDER BY COALESCE(u.display_name, u.email)`,
        params,
      );
      const ids = people.rows.map((p) => p.user_id);
      const docs = await db.query<DocRow>(
        `SELECT d.linked_user_id, d.id, CASE WHEN d.confidentiality = 'NORMAL' THEN COALESCE(d.title, '(untitled)') ELSE '(confidential)' END AS title,
                d.category, to_char(d.expires_at, 'YYYY-MM-DD') AS expires_at
         FROM documents d LEFT JOIN document_versions v ON v.id = d.current_version_id
         WHERE d.org_id = $1 AND d.deleted_at IS NULL AND d.linked_user_id = ANY($2::uuid[])
           AND (v.scan_status IS NULL OR v.scan_status NOT IN ('INFECTED', 'REJECTED'))`,
        [user.orgId, ids],
      );
      const soon = new Date(`${today}T00:00:00Z`);
      soon.setUTCDate(soon.getUTCDate() + SOON_DAYS);
      const soonIso = soon.toISOString().slice(0, 10);
      const byUser = new Map<string, DocRow[]>();
      for (const d of docs.rows) byUser.set(d.linked_user_id, [...(byUser.get(d.linked_user_id) ?? []), d]);

      let rows: ComplianceRow[] = people.rows.map((p) => {
        const mine = byUser.get(p.user_id) ?? [];
        const valid = new Set(mine.filter((d) => !d.expires_at || d.expires_at >= today).map((d) => d.category));
        const missing = (byRole.get(p.role) ?? []).filter((c) => !valid.has(c));
        const expired = mine.filter((d) => d.expires_at && d.expires_at < today).map((d) => ({ id: d.id, title: d.title, category: d.category, expiredOn: d.expires_at! }));
        const expiringSoon = mine.filter((d) => d.expires_at && d.expires_at >= today && d.expires_at <= soonIso).map((d) => ({ id: d.id, title: d.title, category: d.category, expiresOn: d.expires_at! }));
        return { user: userRef(p), role: p.role, missing, expired, expiringSoon, onboarding: 'NOT_AVAILABLE' as const, compliant: missing.length === 0 && expired.length === 0 };
      });
      const summary = { people: rows.length, compliant: rows.filter((r) => r.compliant).length, withMissing: rows.filter((r) => r.missing.length > 0).length, withExpired: rows.filter((r) => r.expired.length > 0).length };
      if (q.onlyIssues) rows = rows.filter((r) => !r.compliant || r.expiringSoon.length > 0);
      return { scope, asOf: today, rows, summary, canEditRequirements: userCan(user, Permission.ORG_MANAGE) };
    });
  }

  async export(user: AuthenticatedUser, q: ComplianceQuery & { format: 'csv' | 'xlsx' | 'pdf' }): Promise<ExportFile> {
    const r = await this.report(user, q);
    const header = ['Person', 'Team', 'Role', 'Compliant', 'Missing', 'Expired', 'Expiring within 30 days', 'Onboarding'];
    const rows: Cell[][] = r.rows.map((x) => [
      personLabel({ display_name: x.user.displayName, email: x.user.email }), x.user.teamName, x.role, x.compliant ? 'yes' : 'no',
      x.missing.map((c) => CATEGORY_LABEL[c]).join('; '),
      x.expired.map((d) => `${CATEGORY_LABEL[d.category]}: ${d.title} (${d.expiredOn})`).join('; '),
      x.expiringSoon.map((d) => `${CATEGORY_LABEL[d.category]}: ${d.title} (${d.expiresOn})`).join('; '),
      'not available',
    ]);
    return await this.prisma.runWithTenantContext(user.orgId, (db) => exportTable(db, user, {
      report: 'compliance', title: 'Compliance report', subtitle: `as of ${r.asOf} · ${r.summary.compliant} of ${r.summary.people} compliant`,
      header, rows, format: q.format, filters: { teamId: q.teamId ?? null, userId: q.userId ?? null, onlyIssues: q.onlyIssues },
    }));
  }
}
