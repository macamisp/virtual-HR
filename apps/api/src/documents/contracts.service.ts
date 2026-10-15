import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import { PrismaService } from '../common/prisma.service.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import { hasPermission, Permission } from '../../../../packages/shared/src/auth/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import type { Contract, ContractDto, ContractUpdateDto } from '../../../../packages/shared/src/documents/types.ts';
import { userRef } from '../tasks/tasks.sql.ts';

type Db = pg.PoolClient;

const SELECT = `
  SELECT c.id, c.user_id, u.display_name, u.email, u.role, c.title, c.scope,
         to_char(c.start_date, 'YYYY-MM-DD') AS start_date, to_char(c.end_date, 'YYYY-MM-DD') AS end_date,
         c.status, c.renewal_notice_days, c.document_id, d.title AS doc_title, c.version,
         (SELECT v.scan_status FROM document_versions v WHERE v.document_id = d.id ORDER BY v.version_no DESC LIMIT 1) AS doc_status
  FROM contracts c JOIN users u ON u.id = c.user_id
  LEFT JOIN documents d ON d.id = c.document_id AND d.deleted_at IS NULL`;

interface Row {
  id: string;
  user_id: string;
  display_name: string | null;
  email: string;
  role: string;
  title: string;
  scope: string;
  start_date: string;
  end_date: string | null;
  status: Contract['status'];
  renewal_notice_days: number;
  document_id: string | null;
  doc_title: string | null;
  doc_status: NonNullable<Contract['document']>['latestStatus'];
  version: number;
}

/**
 * SRS 7.4 contracts, minimal until the People & Org slice: HR (contracts.manage) records
 * contracts and links the signed document; people see their own contracts. The link is kept
 * on both sides (contracts.document_id and documents.linked_contract_id).
 */
@Injectable()
export class ContractsService {
  constructor(private readonly prisma: PrismaService) {}

  private map(r: Row, canEdit: boolean): Contract {
    return {
      id: r.id,
      user: userRef(r.user_id, r.display_name, r.email, r.role),
      title: r.title,
      scope: r.scope,
      startDate: r.start_date,
      endDate: r.end_date,
      status: r.status,
      renewalNoticeDays: r.renewal_notice_days,
      document: r.document_id && r.doc_title !== null ? { id: r.document_id, title: r.doc_title, latestStatus: r.doc_status } : null,
      version: r.version,
      canEdit,
    };
  }

  async list(user: AuthenticatedUser): Promise<{ items: Contract[]; canManage: boolean }> {
    const manage = hasPermission(user.role, Permission.CONTRACTS_MANAGE);
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const res = await db.query<Row>(`${SELECT} ${manage ? '' : 'WHERE c.user_id = $1'} ORDER BY c.start_date DESC, u.display_name NULLS LAST`, manage ? [] : [user.id]);
      return { items: res.rows.map((r) => this.map(r, manage)), canManage: manage };
    });
  }

  async create(user: AuthenticatedUser, dto: ContractDto): Promise<Contract> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const u = await db.query(`SELECT 1 FROM users WHERE id = $1`, [dto.userId]);
      if (u.rowCount === 0) throw new BadRequestException('User not found');
      this.checkDates(dto.startDate, dto.endDate ?? null);
      const res = await db.query<{ id: string }>(
        `INSERT INTO contracts (org_id, user_id, title, scope, start_date, end_date, status, renewal_notice_days, created_by)
         VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9) RETURNING id`,
        [user.orgId, dto.userId, dto.title, dto.scope, dto.startDate, dto.endDate ?? null, dto.status, dto.renewalNoticeDays, user.id],
      );
      const id = res.rows[0]!.id;
      if (dto.documentId) await this.link(db, id, dto.documentId, dto.userId);
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'CONTRACT_CREATED', entityType: 'CONTRACT', entityId: id, after: { ...dto, scope: undefined } });
      return await this.get(db, id);
    });
  }

  async update(user: AuthenticatedUser, id: string, dto: ContractUpdateDto): Promise<Contract> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const cur = (await db.query<Row>(`${SELECT} WHERE c.id = $1 FOR UPDATE OF c`, [id])).rows[0];
      if (!cur) throw new NotFoundException('Contract not found');
      if (cur.version !== dto.version) throw new ConflictException('This contract changed since you opened it; reload and try again');
      const start = dto.startDate ?? cur.start_date;
      const end = dto.endDate !== undefined ? dto.endDate : cur.end_date;
      this.checkDates(start, end);
      await db.query(
        `UPDATE contracts SET title = $2, scope = $3, start_date = $4::date, end_date = $5::date, status = $6, renewal_notice_days = $7,
           version = version + 1, updated_at = now() WHERE id = $1`,
        [id, dto.title ?? cur.title, dto.scope ?? cur.scope, start, end, dto.status ?? cur.status, dto.renewalNoticeDays ?? cur.renewal_notice_days],
      );
      if (dto.documentId !== undefined && dto.documentId !== cur.document_id) {
        await db.query(`UPDATE documents SET linked_contract_id = NULL, updated_at = now() WHERE linked_contract_id = $1`, [id]);
        await db.query(`UPDATE contracts SET document_id = NULL WHERE id = $1`, [id]);
        if (dto.documentId) await this.link(db, id, dto.documentId, cur.user_id);
      }
      await appendAuditEntry(db, {
        orgId: user.orgId, actorId: user.id, action: 'CONTRACT_UPDATED', entityType: 'CONTRACT', entityId: id,
        before: { status: cur.status, endDate: cur.end_date, documentId: cur.document_id }, after: { ...dto, scope: undefined },
      });
      return await this.get(db, id);
    });
  }

  private checkDates(start: string, end: string | null): void {
    if (end && end < start) throw new BadRequestException('The end date is before the start date');
  }

  /** Both sides of the link; the document gets the contract's person as its linked user. */
  private async link(db: Db, contractId: string, documentId: string, userId: string): Promise<void> {
    const d = await db.query<{ id: string }>(`SELECT id FROM documents WHERE id = $1 AND deleted_at IS NULL`, [documentId]);
    if (!d.rows[0]) throw new BadRequestException('Document not found');
    const taken = await db.query(`SELECT 1 FROM contracts WHERE document_id = $1 AND id <> $2`, [documentId, contractId]);
    if ((taken.rowCount ?? 0) > 0) throw new ConflictException('This document is already linked to another contract');
    await db.query(`UPDATE contracts SET document_id = $2 WHERE id = $1`, [contractId, documentId]);
    await db.query(
      `UPDATE documents SET linked_contract_id = $2, linked_user_id = COALESCE(linked_user_id, $3), version = version + 1, updated_at = now() WHERE id = $1`,
      [documentId, contractId, userId],
    );
  }

  private async get(db: Db, id: string): Promise<Contract> {
    const r = (await db.query<Row>(`${SELECT} WHERE c.id = $1`, [id])).rows[0]!;
    return this.map(r, true);
  }
}
