/**
 * Simple in-app e-signature (SRS 5.8 FR-DOC-014; ADR 022).
 *
 * A document manager asks colleagues to sign the current PDF version. Each signer re-authenticates
 * (password or TOTP, the vault window), accepts the consent text and draws or types a signature;
 * the server records time (its own clock), IP, browser and the re-authentication time. When all
 * have signed, the server re-checks the source's SHA-256, appends a signature page and an audit
 * certificate with pdf-lib, and stores the result as a new version through the normal scan and
 * encryption path. Signing a changed document is refused. Not a qualified/advanced signature.
 */
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type pg from 'pg';
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import { formatInTimeZone } from 'date-fns-tz';
import { PrismaService } from '../common/prisma.service.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import type { RequestContext } from '../common/decorators/request-context.decorator.ts';
import { NotificationsService } from '../notifications/notifications.service.ts';
import { KEY_PROVIDER, generateDek, openSmall, sealSmall } from './crypto.ts';
import type { KeyProvider } from './crypto.ts';
import { DocumentVault } from './document-vault.ts';
import { DocumentContent } from './document-content.service.ts';
import { VaultService } from './vault.service.ts';
import { loadDocument } from './documents.sql.ts';
import type { VersionRow } from './documents.sql.ts';
import { LEVEL } from './document-policy.ts';
import { logAccess } from './access-log.ts';
import { OBJECT_STORE, keys as storeKeys } from './object-store.ts';
import type { ObjectStore } from './object-store.ts';
import { SCAN_DISPATCHER } from './scan-dispatcher.ts';
import type { ScanDispatcher } from './scan-dispatcher.ts';
import { ESIGN_CONSENT, NotificationType } from '../../../../packages/shared/src/index.ts';
import type { AuthenticatedUser, SignatureRequest, SignatureRequestDto, SignatureVerification, SignDto } from '../../../../packages/shared/src/index.ts';

interface ReqRow {
  id: string; org_id: string; document_id: string; source_version_id: string; source_sha256: string; requested_by: string; message: string;
  status: SignatureRequest['status']; signed_version_id: string | null; signed_sha256: string | null; key_wrapped: Buffer; key_id: string;
  created_at: Date; completed_at: Date | null; requester_name: string | null; requester_email: string;
}
interface SignerRow {
  request_id: string; user_id: string; order_no: number; status: 'PENDING' | 'SIGNED' | 'DECLINED'; method: 'DRAW' | 'TYPE' | null; typed_name: string | null;
  image_sealed: Buffer | null; signed_at: Date | null; reauth_at: Date | null; consent_version: string | null; ip: string | null; user_agent: string | null;
  decline_reason: string | null; display_name: string | null; email: string;
}

const MAX_PNG = 150 * 1024;
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const webUrl = () => (process.env.APP_WEB_URL || 'http://localhost:3000').replace(/\/$/, '');

/** PNG check without decoding: signature bytes, IHDR, sane dimensions. */
function checkPng(b: Buffer): void {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (b.length < 33 || b.length > MAX_PNG || !b.subarray(0, 8).equals(sig) || b.toString('latin1', 12, 16) !== 'IHDR') throw new BadRequestException('The signature must be a PNG image of at most 150 KB');
  const w = b.readUInt32BE(16);
  const h = b.readUInt32BE(20);
  if (w < 20 || h < 10 || w > 2000 || h > 1000) throw new BadRequestException('The signature image has unusual dimensions');
}

/** Standard PDF fonts cover Latin-1 only: other characters become "?" instead of failing. */
function safe(font: PDFFont, text: string): string {
  let out = '';
  for (const ch of text) {
    try { font.encodeText(ch); out += ch; } catch { out += '?'; }
  }
  return out;
}

@Injectable()
export class EsignService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly vault: DocumentVault,
    private readonly content: DocumentContent,
    private readonly vaultService: VaultService,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(SCAN_DISPATCHER) private readonly scans: ScanDispatcher,
  ) {}

  // ------------------------------------------------------------------ reading

  private async row(db: pg.PoolClient, id: string, lock = false): Promise<ReqRow> {
    const r = (await db.query<ReqRow>(
      `SELECT r.*, u.display_name AS requester_name, u.email AS requester_email FROM signature_requests r JOIN users u ON u.id = r.requested_by
       WHERE r.id = $1${lock ? ' FOR UPDATE OF r' : ''}`, [id])).rows[0];
    if (!r) throw new NotFoundException('Signature request not found');
    return r;
  }

  private async signers(db: pg.PoolClient, id: string): Promise<SignerRow[]> {
    return (await db.query<SignerRow>(
      `SELECT s.*, u.display_name, u.email FROM signature_signers s JOIN users u ON u.id = s.user_id WHERE s.request_id = $1 ORDER BY s.order_no`, [id])).rows;
  }

  /** Requester, signers and people who manage the document may see a request. */
  private async visible(db: pg.PoolClient, user: AuthenticatedUser, r: ReqRow, signers: SignerRow[]): Promise<{ manage: boolean }> {
    const isParty = r.requested_by === user.id || signers.some((s) => s.user_id === user.id);
    let manage = false;
    try { manage = (await loadDocument(db, user, r.document_id, LEVEL.MANAGE)).level >= LEVEL.MANAGE; } catch { manage = false; }
    if (!isParty && !manage) throw new NotFoundException('Signature request not found');
    return { manage };
  }

  private async toDto(db: pg.PoolClient, user: AuthenticatedUser, r: ReqRow, signers: SignerRow[], manage: boolean): Promise<SignatureRequest> {
    const doc = (await db.query<{ id: string; title: string | null; title_enc: Buffer | null; meta_key_wrapped: Buffer | null; meta_key_id: string | null; shredded_at: Date | null }>(
      `SELECT id, title, title_enc, meta_key_wrapped, meta_key_id, shredded_at FROM documents WHERE id = $1`, [r.document_id])).rows[0]!;
    const me = signers.find((s) => s.user_id === user.id);
    return {
      id: r.id, documentId: r.document_id, documentTitle: await this.vault.titleOf(user.orgId, doc), status: r.status, message: r.message,
      requestedBy: { id: r.requested_by, displayName: r.requester_name, email: r.requester_email }, createdAt: r.created_at.toISOString(), completedAt: r.completed_at?.toISOString() ?? null,
      sourceSha256: r.source_sha256, signedVersionId: r.signed_version_id, signedSha256: r.signed_sha256,
      signers: signers.map((s) => ({ id: s.user_id, displayName: s.display_name, email: s.email, status: s.status, signedAt: s.signed_at?.toISOString() ?? null, method: s.method, declineReason: s.decline_reason })),
      canSign: r.status === 'OPEN' && me?.status === 'PENDING',
      canCancel: r.status === 'OPEN' && (r.requested_by === user.id || manage),
    };
  }

  async get(user: AuthenticatedUser, id: string): Promise<SignatureRequest> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const r = await this.row(db, id);
      const s = await this.signers(db, id);
      const { manage } = await this.visible(db, user, r, s);
      return await this.toDto(db, user, r, s, manage);
    });
  }

  async list(user: AuthenticatedUser, scope: 'to-sign' | 'sent' | 'document', documentId?: string): Promise<{ items: SignatureRequest[] }> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      let ids: string[];
      if (scope === 'to-sign') ids = (await db.query<{ request_id: string }>(`SELECT s.request_id FROM signature_signers s JOIN signature_requests r ON r.id = s.request_id WHERE s.user_id = $1 ORDER BY r.created_at DESC LIMIT 100`, [user.id])).rows.map((x) => x.request_id);
      else if (scope === 'sent') ids = (await db.query<{ id: string }>(`SELECT id FROM signature_requests WHERE requested_by = $1 ORDER BY created_at DESC LIMIT 100`, [user.id])).rows.map((x) => x.id);
      else {
        if (!documentId) throw new BadRequestException('documentId is required');
        await loadDocument(db, user, documentId, LEVEL.VIEW);
        ids = (await db.query<{ id: string }>(`SELECT id FROM signature_requests WHERE document_id = $1 ORDER BY created_at DESC LIMIT 100`, [documentId])).rows.map((x) => x.id);
      }
      const items: SignatureRequest[] = [];
      for (const id of ids) {
        const r = await this.row(db, id);
        const s = await this.signers(db, id);
        try { const { manage } = await this.visible(db, user, r, s); items.push(await this.toDto(db, user, r, s, manage)); } catch { /* not visible */ }
      }
      return { items };
    });
  }

  // ------------------------------------------------------------------ request

  async create(user: AuthenticatedUser, documentId: string, dto: SignatureRequestDto, ctx: RequestContext): Promise<SignatureRequest> {
    const signerIds = [...new Set(dto.signerIds)];
    const result = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const doc = await loadDocument(db, user, documentId, LEVEL.MANAGE, { forUpdate: true });
      if (doc.password_protected) throw new ConflictException('Remove the document password before requesting signatures');
      const v = (await db.query<VersionRow>(`SELECT v.* FROM document_versions v JOIN documents d ON d.current_version_id = v.id WHERE d.id = $1`, [documentId])).rows[0];
      if (!v || v.scan_status !== 'CLEAN' || !v.sha256) throw new ConflictException('The document has no scanned version to sign yet');
      if (v.mime_type !== 'application/pdf') throw new BadRequestException('Only PDF documents can be signed');
      const open = await db.query(`SELECT 1 FROM signature_requests WHERE document_id = $1 AND status = 'OPEN'`, [documentId]);
      if (open.rowCount) throw new ConflictException('This document already has an open signature request');
      const found = await db.query<{ id: string }>(`SELECT id FROM users WHERE id = ANY($1::uuid[]) AND status = 'ACTIVE'`, [signerIds]);
      if (found.rows.length !== signerIds.length) throw new NotFoundException('A signer was not found');
      const id = (await db.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0]!.id;
      const dek = generateDek();
      let w: { wrapped: Buffer; keyId: string };
      try { w = await this.keys.wrap(dek, { orgId: user.orgId, documentId: id, purpose: 'signature' }); } finally { dek.fill(0); }
      await db.query(
        `INSERT INTO signature_requests (id, org_id, document_id, source_version_id, source_sha256, requested_by, message, key_wrapped, key_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, user.orgId, documentId, v.id, v.sha256, user.id, dto.message ?? '', w.wrapped, w.keyId]);
      for (const [i, s] of signerIds.entries()) {
        await db.query(`INSERT INTO signature_signers (request_id, org_id, user_id, order_no) VALUES ($1, $2, $3, $4)`, [id, user.orgId, s, i + 1]);
        // Signers need to read what they sign.
        await db.query(`INSERT INTO document_acl (org_id, document_id, principal_type, principal_id, permission, granted_by) VALUES ($1, $2, 'USER', $3, 'VIEW', $4) ON CONFLICT DO NOTHING`, [user.orgId, documentId, s, user.id]);
      }
      await logAccess(db, { orgId: user.orgId, documentId, versionId: v.id, userId: user.id, action: 'SHARE', ctx, detail: { via: 'SIGNATURE_REQUEST', signers: signerIds.length } });
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'SIGNATURE_REQUESTED', entityType: 'SIGNATURE_REQUEST', entityId: id,
        after: { documentId, versionId: v.id, sourceSha256: v.sha256, signers: signerIds }, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined });
      return { id };
    });
    await this.notifications.notify(user.orgId, signerIds.filter((s) => s !== user.id).map((s) => ({
      userId: s, type: NotificationType.SIGNATURE_REQUESTED, title: 'Your signature is requested', body: dto.message || 'Open the document to review and sign it.',
      link: `/signatures/${result.id}`, entityType: 'SIGNATURE_REQUEST', entityId: result.id, dedupeKey: `sign:${result.id}:${s}`,
    })));
    return await this.get(user, result.id);
  }

  // ------------------------------------------------------------------ sign / decline / cancel

  async sign(user: AuthenticatedUser, id: string, dto: SignDto, ctx: RequestContext): Promise<SignatureRequest> {
    if (dto.consentVersion !== ESIGN_CONSENT.version) throw new ConflictException('The consent text has changed. Reload and read it again.');
    const image = dto.method === 'DRAW' ? Buffer.from(dto.imagePng.slice(dto.imagePng.indexOf(',') + 1), 'base64') : null;
    if (image) checkPng(image);
    const complete = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const r = await this.row(db, id, true);
      const signers = await this.signers(db, id);
      const me = signers.find((s) => s.user_id === user.id);
      if (!me) throw new NotFoundException('Signature request not found');
      if (r.status !== 'OPEN' || me.status !== 'PENDING') throw new ConflictException('This request is no longer waiting for your signature');
      const current = (await db.query<{ current_version_id: string | null }>(`SELECT current_version_id FROM documents WHERE id = $1`, [r.document_id])).rows[0];
      if (current?.current_version_id !== r.source_version_id) throw new ConflictException('The document changed after signatures were requested. Ask for a new request.');
      // Identity: a fresh re-authentication of this login (password or TOTP), whatever the confidentiality.
      const reauthAt = await this.vaultService.recentReauth(db, user);
      if (!reauthAt) throw new ForbiddenException({ message: 'Confirm it is you before signing', code: 'REAUTH_REQUIRED' });
      let sealed: Buffer | null = null;
      if (image) {
        const dek = await this.keys.unwrap(r.key_wrapped, r.key_id, { orgId: user.orgId, documentId: id, purpose: 'signature' });
        try { sealed = sealSmall(dek, image.toString('base64')); } finally { dek.fill(0); }
      }
      await db.query(
        `UPDATE signature_signers SET status = 'SIGNED', method = $3, typed_name = $4, image_sealed = $5, signed_at = now(), reauth_at = $6, consent_version = $7, ip = $8, user_agent = $9
         WHERE request_id = $1 AND user_id = $2`,
        [id, user.id, dto.method, dto.method === 'TYPE' ? dto.typedName : null, sealed, reauthAt, dto.consentVersion, ctx.ip ?? 'unknown', ctx.userAgent?.slice(0, 300) ?? null]);
      await logAccess(db, { orgId: user.orgId, documentId: r.document_id, versionId: r.source_version_id, userId: user.id, action: 'SIGN', ctx, detail: { requestId: id, method: dto.method } });
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'DOCUMENT_SIGNED', entityType: 'SIGNATURE_REQUEST', entityId: id,
        after: { method: dto.method, sourceSha256: r.source_sha256, reauthAt: reauthAt.toISOString(), consentVersion: dto.consentVersion }, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined });
      return signers.every((s) => s.user_id === user.id || s.status === 'SIGNED');
    });
    if (complete) {
      // The signature is saved either way; a failed stamp leaves the request OPEN for finalize().
      try { await this.complete(user.orgId, id); } catch (err) { console.error('Signature completion failed:', err instanceof Error ? err.message : 'unknown error'); }
    }
    return await this.get(user, id);
  }

  /** Retry producing the signed copy when everyone has signed but the stamp failed. */
  async finalize(user: AuthenticatedUser, id: string): Promise<SignatureRequest> {
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const r = await this.row(db, id);
      const s = await this.signers(db, id);
      const { manage } = await this.visible(db, user, r, s);
      if (r.requested_by !== user.id && !manage) throw new ForbiddenException('Only the requester or a document manager can finalize');
      if (r.status !== 'OPEN' || !s.every((x) => x.status === 'SIGNED')) throw new ConflictException('Not everyone has signed yet');
    });
    await this.complete(user.orgId, id);
    return await this.get(user, id);
  }

  async decline(user: AuthenticatedUser, id: string, reason: string, ctx: RequestContext): Promise<SignatureRequest> {
    const requester = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const r = await this.row(db, id, true);
      const me = (await this.signers(db, id)).find((s) => s.user_id === user.id);
      if (!me) throw new NotFoundException('Signature request not found');
      if (r.status !== 'OPEN' || me.status !== 'PENDING') throw new ConflictException('This request is no longer waiting for your signature');
      await db.query(`UPDATE signature_signers SET status = 'DECLINED', decline_reason = $3 WHERE request_id = $1 AND user_id = $2`, [id, user.id, reason]);
      await db.query(`UPDATE signature_requests SET status = 'DECLINED' WHERE id = $1`, [id]);
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'SIGNATURE_DECLINED', entityType: 'SIGNATURE_REQUEST', entityId: id, after: { reason }, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined });
      return r.requested_by;
    });
    await this.notifications.notify(user.orgId, [{ userId: requester, type: NotificationType.SIGNATURE_DECLINED, title: `${user.displayName ?? user.email} declined to sign`, body: reason, link: `/signatures/${id}`, entityType: 'SIGNATURE_REQUEST', entityId: id, dedupeKey: `sign-declined:${id}` }]);
    return await this.get(user, id);
  }

  async cancel(user: AuthenticatedUser, id: string, ctx: RequestContext): Promise<SignatureRequest> {
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const r = await this.row(db, id, true);
      const s = await this.signers(db, id);
      const { manage } = await this.visible(db, user, r, s);
      if (r.requested_by !== user.id && !manage) throw new ForbiddenException('Only the requester or a document manager can cancel');
      if (r.status !== 'OPEN') throw new ConflictException('Only open requests can be cancelled');
      await db.query(`UPDATE signature_requests SET status = 'CANCELLED' WHERE id = $1`, [id]);
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'SIGNATURE_CANCELLED', entityType: 'SIGNATURE_REQUEST', entityId: id, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined });
    });
    return await this.get(user, id);
  }

  // ------------------------------------------------------------------ completion

  /** All signed: stamp signatures and the audit certificate into a new version (scanned and encrypted as usual). */
  private async complete(orgId: string, id: string): Promise<void> {
    const out = await this.prisma.runWithTenantContext(orgId, async (db) => {
      const r = await this.row(db, id, true);
      if (r.status !== 'OPEN') return null;
      const signers = await this.signers(db, id);
      if (!signers.every((s) => s.status === 'SIGNED')) return null;
      const v = (await db.query<VersionRow>(`SELECT * FROM document_versions WHERE id = $1`, [r.source_version_id])).rows[0]!;
      const dek = await this.vault.versionDek(orgId, r.document_id, v);
      let source: Buffer;
      try {
        const file = await this.content.original(v, dek);
        const chunks: Buffer[] = [];
        for await (const c of file.stream) chunks.push(Buffer.from(c as Buffer));
        source = Buffer.concat(chunks);
      } finally { dek.fill(0); }
      // Tamper evidence: what is signed is exactly what was requested.
      if (sha256(source) !== r.source_sha256) throw new ConflictException('The stored document does not match its fingerprint; signing stopped');
      const tz = (await db.query<{ timezone: string }>(`SELECT timezone FROM organizations WHERE id = $1`, [orgId])).rows[0]?.timezone ?? 'UTC';
      const docRow = (await db.query<{ id: string; title: string | null; title_enc: Buffer | null; meta_key_wrapped: Buffer | null; meta_key_id: string | null; shredded_at: Date | null }>(
        `SELECT id, title, title_enc, meta_key_wrapped, meta_key_id, shredded_at FROM documents WHERE id = $1`, [r.document_id])).rows[0]!;
      const title = await this.vault.titleOf(orgId, docRow);
      const reqDek = await this.keys.unwrap(r.key_wrapped, r.key_id, { orgId, documentId: id, purpose: 'signature' });
      let signed: Buffer;
      try { signed = await this.stamp(source, r, signers, title, tz, reqDek); } finally { reqDek.fill(0); }
      const signedSha = sha256(signed);
      // A new version, staged in plaintext and handed to the scanner, which encrypts it and makes it current.
      const versionNo = (await db.query<{ n: number }>(`SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM document_versions WHERE document_id = $1`, [r.document_id])).rows[0]!.n;
      const newDek = generateDek();
      let versionId: string;
      try {
        const wrapped = await this.vault.wrapPlain(orgId, r.document_id, newDek);
        const fileName = `${title.replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 80) || 'document'} (signed).pdf`;
        versionId = (await db.query<{ id: string }>(
          `INSERT INTO document_versions (org_id, document_id, version_no, file_name_enc, declared_size, size_bytes, dek_wrapped_kms, kms_key_id, uploaded_by, scan_status, completed_at)
           VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, 'PENDING', now()) RETURNING id`,
          [orgId, r.document_id, versionNo, sealSmall(newDek, fileName), signed.length, wrapped.wrapped, wrapped.keyId, r.requested_by])).rows[0]!.id;
      } finally { newDek.fill(0); }
      const staging = storeKeys.staging(orgId, r.document_id, versionId);
      await this.store.put(staging, Readable.from(signed), signed.length);
      await db.query(`UPDATE document_versions SET staging_key = $2 WHERE id = $1`, [versionId, staging]);
      await db.query(`UPDATE signature_requests SET status = 'COMPLETED', signed_version_id = $2, signed_sha256 = $3, completed_at = now() WHERE id = $1`, [id, versionId, signedSha]);
      await appendAuditEntry(db, { orgId, actorId: r.requested_by, action: 'SIGNATURE_COMPLETED', entityType: 'SIGNATURE_REQUEST', entityId: id,
        after: { sourceSha256: r.source_sha256, signedVersionId: versionId, signedSha256: signedSha, signers: signers.length, system: true } });
      return { versionId, notify: [r.requested_by, ...signers.map((s) => s.user_id)] };
    });
    if (!out) return;
    await this.scans.dispatchScan(orgId, out.versionId);
    await this.notifications.notify(orgId, [...new Set(out.notify)].map((u) => ({
      userId: u, type: NotificationType.SIGNATURE_COMPLETED, title: 'A document was signed by everyone', body: 'The signed copy with its audit certificate is now the current version.',
      link: `/signatures/${id}`, entityType: 'SIGNATURE_REQUEST', entityId: id, dedupeKey: `sign-done:${id}:${u}`,
    })));
  }

  /** The signature page and the audit certificate, appended to the original PDF. */
  private async stamp(source: Buffer, r: ReqRow, signers: SignerRow[], title: string, tz: string, reqDek: Buffer): Promise<Buffer> {
    let pdf: PDFDocument;
    try { pdf = await PDFDocument.load(source, { updateMetadata: false }); } catch { throw new BadRequestException('This PDF cannot be signed (it is encrypted or damaged)'); }
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const script = await pdf.embedFont(StandardFonts.HelveticaOblique);
    const when = (d: Date) => `${d.toISOString().replace('T', ' ').slice(0, 19)} UTC (${formatInTimeZone(d, tz, 'yyyy-MM-dd HH:mm')} ${tz})`;
    let page = pdf.addPage([595, 842]);
    let y = 790;
    const line = (text: string, f: PDFFont = font, size = 10, color = rgb(0, 0, 0)) => {
      if (y < 60) { page = pdf.addPage([595, 842]); y = 790; }
      page.drawText(safe(f, text), { x: 50, y, size, font: f, color, maxWidth: 495 });
      y -= size + 6;
    };
    line('Electronic signatures', bold, 18);
    line(title, font, 11, rgb(0.3, 0.3, 0.3));
    y -= 10;
    for (const s of signers) {
      if (y < 200) { page = pdf.addPage([595, 842]); y = 790; }
      if (s.method === 'DRAW' && s.image_sealed) {
        const png = Buffer.from(openSmall(reqDek, s.image_sealed), 'base64');
        const img = await pdf.embedPng(png);
        const scale = Math.min(220 / img.width, 70 / img.height, 1);
        page.drawImage(img, { x: 50, y: y - img.height * scale, width: img.width * scale, height: img.height * scale });
        y -= img.height * scale + 8;
      } else {
        page.drawText(safe(script, s.typed_name ?? ''), { x: 50, y: y - 22, size: 22, font: script });
        y -= 34;
      }
      page.drawLine({ start: { x: 50, y: y + 2 }, end: { x: 300, y: y + 2 }, thickness: 0.5, color: rgb(0.5, 0.5, 0.5) });
      y -= 12;
      line(`${s.display_name ?? s.email} <${s.email}>`, bold, 10);
      line(`Signed ${when(s.signed_at!)} from IP ${s.ip}`, font, 9);
      line(`${s.method === 'DRAW' ? 'Drawn' : 'Typed'} signature; identity confirmed by re-authentication at ${when(s.reauth_at!)}; consent ${s.consent_version}`, font, 9);
      y -= 12;
    }
    page = pdf.addPage([595, 842]);
    y = 790;
    line('Audit certificate', bold, 18);
    line(`Request ${r.id}`, font, 9);
    line(`Document "${title}" (id ${r.document_id}, version ${r.source_version_id})`, font, 9);
    line('Fingerprint of the original that was signed (SHA-256):', bold, 9);
    line(r.source_sha256, font, 9);
    line(`Requested by ${r.requester_name ?? r.requester_email} <${r.requester_email}> at ${when(r.created_at)}`, font, 9);
    y -= 8;
    line('Events (server clock)', bold, 11);
    line(`${when(r.created_at)}  signature requested`, font, 9);
    for (const s of [...signers].sort((a, b) => a.signed_at!.getTime() - b.signed_at!.getTime())) {
      line(`${when(s.signed_at!)}  signed by ${s.display_name ?? s.email} (${s.method === 'DRAW' ? 'drawn' : 'typed'}), IP ${s.ip}`, font, 9);
    }
    y -= 8;
    line(`Consent text (${ESIGN_CONSENT.version}): ${ESIGN_CONSENT.text}`, font, 8, rgb(0.3, 0.3, 0.3));
    line(`Produced by HR Virtual Office. The fingerprint of this signed file is recorded in the audit log; verify it at ${webUrl()}/signatures/${r.id}.`, font, 8, rgb(0.3, 0.3, 0.3));
    line('This is a simple electronic signature, not a qualified or advanced electronic signature.', font, 8, rgb(0.3, 0.3, 0.3));
    // Machine-readable too: the request and the original's fingerprint in the document metadata.
    pdf.setKeywords([`hrvo-esign-request:${r.id}`, `hrvo-esign-source-sha256:${r.source_sha256}`]);
    pdf.setModificationDate(new Date());
    return Buffer.from(await pdf.save({ useObjectStreams: false }));
  }

  // ------------------------------------------------------------------ verification

  async verify(user: AuthenticatedUser, id: string): Promise<SignatureVerification> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const r = await this.row(db, id);
      const s = await this.signers(db, id);
      await this.visible(db, user, r, s);
      const src = (await db.query<{ sha256: string | null }>(`SELECT sha256 FROM document_versions WHERE id = $1`, [r.source_version_id])).rows[0];
      const signed = r.signed_version_id ? (await db.query<{ sha256: string | null; scan_status: string }>(`SELECT sha256, scan_status FROM document_versions WHERE id = $1`, [r.signed_version_id])).rows[0] : null;
      const events = [{ at: r.created_at.toISOString(), what: `Requested by ${r.requester_name ?? r.requester_email}` }];
      for (const x of s) {
        if (x.signed_at) events.push({ at: x.signed_at.toISOString(), what: `Signed by ${x.display_name ?? x.email}` });
        if (x.status === 'DECLINED') events.push({ at: r.created_at.toISOString(), what: `Declined by ${x.display_name ?? x.email}` });
      }
      if (r.completed_at) events.push({ at: r.completed_at.toISOString(), what: 'Signed copy produced' });
      events.sort((a, b) => a.at.localeCompare(b.at));
      return {
        requestId: id, status: r.status, sourceIntact: src?.sha256 === r.source_sha256,
        signedIntact: signed && signed.scan_status === 'CLEAN' ? signed.sha256 === r.signed_sha256 : null, signedSha256: r.signed_sha256, events,
      };
    });
  }
}
