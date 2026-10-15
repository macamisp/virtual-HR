import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma.service.ts';
import type { RequestContext } from '../common/decorators/request-context.decorator.ts';
import { hasPermission, Permission, UserRole } from '../../../../packages/shared/src/auth/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import {
  MAX_UPLOAD_BYTES,
  UPLOAD_PART_BYTES,
} from '../../../../packages/shared/src/documents/types.ts';
import type {
  AclEntry,
  AclGrantDto,
  CompleteUploadDto,
  DocumentDetail,
  DocumentListQuery,
  DocumentMetaDto,
  DocumentSummary,
  DocumentVersion,
  StartUploadDto,
  UpdateDocumentDto,
  UploadState,
  UploadTicket,
} from '../../../../packages/shared/src/documents/types.ts';
import { toIso, userRef } from '../tasks/tasks.sql.ts';
import { generateDek, openSmall, sealSmall } from './crypto.ts';
import { OBJECT_STORE, PRESIGN_SECONDS, keys } from './object-store.ts';
import type { ObjectStore } from './object-store.ts';
import { allowedKindsFromEnv, extensionAllowed } from './sniff.ts';
import { LEVEL } from './document-policy.ts';
import { docActor, folderLevelSql, isPreviewableMime, isWatermarkableMime, levelSql, loadDocument, mapSummary, SUMMARY_COLUMNS, SUMMARY_FROM } from './documents.sql.ts';
import type { DocActor, LoadedDocument, SummaryRow, VersionRow } from './documents.sql.ts';
import { SCAN_DISPATCHER } from './scan-dispatcher.ts';
import type { ScanDispatcher } from './scan-dispatcher.ts';
import { logAccess } from './access-log.ts';
import { DocumentVault } from './document-vault.ts';
import { DocumentContent, watermarkText } from './document-content.service.ts';
import type { FileStream } from './document-content.service.ts';
import { VaultService } from './vault.service.ts';

type Db = pg.PoolClient;

/**
 * FR-DOC-001..004, 009, 012, 019. Uploads: start (presigned multipart URLs) → the browser PUTs
 * parts to storage → complete → the scanner sniffs, scans, encrypts (document-scanner.service).
 * A document is downloadable only through its newest CLEAN version.
 */
@Injectable()
export class DocumentsService {
  private readonly allowed = allowedKindsFromEnv();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(SCAN_DISPATCHER) private readonly scans: ScanDispatcher,
    private readonly vault: DocumentVault,
    private readonly vaultService: VaultService,
    private readonly content: DocumentContent,
  ) {}

  // ---------------------------------------------------------------- queries

  async list(user: AuthenticatedUser, q: DocumentListQuery): Promise<{ items: DocumentSummary[] }> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const params: unknown[] = [user.orgId];
      const level = levelSql(docActor(user), params);
      const where = ['d.org_id = $1', 'd.deleted_at IS NULL'];
      if (q.folderId) {
        params.push(q.folderId);
        where.push(`d.folder_id = $${params.length}`);
      }
      if (q.category) {
        params.push(q.category);
        where.push(`d.category = $${params.length}`);
      }
      if (q.linkedUserId) {
        params.push(q.linkedUserId);
        where.push(`d.linked_user_id = $${params.length}`);
      }
      if (q.q) {
        params.push(`%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, q.q.toLowerCase());
        where.push(`(d.title ILIKE $${params.length - 1} OR $${params.length} = ANY (SELECT lower(t) FROM unnest(d.tags) t))`);
      }
      if (q.expiringWithinDays) {
        params.push(q.expiringWithinDays);
        where.push(`d.expires_at IS NOT NULL AND d.expires_at <= CURRENT_DATE + $${params.length}::int`);
      }
      params.push(q.limit);
      const res = await db.query<SummaryRow>(
        `SELECT * FROM (SELECT ${SUMMARY_COLUMNS}, ${level} AS level ${SUMMARY_FROM} WHERE ${where.join(' AND ')}) x
         WHERE x.level > 0 ORDER BY x.updated_at DESC LIMIT $${params.length}`,
        params,
      );
      return { items: await Promise.all(res.rows.map(async (r) => mapSummary(r, await this.vault.titleOf(user.orgId, { ...r, id: r.id })))) };
    });
  }

  async detail(user: AuthenticatedUser, id: string, ctx: RequestContext): Promise<DocumentDetail> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const row = await this.load(db, user, id, LEVEL.VIEW);
      await logAccess(db, { orgId: user.orgId, documentId: id, userId: user.id, action: 'VIEW', ctx, detail: { what: 'details' } });
      return await this.buildDetail(db, row);
    });
  }

  // ---------------------------------------------------------------- uploads (FR-DOC-001, 004)

  async startUpload(user: AuthenticatedUser, dto: StartUploadDto, ctx: RequestContext = { ip: null, userAgent: null }): Promise<UploadTicket> {
    if (!extensionAllowed(dto.fileName, this.allowed)) throw new BadRequestException('This file type is not allowed');
    if (dto.size > MAX_UPLOAD_BYTES) throw new BadRequestException('Files can be at most 100 MB');
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      let documentId: string;
      let protectedDoc: LoadedDocument | null = null;
      if (dto.documentId) {
        const row = await this.load(db, user, dto.documentId, LEVEL.EDIT, true);
        const busy = await db.query(`SELECT 1 FROM document_versions WHERE document_id = $1 AND scan_status IN ('UPLOADING', 'PENDING')`, [row.id]);
        if ((busy.rowCount ?? 0) > 0) throw new ConflictException('A version of this document is still being uploaded or scanned');
        documentId = row.id;
        if (row.password_protected) protectedDoc = row;
      } else {
        const meta = await this.checkMeta(db, user, dto.metadata!, null);
        documentId = randomUUID();
        // FR-DOC-007: titles of CONFIDENTIAL/RESTRICTED documents are stored only sealed.
        const sealed = meta.confidentiality === 'NORMAL' ? null : await this.vault.sealTitle(user.orgId, documentId, meta.title);
        await db.query(
          `INSERT INTO documents (id, org_id, folder_id, title, title_enc, meta_key_wrapped, meta_key_id, category, confidentiality, owner_id,
             linked_user_id, linked_contract_id, linked_project_id, tags, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::text[], $15::date)`,
          [documentId, user.orgId, meta.folderId ?? null, sealed ? null : meta.title, sealed?.titleEnc ?? null, sealed?.metaKeyWrapped ?? null, sealed?.metaKeyId ?? null,
            meta.category, meta.confidentiality, user.id, meta.linkedUserId ?? null, meta.linkedContractId ?? null, meta.linkedProjectId ?? null, meta.tags, meta.expiresAt ?? null],
        );
        if (meta.linkedContractId) await this.attachToContract(db, meta.linkedContractId, documentId);
      }
      const next = await db.query<{ n: number }>(`SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM document_versions WHERE document_id = $1`, [documentId]);
      const versionNo = next.rows[0]!.n;
      // FR-DOC-007: a fresh data key per version; only its KMS-wrapped form is stored.
      // FR-DOC-006: a new version of a password-protected document needs the password; it is
      // checked by opening an existing version, then the new key is wrapped with it as well.
      if (protectedDoc) {
        const prev = await db.query<VersionRow>(
          `SELECT * FROM document_versions WHERE document_id = $1 AND dek_wrapped_pw IS NOT NULL ORDER BY version_no DESC LIMIT 1`,
          [documentId],
        );
        if (prev.rows[0]) (await this.vaultService.unlock(db, user, protectedDoc, prev.rows[0], dto.documentPassword, ctx)).fill(0);
      }
      const dek = generateDek();
      try {
        // The scanner needs a KMS-only wrap to encrypt; for protected documents it is destroyed
        // once the scan has finished (document-scanner.service).
        const wrapped = await this.vault.wrapPlain(user.orgId, documentId, dek);
        const pw = protectedDoc ? await this.vault.wrapWithPassword(user.orgId, documentId, dek, dto.documentPassword!) : null;
        const ver = await db.query<{ id: string }>(
          `INSERT INTO document_versions (org_id, document_id, version_no, file_name_enc, declared_size, dek_wrapped_kms, kms_key_id, uploaded_by,
             dek_wrapped_pw, pw_salt, pw_kdf_params, dek_wrapped_recovery, recovery_key_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13) RETURNING id`,
          [user.orgId, documentId, versionNo, sealSmall(dek, dto.fileName), dto.size, wrapped.wrapped, wrapped.keyId, user.id,
            pw?.dekWrappedPw ?? null, pw?.pwSalt ?? null, pw ? JSON.stringify(pw.pwKdfParams) : null, pw?.dekWrappedRecovery ?? null, pw?.recoveryKeyId ?? null],
        );
        const versionId = ver.rows[0]!.id;
        const staging = keys.staging(user.orgId, documentId, versionId);
        const uploadId = await this.store.createMultipart(staging);
        await db.query(`UPDATE document_versions SET staging_key = $2, upload_id = $3 WHERE id = $1`, [versionId, staging, uploadId]);
        const partCount = Math.max(1, Math.ceil(dto.size / UPLOAD_PART_BYTES));
        const parts = [];
        for (let n = 1; n <= partCount; n += 1) parts.push({ partNumber: n, url: await this.store.presignPart(staging, uploadId, n) });
        return { documentId, versionId, partSize: UPLOAD_PART_BYTES, partCount, parts, expiresAt: new Date(Date.now() + PRESIGN_SECONDS * 1000).toISOString() };
      } finally {
        dek.fill(0);
      }
    });
  }

  /** Fresh part URLs (they expire after 5 minutes): resumable uploads. */
  async partUrls(user: AuthenticatedUser, versionId: string, partNumbers: number[]): Promise<UploadTicket> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const v = await this.ownUpload(db, user, versionId);
      const partCount = Math.max(1, Math.ceil(Number(v.declared_size) / UPLOAD_PART_BYTES));
      if (partNumbers.some((n) => n > partCount)) throw new BadRequestException(`This upload has ${partCount} parts`);
      const parts = [];
      for (const n of partNumbers) parts.push({ partNumber: n, url: await this.store.presignPart(v.staging_key!, v.upload_id!, n) });
      return { documentId: v.document_id, versionId, partSize: UPLOAD_PART_BYTES, partCount, parts, expiresAt: new Date(Date.now() + PRESIGN_SECONDS * 1000).toISOString() };
    });
  }

  async uploadState(user: AuthenticatedUser, versionId: string): Promise<UploadState> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const res = await db.query<VersionRow>(`SELECT * FROM document_versions WHERE id = $1 AND uploaded_by = $2`, [versionId, user.id]);
      const v = res.rows[0];
      if (!v) throw new NotFoundException('Upload not found');
      const partCount = Math.max(1, Math.ceil(Number(v.declared_size) / UPLOAD_PART_BYTES));
      const uploadedParts = v.scan_status === 'UPLOADING' && v.upload_id ? await this.store.listParts(v.staging_key!, v.upload_id) : [];
      return { versionId, status: v.scan_status, uploadedParts, partSize: UPLOAD_PART_BYTES, partCount };
    });
  }

  async completeUpload(user: AuthenticatedUser, versionId: string, dto: CompleteUploadDto, ctx: RequestContext): Promise<DocumentDetail> {
    const outcome = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const v = await this.ownUpload(db, user, versionId);
      try {
        await this.store.completeMultipart(v.staging_key!, v.upload_id!, dto.parts);
      } catch {
        throw new BadRequestException('The upload is incomplete: some parts are missing or do not match');
      }
      const size = await this.store.size(v.staging_key!);
      if (size > MAX_UPLOAD_BYTES || size !== Number(v.declared_size)) {
        await this.store.remove(v.staging_key!).catch(() => undefined);
        await db.query(
          `UPDATE document_versions SET scan_status = 'REJECTED', scan_detail = $2, size_bytes = $3, completed_at = now() WHERE id = $1`,
          [versionId, size > MAX_UPLOAD_BYTES ? 'Larger than 100 MB' : 'The uploaded size does not match the announced size', size],
        );
        return { scan: false, documentId: v.document_id };
      }
      await db.query(`UPDATE document_versions SET scan_status = 'PENDING', size_bytes = $2, completed_at = now(), upload_id = NULL WHERE id = $1`, [versionId, size]);
      await logAccess(db, { orgId: user.orgId, documentId: v.document_id, versionId, userId: user.id, action: 'UPLOAD', ctx, detail: { versionNo: v.version_no, sizeBytes: size } });
      return { scan: true, documentId: v.document_id };
    });
    // FR-DOC-013: nothing is available until the scanner marks the version CLEAN.
    if (outcome.scan) await this.scans.dispatchScan(user.orgId, versionId);
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => await this.buildDetail(db, await this.load(db, user, outcome.documentId, LEVEL.VIEW)));
  }

  async abortUpload(user: AuthenticatedUser, versionId: string): Promise<{ aborted: true }> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const v = await this.ownUpload(db, user, versionId);
      await this.store.abortMultipart(v.staging_key!, v.upload_id!).catch(() => undefined);
      await db.query(`UPDATE document_versions SET scan_status = 'REJECTED', scan_detail = 'Upload cancelled', upload_id = NULL WHERE id = $1`, [versionId]);
      // A brand-new document whose only upload was cancelled disappears.
      await db.query(
        `UPDATE documents SET deleted_at = now() WHERE id = $1 AND current_version_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM document_versions WHERE document_id = $1 AND scan_status IN ('UPLOADING', 'PENDING', 'CLEAN'))`,
        [v.document_id],
      );
      return { aborted: true as const };
    });
  }

  // ---------------------------------------------------------------- content (FR-DOC-019, 012)

  /**
   * The content of a CLEAN version (FR-DOC-005, 006, 011, 019):
   *  - download / preview: the original file; needs DOWNLOAD (a VIEW-only user asking for a
   *    preview gets the watermarked view-only rendering instead);
   *  - view: the watermarked rendering (viewer, time, IP); VIEW is enough.
   * CONFIDENTIAL/RESTRICTED need a re-authentication within the window; protected documents
   * need their password (3 wrong attempts: 15-minute lockout, HR notified).
   */
  async open(
    user: AuthenticatedUser,
    documentId: string,
    req: { mode: 'download' | 'preview' | 'view'; versionId?: string; password?: string },
    ctx: RequestContext,
  ): Promise<FileStream> {
    const { v, dek, mode } = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const doc = await this.load(db, user, documentId, LEVEL.VIEW);
      let mode = req.mode;
      if (mode === 'download' && doc.level < LEVEL.DOWNLOAD) throw new ForbiddenException('You may view this document but not download it');
      if (mode === 'preview' && doc.level < LEVEL.DOWNLOAD) mode = 'view';
      const res = await db.query<VersionRow>(
        // Without a current (clean) version, the newest one explains why nothing can be opened.
        `SELECT * FROM document_versions WHERE document_id = $1 AND ${req.versionId ? 'id = $2' : `id = COALESCE((SELECT current_version_id FROM documents WHERE id = $1),
           (SELECT id FROM document_versions WHERE document_id = $1 ORDER BY version_no DESC LIMIT 1))`}`,
        req.versionId ? [documentId, req.versionId] : [documentId],
      );
      const ver = res.rows[0];
      if (!ver) throw new NotFoundException('Version not found');
      if (ver.scan_status !== 'CLEAN') {
        throw new ConflictException(ver.scan_status === 'INFECTED' ? 'This file is quarantined' : ver.scan_status === 'REJECTED' ? 'This file was rejected' : 'This file is still being checked for viruses');
      }
      if (mode === 'preview' && !isPreviewableMime(ver.mime_type)) throw new BadRequestException('Only PDFs and images can be previewed');
      if (mode === 'view' && !isWatermarkableMime(ver.mime_type)) throw new BadRequestException('View-only mode is available for PDFs, PNG and JPEG images');
      await this.vaultService.assertReauth(db, user, doc, ctx);
      const key = await this.vaultService.unlock(db, user, doc, ver, req.password, ctx);
      await logAccess(db, { orgId: user.orgId, documentId, versionId: ver.id, userId: user.id, action: mode === 'download' ? 'DOWNLOAD' : 'VIEW', ctx, detail: { versionNo: ver.version_no, mode } });
      return { v: ver, dek: key, mode };
    });
    if (mode === 'view') return await this.content.viewOnly(v, dek, watermarkText(user.displayName ?? user.email, ctx.ip));
    return await this.content.original(v, dek);
  }

  // ---------------------------------------------------------------- metadata, versions, deletion

  async update(user: AuthenticatedUser, id: string, dto: UpdateDocumentDto, ctx: RequestContext): Promise<DocumentDetail> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const row = await this.load(db, user, id, LEVEL.EDIT, true);
      if (row.version !== dto.version) throw new ConflictException('This document changed since you opened it; reload and try again');
      const merged: DocumentMetaDto = {
        title: dto.title ?? (await this.vault.titleOf(user.orgId, row)),
        category: dto.category ?? row.category,
        confidentiality: dto.confidentiality ?? row.confidentiality,
        folderId: dto.folderId !== undefined ? dto.folderId : row.folder_id,
        linkedUserId: dto.linkedUserId !== undefined ? dto.linkedUserId : row.linked_user_id,
        linkedContractId: dto.linkedContractId !== undefined ? dto.linkedContractId : row.linked_contract_id,
        linkedProjectId: dto.linkedProjectId !== undefined ? dto.linkedProjectId : row.linked_project_id,
        tags: dto.tags ?? row.tags,
        expiresAt: dto.expiresAt !== undefined ? dto.expiresAt : row.expires_at,
      };
      if (dto.confidentiality && dto.confidentiality !== row.confidentiality && row.level < LEVEL.MANAGE) {
        throw new ForbiddenException('Changing the confidentiality level needs MANAGE');
      }
      const meta = await this.checkMeta(db, user, merged, row);
      // FR-DOC-007: confidential titles are sealed (re-using the document's metadata key).
      const sealed = meta.confidentiality === 'NORMAL'
        ? null
        : await this.vault.sealTitle(user.orgId, id, meta.title, row.meta_key_wrapped && row.meta_key_id ? { wrapped: row.meta_key_wrapped, keyId: row.meta_key_id } : null);
      await db.query(
        `UPDATE documents SET title = $2, title_enc = $11, meta_key_wrapped = $12, meta_key_id = $13, category = $3, confidentiality = $4, folder_id = $5,
           linked_user_id = $6, linked_contract_id = $7, linked_project_id = $8, tags = $9::text[], expires_at = $10::date, version = version + 1, updated_at = now()
         WHERE id = $1`,
        [id, sealed ? null : meta.title, meta.category, meta.confidentiality, meta.folderId ?? null, meta.linkedUserId ?? null, meta.linkedContractId ?? null,
          meta.linkedProjectId ?? null, meta.tags, meta.expiresAt ?? null, sealed?.titleEnc ?? null, sealed?.metaKeyWrapped ?? null, sealed?.metaKeyId ?? null],
      );
      if (meta.linkedContractId !== row.linked_contract_id) {
        await db.query(`UPDATE contracts SET document_id = NULL, updated_at = now() WHERE document_id = $1`, [id]);
        if (meta.linkedContractId) await this.attachToContract(db, meta.linkedContractId, id);
      }
      const changed = Object.keys(dto).filter((k) => k !== 'version');
      await logAccess(db, { orgId: user.orgId, documentId: id, userId: user.id, action: 'UPDATE', ctx, detail: { fields: changed } });
      return await this.buildDetail(db, await this.load(db, user, id, LEVEL.VIEW));
    });
  }

  /** FR-DOC-004: restoring makes a new version with the old content (nothing is overwritten). */
  async restore(user: AuthenticatedUser, id: string, versionId: string, ctx: RequestContext): Promise<DocumentDetail> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await this.load(db, user, id, LEVEL.EDIT, true);
      const res = await db.query<VersionRow>(`SELECT * FROM document_versions WHERE id = $1 AND document_id = $2`, [versionId, id]);
      const src = res.rows[0];
      if (!src) throw new NotFoundException('Version not found');
      if (src.scan_status !== 'CLEAN') throw new ConflictException('Only clean versions can be restored');
      const current = await db.query<{ current_version_id: string | null }>(`SELECT current_version_id FROM documents WHERE id = $1`, [id]);
      if (current.rows[0]?.current_version_id === versionId) throw new ConflictException('This is already the current version');
      const next = await db.query<{ n: number }>(`SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM document_versions WHERE document_id = $1`, [id]);
      const created = await db.query<{ id: string }>(
        `INSERT INTO document_versions (org_id, document_id, version_no, storage_key, file_name_enc, mime_type, size_bytes, declared_size, sha256,
           dek_wrapped_kms, kms_key_id, iv, auth_tag, dek_wrapped_pw, pw_salt, pw_kdf_params, dek_wrapped_recovery, recovery_key_id,
           scan_status, scan_detail, restored_from_id, uploaded_by, completed_at, scanned_at)
         SELECT org_id, document_id, $3, storage_key, file_name_enc, mime_type, size_bytes, declared_size, sha256,
           dek_wrapped_kms, kms_key_id, iv, auth_tag, dek_wrapped_pw, pw_salt, pw_kdf_params, dek_wrapped_recovery, recovery_key_id,
           'CLEAN', scan_detail, id, $4, now(), scanned_at
         FROM document_versions WHERE id = $1 AND document_id = $2 RETURNING id`,
        [versionId, id, next.rows[0]!.n, user.id],
      );
      await db.query(`UPDATE documents SET current_version_id = $2, version = version + 1, updated_at = now() WHERE id = $1`, [id, created.rows[0]!.id]);
      await logAccess(db, { orgId: user.orgId, documentId: id, versionId: created.rows[0]!.id, userId: user.id, action: 'RESTORE', ctx, detail: { restoredFromVersionNo: src.version_no } });
      return await this.buildDetail(db, await this.load(db, user, id, LEVEL.VIEW));
    });
  }

  /** FR-DOC-017: to the trash (restorable for 30 days, then crypto-shredded); hold and retention apply. */
  async remove(user: AuthenticatedUser, id: string, ctx: RequestContext): Promise<{ deleted: true; shredAfter: string }> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const row = await this.load(db, user, id, LEVEL.MANAGE, true);
      await this.vaultService.assertDeletable(db, user.orgId, row);
      await db.query(`UPDATE documents SET deleted_at = now(), deleted_by = $2, version = version + 1, updated_at = now() WHERE id = $1`, [id, user.id]);
      await db.query(`UPDATE contracts SET document_id = NULL, updated_at = now() WHERE document_id = $1`, [id]);
      // A confidential title never goes into the log in clear.
      await logAccess(db, { orgId: user.orgId, documentId: id, userId: user.id, action: 'DELETE', ctx, detail: { title: row.title ?? '(confidential)', trash: true } });
      return { deleted: true as const, shredAfter: new Date(Date.now() + 30 * 86_400_000).toISOString() };
    });
  }

  // ---------------------------------------------------------------- ACL (FR-DOC-009)

  async acl(user: AuthenticatedUser, target: { documentId?: string; folderId?: string }): Promise<{ items: AclEntry[] }> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await this.assertManage(db, user, target);
      return { items: await this.aclEntries(db, target) };
    });
  }

  async grant(user: AuthenticatedUser, target: { documentId?: string; folderId?: string }, dto: AclGrantDto, ctx: RequestContext): Promise<{ items: AclEntry[] }> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await this.assertManage(db, user, target);
      if (dto.principalType === 'USER') {
        const u = await db.query(`SELECT 1 FROM users WHERE id = $1 AND status = 'ACTIVE'`, [dto.principalId]);
        if (u.rowCount === 0) throw new BadRequestException('No such active user');
      } else if (dto.principalType === 'TEAM') {
        const t = await db.query(`SELECT 1 FROM teams WHERE id = $1`, [dto.principalId]);
        if (t.rowCount === 0) throw new BadRequestException('No such team');
      } else if (!(Object.values(UserRole) as string[]).includes(dto.principalRole!)) {
        throw new BadRequestException('No such role');
      }
      if (dto.expiresAt && Date.parse(dto.expiresAt) <= Date.now()) throw new BadRequestException('The expiry must be in the future');
      try {
        await db.query(
          `INSERT INTO document_acl (org_id, document_id, folder_id, principal_type, principal_id, principal_role, permission, expires_at, granted_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [user.orgId, target.documentId ?? null, target.folderId ?? null, dto.principalType, dto.principalId ?? null, dto.principalRole ?? null, dto.permission, dto.expiresAt ?? null, user.id],
        );
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new ConflictException('This grant already exists');
        throw err;
      }
      await logAccess(db, {
        orgId: user.orgId, documentId: target.documentId ?? null, userId: user.id, action: 'ACL_CHANGE', ctx,
        detail: { change: 'GRANT', folderId: target.folderId ?? null, principalType: dto.principalType, principal: dto.principalId ?? dto.principalRole, permission: dto.permission, expiresAt: dto.expiresAt ?? null },
      });
      return { items: await this.aclEntries(db, target) };
    });
  }

  async revoke(user: AuthenticatedUser, target: { documentId?: string; folderId?: string }, aclId: string, ctx: RequestContext): Promise<{ items: AclEntry[] }> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await this.assertManage(db, user, target);
      const res = await db.query<{ principal_type: string; principal_id: string | null; principal_role: string | null; permission: string }>(
        `DELETE FROM document_acl WHERE id = $1 AND ${target.documentId ? 'document_id = $2' : 'folder_id = $2'}
         RETURNING principal_type, principal_id, principal_role, permission`,
        [aclId, target.documentId ?? target.folderId],
      );
      const gone = res.rows[0];
      if (!gone) throw new NotFoundException('Grant not found');
      await logAccess(db, {
        orgId: user.orgId, documentId: target.documentId ?? null, userId: user.id, action: 'ACL_CHANGE', ctx,
        detail: { change: 'REVOKE', folderId: target.folderId ?? null, principalType: gone.principal_type, principal: gone.principal_id ?? gone.principal_role, permission: gone.permission },
      });
      return { items: await this.aclEntries(db, target) };
    });
  }

  // ---------------------------------------------------------------- helpers

  private async load(db: Db, user: AuthenticatedUser, id: string, need: number, forUpdate = false): Promise<LoadedDocument> {
    return await loadDocument(db, user, id, need, { forUpdate });
  }

  private async ownUpload(db: Db, user: AuthenticatedUser, versionId: string): Promise<VersionRow> {
    const res = await db.query<VersionRow>(`SELECT * FROM document_versions WHERE id = $1 AND uploaded_by = $2 FOR UPDATE`, [versionId, user.id]);
    const v = res.rows[0];
    if (!v) throw new NotFoundException('Upload not found');
    if (v.scan_status !== 'UPLOADING' || !v.upload_id) throw new ConflictException('This upload is already finished');
    return v;
  }

  private async assertManage(db: Db, user: AuthenticatedUser, target: { documentId?: string; folderId?: string }): Promise<void> {
    if (target.documentId) {
      await this.load(db, user, target.documentId, LEVEL.MANAGE);
      return;
    }
    const params: unknown[] = [target.folderId];
    const level = folderLevelSql(docActor(user), params, '$1::uuid');
    const res = await db.query<{ level: number }>(`SELECT ${level} AS level FROM document_folders WHERE id = $1`, params);
    if (!res.rows[0] || res.rows[0].level < LEVEL.VIEW) throw new NotFoundException('Folder not found');
    if (res.rows[0].level < LEVEL.MANAGE) throw new ForbiddenException('You do not manage this folder');
  }

  /**
   * Who may set which links (FR-DOC-003). Non-HR users may link only themselves; contracts are
   * linked by contract managers; projects by their members. Uploading into a folder needs EDIT.
   */
  private async checkMeta(db: Db, user: AuthenticatedUser, meta: DocumentMetaDto, existing: SummaryRow | null): Promise<DocumentMetaDto> {
    const a: DocActor = docActor(user);
    const out = { ...meta, tags: [...new Set(meta.tags.map((t) => t.trim()).filter(Boolean))] };
    if (!existing && out.linkedUserId === undefined && user.role === 'SUBCONTRACTOR') out.linkedUserId = user.id;
    if (out.folderId && out.folderId !== existing?.folder_id) {
      const params: unknown[] = [out.folderId];
      const level = folderLevelSql(a, params, '$1::uuid');
      const f = await db.query<{ level: number }>(`SELECT ${level} AS level FROM document_folders WHERE id = $1`, params);
      if (!f.rows[0] || f.rows[0].level < LEVEL.VIEW) throw new BadRequestException('Folder not found');
      if (f.rows[0].level < LEVEL.EDIT) throw new ForbiddenException('You cannot add documents to this folder');
    }
    if (out.linkedUserId && out.linkedUserId !== existing?.linked_user_id) {
      if (!a.isHr && out.linkedUserId !== user.id) throw new ForbiddenException('Only HR can link a document to someone else');
      const u = await db.query(`SELECT 1 FROM users WHERE id = $1`, [out.linkedUserId]);
      if (u.rowCount === 0) throw new BadRequestException('Linked user not found');
    }
    if (out.linkedContractId && out.linkedContractId !== existing?.linked_contract_id) {
      if (!hasPermission(user.role, Permission.CONTRACTS_MANAGE)) throw new ForbiddenException('Only contract managers link contracts');
      const c = await db.query<{ user_id: string }>(`SELECT user_id FROM contracts WHERE id = $1`, [out.linkedContractId]);
      if (!c.rows[0]) throw new BadRequestException('Contract not found');
      out.linkedUserId ??= c.rows[0].user_id;
    }
    if (out.linkedProjectId && out.linkedProjectId !== existing?.linked_project_id) {
      const p = await db.query(
        `SELECT 1 FROM projects p WHERE p.id = $1 AND ($3 OR p.manager_id = $2 OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = $2))`,
        [out.linkedProjectId, user.id, a.isHr || hasPermission(user.role, Permission.TASKS_READ_ALL)],
      );
      if (p.rowCount === 0) throw new BadRequestException('Project not found');
    }
    return out;
  }

  private async attachToContract(db: Db, contractId: string, documentId: string): Promise<void> {
    await db.query(`UPDATE documents SET linked_contract_id = NULL WHERE linked_contract_id = $1 AND id <> $2 AND id = (SELECT document_id FROM contracts WHERE id = $1)`, [contractId, documentId]);
    await db.query(`UPDATE contracts SET document_id = $2, updated_at = now() WHERE id = $1`, [contractId, documentId]);
  }

  private async aclEntries(db: Db, target: { documentId?: string; folderId?: string }): Promise<AclEntry[]> {
    // A document's list also shows what it inherits from its folders.
    const res = await db.query<{ id: string; document_id: string | null; folder_id: string | null; folder_name: string | null; principal_type: AclEntry['principalType']; principal_id: string | null; principal_role: string | null; permission: AclEntry['permission']; expires_at: Date | null; created_at: Date; granted_by: string; g_name: string | null; g_email: string; g_role: string; u_label: string | null; t_label: string | null }>(
      `WITH RECURSIVE chain(fid, depth) AS (
         SELECT ${target.documentId ? '(SELECT folder_id FROM documents WHERE id = $1)' : '$1::uuid'}, 0
         UNION ALL SELECT f.parent_id, c.depth + 1 FROM document_folders f JOIN chain c ON f.id = c.fid WHERE c.fid IS NOT NULL AND c.depth < 32)
       SELECT a.id, a.document_id, a.folder_id, fo.name AS folder_name, a.principal_type, a.principal_id, a.principal_role, a.permission,
              a.expires_at, a.created_at, a.granted_by, g.display_name AS g_name, g.email AS g_email, g.role AS g_role,
              COALESCE(pu.display_name, pu.email) AS u_label, pt.name AS t_label
       FROM document_acl a
       JOIN users g ON g.id = a.granted_by
       LEFT JOIN document_folders fo ON fo.id = a.folder_id
       LEFT JOIN users pu ON a.principal_type = 'USER' AND pu.id = a.principal_id
       LEFT JOIN teams pt ON a.principal_type = 'TEAM' AND pt.id = a.principal_id
       WHERE ${target.documentId ? 'a.document_id = $1 OR ' : ''}a.folder_id IN (SELECT fid FROM chain WHERE fid IS NOT NULL)
       ORDER BY a.document_id NULLS LAST, a.created_at`,
      [target.documentId ?? target.folderId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      target: r.document_id ? ('DOCUMENT' as const) : ('FOLDER' as const),
      folderName: r.folder_name,
      principalType: r.principal_type,
      principalId: r.principal_id,
      principalLabel: r.principal_type === 'ROLE' ? `Role: ${r.principal_role}` : r.principal_type === 'TEAM' ? `Team: ${r.t_label ?? 'unknown'}` : (r.u_label ?? 'unknown user'),
      permission: r.permission,
      expiresAt: toIso(r.expires_at),
      expired: !!r.expires_at && r.expires_at.getTime() <= Date.now(),
      grantedBy: userRef(r.granted_by, r.g_name, r.g_email, r.g_role),
      createdAt: toIso(r.created_at)!,
    }));
  }

  private async buildDetail(db: Db, row: LoadedDocument): Promise<DocumentDetail> {
    const vres = await db.query<VersionRow & { u_name: string | null; u_email: string; u_role: string; restored_no: number | null; is_current: boolean }>(
      `SELECT v.*, u.display_name AS u_name, u.email AS u_email, u.role AS u_role, r.version_no AS restored_no,
              COALESCE(v.id = d.current_version_id, false) AS is_current
       FROM document_versions v JOIN users u ON u.id = v.uploaded_by JOIN documents d ON d.id = v.document_id
       LEFT JOIN document_versions r ON r.id = v.restored_from_id
       WHERE v.document_id = $1
       ORDER BY v.version_no DESC`,
      [row.id],
    );
    const versions: DocumentVersion[] = [];
    const orgId = row.org_id;
    for (const v of vres.rows) {
      // File names are sealed with the version key: unreadable without the password in
      // password mode (FR-DOC-006), gone after shredding.
      let fileName = v.dek_wrapped_kms ? '(name unavailable)' : v.dek_wrapped_pw ? '(protected by a password)' : '(destroyed)';
      if (v.dek_wrapped_kms && v.file_name_enc) {
        try {
          const dek = await this.vault.versionDek(orgId, row.id, { ...v, dek_wrapped_pw: null, pw_salt: null });
          fileName = openSmall(dek, v.file_name_enc);
          dek.fill(0);
        } catch {
          // A key problem must not hide the rest of the document.
        }
      }
      versions.push({
        id: v.id,
        versionNo: v.version_no,
        fileName,
        mimeType: v.mime_type,
        sizeBytes: v.size_bytes === null ? null : Number(v.size_bytes),
        sha256: v.sha256,
        scanStatus: v.scan_status,
        scanDetail: v.scan_detail,
        uploadedBy: userRef(v.uploaded_by, v.u_name, v.u_email, v.u_role),
        uploadedAt: toIso(v.uploaded_at)!,
        scannedAt: toIso(v.scanned_at),
        restoredFromVersionNo: v.restored_no,
        isCurrent: v.is_current,
      });
    }
    return { ...mapSummary(row, await this.vault.titleOf(orgId, row)), versions, createdAt: toIso(row.created_at)! };
  }
}
