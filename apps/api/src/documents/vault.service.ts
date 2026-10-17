import { ConflictException, ForbiddenException, HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import type pg from 'pg';
import argon2 from 'argon2';
import { verifySync } from 'otplib';
import { PrismaService } from '../common/prisma.service.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import type { RequestContext } from '../common/decorators/request-context.decorator.ts';
import { NotificationsService } from '../notifications/notifications.service.ts';
import { Permission, userCan } from '../../../../packages/shared/src/auth/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import { DOCUMENT_CATEGORIES } from '../../../../packages/shared/src/documents/types.ts';
import type {
  DocumentSummary,
  LegalHoldDto,
  RecoverDocumentPasswordDto,
  ReauthDto,
  ReauthStatus,
  RemoveDocumentPasswordDto,
  RetentionRule,
  RetentionRulesDto,
  SetDocumentPasswordDto,
} from '../../../../packages/shared/src/documents/types.ts';
import { LEVEL } from './document-policy.ts';
import { DocumentVault, PasswordRequiredError, WrongDocumentPasswordError } from './document-vault.ts';
import { SUMMARY_COLUMNS, SUMMARY_FROM, docActor, levelSql, loadDocument, mapSummary } from './documents.sql.ts';
import type { LoadedDocument, SummaryRow, VersionRow } from './documents.sql.ts';
import { logAccess } from './access-log.ts';
import { lockoutAfterFailure, reauthValid, retentionBlocksDelete, TRASH_DAYS } from './vault-rules.ts';

type Db = pg.PoolClient;

/** 403 with a machine-readable code the web app reacts to (re-auth dialog, password prompt). */
export function vaultError(code: 'REAUTH_REQUIRED' | 'PASSWORD_REQUIRED' | 'WRONG_DOCUMENT_PASSWORD', message: string): ForbiddenException {
  return new ForbiddenException({ statusCode: 403, code, message });
}

/**
 * Confidential vault (FR-DOC-005, 006, 017): re-authentication window, document passwords with
 * lockout and recovery, legal hold, trash and retention rules.
 */
@Injectable()
export class VaultService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: DocumentVault,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------------------------------------------------------------- FR-DOC-005 re-authentication

  async reauthStatus(user: AuthenticatedUser): Promise<ReauthStatus> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const s = await this.sessionFacts(db, user);
      const at = s?.reauthenticated_at ?? null;
      const valid = reauthValid(at, new Date(), s?.window ?? 10);
      return {
        validUntil: valid && at ? new Date(at.getTime() + (s!.window * 60_000)).toISOString() : null,
        windowMinutes: s?.window ?? 10,
        totpAvailable: !!s?.mfa_enabled,
      };
    });
  }

  /** Password or a TOTP code again; opens the vault for this login for N minutes. */
  async reauthenticate(user: AuthenticatedUser, dto: ReauthDto, ctx: RequestContext): Promise<ReauthStatus> {
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const s = await this.sessionFacts(db, user);
      if (!s) throw new UnauthorizedException('Your session has ended; sign in again');
      let ok = false;
      if (dto.password && s.password_hash) ok = await argon2.verify(s.password_hash, dto.password).catch(() => false);
      if (dto.totpCode) ok = s.mfa_enabled && !!s.mfa_secret && verifySync({ token: dto.totpCode, secret: s.mfa_secret }).valid;
      await appendAuditEntry(db, {
        orgId: user.orgId, actorId: user.id, action: ok ? 'VAULT_REAUTH' : 'VAULT_REAUTH_FAILED', entityType: 'USER', entityId: user.id,
        after: { method: dto.password ? 'password' : 'totp' }, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined,
      });
      if (!ok) return;
      await db.query(
        `INSERT INTO vault_reauth (family_id, org_id, user_id, reauthenticated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (family_id) DO UPDATE SET reauthenticated_at = now()`,
        [s.family_id, user.orgId, user.id],
      );
    });
    const status = await this.reauthStatus(user);
    if (!status.validUntil) throw new UnauthorizedException('That did not match');
    return status;
  }

  /** CONFIDENTIAL and RESTRICTED content needs a fresh re-authentication of this login. */
  async assertReauth(db: Db, user: AuthenticatedUser, doc: Pick<SummaryRow, 'id' | 'confidentiality'>, ctx: RequestContext): Promise<void> {
    if (doc.confidentiality === 'NORMAL') return;
    const s = await this.sessionFacts(db, user);
    if (s && reauthValid(s.reauthenticated_at, new Date(), s.window)) return;
    // Its own transaction: the caller's is about to roll back with the 403.
    await this.prisma.runWithTenantContext(user.orgId, (tx) => logAccess(tx, { orgId: user.orgId, documentId: doc.id, userId: user.id, action: 'REAUTH_REQUIRED', ctx }));
    throw vaultError('REAUTH_REQUIRED', `Confirm it is you to open confidential documents (valid for ${s?.window ?? 10} minutes)`);
  }

  /** FR-DOC-014: when this login last re-authenticated, if still inside the window (else null). */
  async recentReauth(db: Db, user: AuthenticatedUser): Promise<Date | null> {
    const s = await this.sessionFacts(db, user);
    return s?.reauthenticated_at && reauthValid(s.reauthenticated_at, new Date(), s.window) ? s.reauthenticated_at : null;
  }

  private async sessionFacts(db: Db, user: AuthenticatedUser) {
    if (!user.sessionId) return null;
    const res = await db.query<{ family_id: string; reauthenticated_at: Date | null; window: number; password_hash: string | null; mfa_enabled: boolean; mfa_secret: string | null }>(
      `SELECT s.family_id, r.reauthenticated_at, o.vault_reauth_minutes AS window, u.password_hash, u.mfa_enabled, u.mfa_secret
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
       JOIN organizations o ON o.id = u.org_id
       LEFT JOIN vault_reauth r ON r.family_id = s.family_id
       WHERE s.id = $1 AND s.user_id = $2 AND NOT s.is_revoked`,
      [user.sessionId, user.id],
    );
    return res.rows[0] ?? null;
  }

  // ---------------------------------------------------------------- FR-DOC-006 document passwords

  /**
   * The data key of one version for this user, enforcing the document password with a lockout:
   * 3 wrong attempts lock the user out of this document for 15 minutes and notify HR.
   */
  async unlock(db: Db, user: AuthenticatedUser, doc: LoadedDocument, v: VersionRow, password: string | undefined, ctx: RequestContext): Promise<Buffer> {
    if (!v.dek_wrapped_pw) return await this.vault.versionDek(user.orgId, doc.id, v);
    const lock = await db.query<{ locked_until: Date | null }>(`SELECT locked_until FROM document_password_attempts WHERE document_id = $1 AND user_id = $2`, [doc.id, user.id]);
    const until = lock.rows[0]?.locked_until;
    if (until && until.getTime() > Date.now()) {
      throw new HttpException({ statusCode: 423, code: 'LOCKED', message: `Too many wrong passwords. Try again after ${until.toISOString().slice(11, 16)} UTC.` }, 423);
    }
    try {
      const dek = await this.vault.versionDek(user.orgId, doc.id, v, password);
      // Only when there is something to reset, so the normal path takes no row lock.
      await db.query(
        `UPDATE document_password_attempts SET failures = 0, locked_until = NULL, updated_at = now()
         WHERE document_id = $1 AND user_id = $2 AND (failures > 0 OR locked_until IS NOT NULL)`,
        [doc.id, user.id],
      );
      return dek;
    } catch (err) {
      if (err instanceof PasswordRequiredError) throw vaultError('PASSWORD_REQUIRED', 'Enter the document password');
      if (err instanceof WrongDocumentPasswordError) {
        // Recorded in its own transaction: the caller's transaction is about to roll back.
        await this.recordFailure(user, doc, ctx);
        throw vaultError('WRONG_DOCUMENT_PASSWORD', 'Wrong document password');
      }
      throw err;
    }
  }

  private async recordFailure(user: AuthenticatedUser, doc: LoadedDocument, ctx: RequestContext): Promise<void> {
    const locked = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      // Never wait on the caller's still-open transaction.
      await db.query(`SET LOCAL lock_timeout = '2s'`);
      const cur = await db.query<{ failures: number }>(
        `INSERT INTO document_password_attempts (org_id, document_id, user_id, failures) VALUES ($1, $2, $3, 0)
         ON CONFLICT (document_id, user_id) DO UPDATE SET updated_at = now() RETURNING failures`,
        [user.orgId, doc.id, user.id],
      );
      const next = lockoutAfterFailure(cur.rows[0]?.failures ?? 0, new Date());
      await db.query(`UPDATE document_password_attempts SET failures = $3, locked_until = $4, updated_at = now() WHERE document_id = $1 AND user_id = $2`, [doc.id, user.id, next.failures, next.lockedUntil]);
      await logAccess(db, { orgId: user.orgId, documentId: doc.id, userId: user.id, action: 'PASSWORD_FAIL', ctx, detail: { locked: next.justLocked } });
      return next.justLocked;
    });
    if (locked) {
      const hr = await this.prisma.runWithTenantContext(user.orgId, (db) => db.query<{ id: string }>(`SELECT id FROM users WHERE role IN ('HR', 'HR_MANAGER') AND status = 'ACTIVE'`));
      const who = user.displayName ?? user.email;
      await this.notifications.notify(user.orgId, hr.rows.map((h) => ({
        userId: h.id, type: 'DOCUMENT_PASSWORD_LOCKOUT' as const,
        title: `Document locked after wrong passwords: ${who}`,
        body: `${who} entered a wrong document password 3 times${ctx.ip ? ` from ${ctx.ip}` : ''}. They are locked out of that document for 15 minutes.`,
        link: `/documents/${doc.id}`, entityType: 'DOCUMENT', entityId: doc.id, email: true,
      })));
    }
  }

  async setPassword(user: AuthenticatedUser, documentId: string, dto: SetDocumentPasswordDto, ctx: RequestContext): Promise<DocumentSummary> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const doc = await loadDocument(db, user, documentId, LEVEL.MANAGE, { forUpdate: true });
      // SRS FR-DOC-006: the owner or HR.
      if (doc.owner_id !== user.id && !docActor(user).isHr) throw new ForbiddenException('Only the owner or HR can set a document password');
      if (doc.password_protected && !dto.currentPassword) throw vaultError('PASSWORD_REQUIRED', 'Enter the current document password to change it');
      const versions = await this.keyedVersions(db, documentId);
      for (const v of versions) {
        const dek = await this.unlock(db, user, doc, v, dto.currentPassword, ctx);
        try {
          const w = await this.vault.wrapWithPassword(user.orgId, documentId, dek, dto.password);
          await db.query(
            `UPDATE document_versions SET dek_wrapped_pw = $2, pw_salt = $3, pw_kdf_params = $4::jsonb, dek_wrapped_recovery = $5,
               recovery_key_id = $6, kms_key_id = $7, dek_wrapped_kms = NULL WHERE id = $1`,
            [v.id, w.dekWrappedPw, w.pwSalt, JSON.stringify(w.pwKdfParams), w.dekWrappedRecovery, w.recoveryKeyId, w.keyId],
          );
        } finally {
          dek.fill(0);
        }
      }
      await db.query(`UPDATE documents SET password_protected = true, version = version + 1, updated_at = now() WHERE id = $1`, [documentId]);
      // External links cannot carry a document password: they stop working.
      await db.query(`UPDATE document_share_links SET revoked_at = now(), revoked_by = $2 WHERE document_id = $1 AND revoked_at IS NULL`, [documentId, user.id]);
      await logAccess(db, { orgId: user.orgId, documentId, userId: user.id, action: 'PASSWORD_SET', ctx, detail: { changed: doc.password_protected, versions: versions.length } });
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: doc.password_protected ? 'DOCUMENT_PASSWORD_CHANGED' : 'DOCUMENT_PASSWORD_SET', entityType: 'DOCUMENT', entityId: documentId, ip: ctx.ip ?? undefined });
      return await this.summary(db, user, documentId);
    });
  }

  async removePassword(user: AuthenticatedUser, documentId: string, dto: RemoveDocumentPasswordDto, ctx: RequestContext): Promise<DocumentSummary> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const doc = await loadDocument(db, user, documentId, LEVEL.MANAGE, { forUpdate: true });
      if (doc.owner_id !== user.id && !docActor(user).isHr) throw new ForbiddenException('Only the owner or HR can remove a document password');
      if (!doc.password_protected) throw new ConflictException('This document has no password');
      for (const v of await this.keyedVersions(db, documentId)) {
        const dek = await this.unlock(db, user, doc, v, dto.currentPassword, ctx);
        try {
          const w = await this.vault.wrapPlain(user.orgId, documentId, dek);
          await db.query(
            `UPDATE document_versions SET dek_wrapped_kms = $2, kms_key_id = $3, dek_wrapped_pw = NULL, pw_salt = NULL, pw_kdf_params = NULL,
               dek_wrapped_recovery = NULL, recovery_key_id = NULL WHERE id = $1`,
            [v.id, w.wrapped, w.keyId],
          );
        } finally {
          dek.fill(0);
        }
      }
      await db.query(`UPDATE documents SET password_protected = false, version = version + 1, updated_at = now() WHERE id = $1`, [documentId]);
      await logAccess(db, { orgId: user.orgId, documentId, userId: user.id, action: 'PASSWORD_REMOVED', ctx });
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'DOCUMENT_PASSWORD_REMOVED', entityType: 'DOCUMENT', entityId: documentId, ip: ctx.ip ?? undefined });
      return await this.summary(db, user, documentId);
    });
  }

  /** SRS 10.1 step 5: vault.recover re-wraps every version from the escrow with a new password. */
  async recoverPassword(user: AuthenticatedUser, documentId: string, dto: RecoverDocumentPasswordDto, ctx: RequestContext): Promise<DocumentSummary> {
    if (!userCan(user, Permission.VAULT_RECOVER)) throw new ForbiddenException('Recovery needs the vault.recover permission');
    const { ownerId, confidential } = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const doc = await loadDocument(db, user, documentId, LEVEL.VIEW, { forUpdate: true });
      if (!doc.password_protected) throw new ConflictException('This document has no password to recover');
      for (const v of await this.keyedVersions(db, documentId)) {
        const dek = await this.vault.recoveryDek(user.orgId, documentId, v);
        try {
          const w = await this.vault.wrapWithPassword(user.orgId, documentId, dek, dto.newPassword);
          await db.query(
            `UPDATE document_versions SET dek_wrapped_pw = $2, pw_salt = $3, pw_kdf_params = $4::jsonb, dek_wrapped_recovery = $5, recovery_key_id = $6, kms_key_id = $7 WHERE id = $1`,
            [v.id, w.dekWrappedPw, w.pwSalt, JSON.stringify(w.pwKdfParams), w.dekWrappedRecovery, w.recoveryKeyId, w.keyId],
          );
        } finally {
          dek.fill(0);
        }
      }
      await db.query(`UPDATE document_password_attempts SET failures = 0, locked_until = NULL WHERE document_id = $1`, [documentId]);
      await logAccess(db, { orgId: user.orgId, documentId, userId: user.id, action: 'RECOVER', ctx, detail: { reason: dto.reason } });
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'VAULT_RECOVER', entityType: 'DOCUMENT', entityId: documentId, after: { reason: dto.reason }, ip: ctx.ip ?? undefined });
      return { ownerId: doc.owner_id, confidential: doc.confidentiality !== 'NORMAL' };
    });
    const who = user.displayName ?? user.email;
    await this.notifications.notify(user.orgId, [{
      userId: ownerId, type: 'DOCUMENT_PASSWORD_RECOVERED',
      title: `${who} reset the password of ${confidential ? 'one of your confidential documents' : 'your document'}`,
      body: `Reason: ${dto.reason}. Ask ${who} for the new password, then change it.`,
      link: `/documents/${documentId}`, entityType: 'DOCUMENT', entityId: documentId, email: true,
    }]);
    return await this.prisma.runWithTenantContext(user.orgId, (db) => this.summary(db, user, documentId));
  }

  private async keyedVersions(db: Db, documentId: string): Promise<VersionRow[]> {
    const busy = await db.query(`SELECT 1 FROM document_versions WHERE document_id = $1 AND scan_status IN ('UPLOADING', 'PENDING')`, [documentId]);
    if ((busy.rowCount ?? 0) > 0) throw new ConflictException('Wait until the upload in progress has been scanned');
    const res = await db.query<VersionRow>(
      `SELECT * FROM document_versions WHERE document_id = $1 AND scan_status = 'CLEAN' AND (dek_wrapped_kms IS NOT NULL OR dek_wrapped_pw IS NOT NULL) ORDER BY version_no`,
      [documentId],
    );
    return res.rows;
  }

  // ---------------------------------------------------------------- FR-DOC-017 legal hold, trash, retention

  async setLegalHold(user: AuthenticatedUser, documentId: string, dto: LegalHoldDto, ctx: RequestContext): Promise<DocumentSummary> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await loadDocument(db, user, documentId, LEVEL.VIEW, { forUpdate: true, includeTrashed: true });
      await db.query(
        `UPDATE documents SET legal_hold = $2, legal_hold_reason = $3, legal_hold_by = $4, legal_hold_at = CASE WHEN $2 THEN now() ELSE NULL END,
           version = version + 1, updated_at = now() WHERE id = $1`,
        [documentId, dto.hold, dto.hold ? dto.reason : null, dto.hold ? user.id : null],
      );
      await logAccess(db, { orgId: user.orgId, documentId, userId: user.id, action: 'LEGAL_HOLD', ctx, detail: { hold: dto.hold, reason: dto.reason ?? null } });
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: dto.hold ? 'LEGAL_HOLD_PLACED' : 'LEGAL_HOLD_LIFTED', entityType: 'DOCUMENT', entityId: documentId, after: { reason: dto.reason ?? null } });
      return await this.summary(db, user, documentId, true);
    });
  }

  /** Delete = move to the trash for 30 days (then crypto-shredded); refused under hold or retention. */
  async assertDeletable(db: Db, orgId: string, doc: LoadedDocument): Promise<void> {
    if (doc.legal_hold) throw new ConflictException('This document is under legal hold');
    const rule = await db.query<{ min_years: number | null }>(`SELECT min_years FROM document_retention_rules WHERE org_id = $1 AND category = $2`, [orgId, doc.category]);
    const until = retentionBlocksDelete(doc.created_at, rule.rows[0]?.min_years ?? null, new Date(), doc.legal_hold);
    if (until) throw new ConflictException(`Retention policy: ${doc.category.toLowerCase()} documents are kept until ${until.toISOString().slice(0, 10)}`);
  }

  async trash(user: AuthenticatedUser): Promise<{ items: DocumentSummary[] }> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const params: unknown[] = [user.orgId];
      const level = levelSql(docActor(user), params);
      const res = await db.query<SummaryRow & { org_id: string }>(
        `SELECT * FROM (SELECT ${SUMMARY_COLUMNS}, d.org_id, ${level} AS level ${SUMMARY_FROM}
           WHERE d.org_id = $1 AND d.deleted_at IS NOT NULL AND d.shredded_at IS NULL) x
         WHERE x.level >= ${LEVEL.MANAGE} ORDER BY x.deleted_at DESC LIMIT 200`,
        params,
      );
      return { items: await Promise.all(res.rows.map(async (r) => mapSummary(r, await this.vault.titleOf(user.orgId, r)))) };
    });
  }

  async restoreFromTrash(user: AuthenticatedUser, documentId: string, ctx: RequestContext): Promise<DocumentSummary> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const doc = await loadDocument(db, user, documentId, LEVEL.MANAGE, { forUpdate: true, includeTrashed: true });
      if (!doc.deleted_at) throw new ConflictException('This document is not in the trash');
      if (Date.now() - doc.deleted_at.getTime() >= TRASH_DAYS * 86_400_000) throw new ConflictException('The trash period has ended');
      await db.query(`UPDATE documents SET deleted_at = NULL, deleted_by = NULL, version = version + 1, updated_at = now() WHERE id = $1`, [documentId]);
      await logAccess(db, { orgId: user.orgId, documentId, userId: user.id, action: 'TRASH_RESTORE', ctx });
      return await this.summary(db, user, documentId);
    });
  }

  async retentionRules(user: AuthenticatedUser): Promise<{ rules: RetentionRule[]; canManage: boolean }> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const res = await db.query<{ category: RetentionRule['category']; min_years: number | null; auto_shred_years: number | null }>(
        `SELECT category, min_years, auto_shred_years FROM document_retention_rules`,
      );
      const by = new Map(res.rows.map((r) => [r.category, r]));
      return {
        rules: DOCUMENT_CATEGORIES.map((c) => ({ category: c, minYears: by.get(c)?.min_years ?? null, autoShredYears: by.get(c)?.auto_shred_years ?? null })),
        canManage: userCan(user, Permission.DOCUMENTS_RETENTION),
      };
    });
  }

  async setRetentionRules(user: AuthenticatedUser, dto: RetentionRulesDto): Promise<{ rules: RetentionRule[]; canManage: boolean }> {
    const before = await this.retentionRules(user);
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      for (const r of dto.rules) {
        if (r.minYears === null && r.autoShredYears === null) {
          await db.query(`DELETE FROM document_retention_rules WHERE org_id = $1 AND category = $2`, [user.orgId, r.category]);
        } else {
          await db.query(
            `INSERT INTO document_retention_rules (org_id, category, min_years, auto_shred_years, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, now())
             ON CONFLICT (org_id, category) DO UPDATE SET min_years = EXCLUDED.min_years, auto_shred_years = EXCLUDED.auto_shred_years, updated_by = EXCLUDED.updated_by, updated_at = now()`,
            [user.orgId, r.category, r.minYears, r.autoShredYears, user.id],
          );
        }
      }
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'RETENTION_RULES_UPDATED', entityType: 'ORGANIZATION', entityId: user.orgId, before: before.rules, after: dto.rules });
    });
    return await this.retentionRules(user);
  }

  private async summary(db: Db, user: AuthenticatedUser, documentId: string, includeTrashed = false): Promise<DocumentSummary> {
    const row = await loadDocument(db, user, documentId, LEVEL.VIEW, { includeTrashed });
    return mapSummary(row, await this.vault.titleOf(user.orgId, row));
  }
}
