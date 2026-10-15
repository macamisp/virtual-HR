import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type pg from 'pg';
import argon2 from 'argon2';
import { PrismaService } from '../common/prisma.service.ts';
import type { RequestContext } from '../common/decorators/request-context.decorator.ts';
import { NotificationsService } from '../notifications/notifications.service.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import type { CreatedShareLink, PublicShareInfo, PublicShareOpenDto, ShareLink, ShareLinkDto } from '../../../../packages/shared/src/documents/types.ts';
import { toIso, userRef } from '../tasks/tasks.sql.ts';
import { LEVEL } from './document-policy.ts';
import { DocumentVault } from './document-vault.ts';
import { DocumentContent, watermarkText } from './document-content.service.ts';
import type { FileStream } from './document-content.service.ts';
import { isWatermarkableMime, loadDocument } from './documents.sql.ts';
import type { VersionRow } from './documents.sql.ts';
import { logAccess } from './access-log.ts';
import { generateShareToken, hashShareToken } from './share-token.ts';

type Db = pg.PoolClient;

const MAX_LINK_DAYS = 90;
const MAX_LINK_PASSWORD_FAILURES = 5;
/** One answer for every unusable link: no hint whether it never existed, expired or was revoked. */
const GONE = 'This link is not valid or has expired';

interface LinkRow {
  id: string;
  org_id: string;
  document_id: string;
  password_hash: string | null;
  view_only: boolean;
  expires_at: Date;
  max_downloads: number | null;
  download_count: number;
  failed_attempts: number;
  revoked_at: Date | null;
  created_by: string;
  created_at: Date;
  last_used_at: Date | null;
  c_name: string | null;
  c_email: string;
  c_role: string;
}

function active(l: Pick<LinkRow, 'revoked_at' | 'expires_at' | 'max_downloads' | 'download_count'>): boolean {
  return !l.revoked_at && l.expires_at.getTime() > Date.now() && (l.max_downloads === null || l.download_count < l.max_downloads);
}

/**
 * FR-DOC-010 secure share links for external parties: the token is stored only as SHA-256;
 * optional password (Argon2id hash), mandatory expiry (at most 90 days), optional download
 * limit, revocation. A link opens exactly one document; RESTRICTED and password-protected
 * documents cannot be shared this way, CONFIDENTIAL ones only with a link password.
 */
@Injectable()
export class ShareLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: DocumentVault,
    private readonly content: DocumentContent,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------------------------------------------------------------- managing links (MANAGE)

  async create(user: AuthenticatedUser, documentId: string, dto: ShareLinkDto, ctx: RequestContext): Promise<CreatedShareLink> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const doc = await loadDocument(db, user, documentId, LEVEL.MANAGE);
      if (doc.confidentiality === 'RESTRICTED') throw new ForbiddenException('Restricted documents cannot be shared by link');
      if (doc.password_protected) throw new ConflictException('Password-protected documents cannot be shared by link');
      if (doc.confidentiality === 'CONFIDENTIAL' && !dto.password) throw new BadRequestException('A confidential document can only be shared with a link password');
      if (doc.current_status !== 'CLEAN') throw new ConflictException('Only documents that passed the virus scan can be shared');
      if (dto.viewOnly && !isWatermarkableMime(doc.mime_type)) throw new BadRequestException('View-only links are available for PDFs, PNG and JPEG images');
      const expires = new Date(dto.expiresAt);
      if (expires.getTime() <= Date.now() + 60_000) throw new BadRequestException('The link must expire in the future');
      if (expires.getTime() > Date.now() + MAX_LINK_DAYS * 86_400_000) throw new BadRequestException(`Links last at most ${MAX_LINK_DAYS} days`);
      const token = generateShareToken();
      const passwordHash = dto.password ? await argon2.hash(dto.password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 }) : null;
      const res = await db.query<{ id: string }>(
        `INSERT INTO document_share_links (org_id, document_id, token_hash, password_hash, view_only, expires_at, max_downloads, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [user.orgId, documentId, hashShareToken(token), passwordHash, dto.viewOnly, expires, dto.maxDownloads ?? null, user.id],
      );
      await logAccess(db, {
        orgId: user.orgId, documentId, userId: user.id, action: 'SHARE', ctx,
        detail: { change: 'CREATE', linkId: res.rows[0]!.id, expiresAt: expires.toISOString(), viewOnly: dto.viewOnly, maxDownloads: dto.maxDownloads ?? null, password: !!dto.password },
      });
      const link = (await this.links(db, documentId)).find((l) => l.id === res.rows[0]!.id)!;
      const base = (process.env.APP_WEB_URL || 'http://localhost:3000').replace(/\/$/, '');
      return { link, token, url: `${base}/s/${token}` };
    });
  }

  async list(user: AuthenticatedUser, documentId: string): Promise<{ items: ShareLink[] }> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await loadDocument(db, user, documentId, LEVEL.MANAGE);
      return { items: await this.links(db, documentId) };
    });
  }

  async revoke(user: AuthenticatedUser, documentId: string, linkId: string, ctx: RequestContext): Promise<{ items: ShareLink[] }> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await loadDocument(db, user, documentId, LEVEL.MANAGE);
      const res = await db.query(`UPDATE document_share_links SET revoked_at = now(), revoked_by = $3 WHERE id = $1 AND document_id = $2 AND revoked_at IS NULL`, [linkId, documentId, user.id]);
      if ((res.rowCount ?? 0) === 0) throw new NotFoundException('Link not found or already revoked');
      await logAccess(db, { orgId: user.orgId, documentId, userId: user.id, action: 'SHARE', ctx, detail: { change: 'REVOKE', linkId } });
      return { items: await this.links(db, documentId) };
    });
  }

  private async links(db: Db, documentId: string): Promise<ShareLink[]> {
    const res = await db.query<LinkRow>(
      `SELECT l.*, u.display_name AS c_name, u.email AS c_email, u.role AS c_role FROM document_share_links l JOIN users u ON u.id = l.created_by
       WHERE l.document_id = $1 ORDER BY l.created_at DESC`,
      [documentId],
    );
    return res.rows.map((l) => ({
      id: l.id, viewOnly: l.view_only, passwordProtected: !!l.password_hash, expiresAt: toIso(l.expires_at)!, maxDownloads: l.max_downloads,
      downloadCount: l.download_count, revokedAt: toIso(l.revoked_at), active: active(l), createdBy: userRef(l.created_by, l.c_name, l.c_email, l.c_role),
      createdAt: toIso(l.created_at)!, lastUsedAt: toIso(l.last_used_at),
    }));
  }

  // ---------------------------------------------------------------- public access (no login)

  /** Finds a usable link and its document's current clean version, or 404 with no detail. */
  private async resolve(token: string): Promise<{ orgId: string; linkId: string }> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new NotFoundException(GONE);
    const res = await this.prisma.getPool().query<{ id: string; org_id: string }>(`SELECT * FROM fn_share_link_lookup($1)`, [hashShareToken(token)]);
    const hit = res.rows[0];
    if (!hit) throw new NotFoundException(GONE);
    return { orgId: hit.org_id, linkId: hit.id };
  }

  private async loadUsable(db: Db, linkId: string): Promise<{ link: LinkRow; v: VersionRow; doc: { id: string; title: string | null; title_enc: Buffer | null; meta_key_wrapped: Buffer | null; meta_key_id: string | null; shredded_at: Date | null } }> {
    const l = await db.query<LinkRow>(`SELECT l.*, '' AS c_email, '' AS c_role, NULL AS c_name FROM document_share_links l WHERE l.id = $1 FOR UPDATE`, [linkId]);
    const link = l.rows[0];
    if (!link || !active(link)) throw new NotFoundException(GONE);
    const d = await db.query<{ id: string; title: string | null; title_enc: Buffer | null; meta_key_wrapped: Buffer | null; meta_key_id: string | null; shredded_at: Date | null; password_protected: boolean; confidentiality: string; current_version_id: string | null }>(
      `SELECT id, title, title_enc, meta_key_wrapped, meta_key_id, shredded_at, password_protected, confidentiality, current_version_id
       FROM documents WHERE id = $1 AND deleted_at IS NULL AND shredded_at IS NULL`,
      [link.document_id],
    );
    const doc = d.rows[0];
    // Rules re-checked at use: the document may have become restricted or protected since.
    if (!doc || !doc.current_version_id || doc.password_protected || doc.confidentiality === 'RESTRICTED') throw new NotFoundException(GONE);
    const v = await db.query<VersionRow>(`SELECT * FROM document_versions WHERE id = $1 AND scan_status = 'CLEAN'`, [doc.current_version_id]);
    if (!v.rows[0] || !v.rows[0].dek_wrapped_kms) throw new NotFoundException(GONE);
    return { link, v: v.rows[0], doc };
  }

  async info(token: string): Promise<PublicShareInfo> {
    const { orgId, linkId } = await this.resolve(token);
    return await this.prisma.runWithTenantContext(orgId, async (db) => {
      const { link, v, doc } = await this.loadUsable(db, linkId);
      const dek = await this.vault.versionDek(orgId, doc.id, v);
      const fileName = this.content.fileName(v, dek);
      dek.fill(0);
      return {
        title: await this.vault.titleOf(orgId, doc),
        fileName: link.view_only ? `${fileName.replace(/\.[^.]+$/, '')} (view only).pdf` : fileName,
        mimeType: link.view_only ? 'application/pdf' : v.mime_type!,
        sizeBytes: Number(v.size_bytes),
        viewOnly: link.view_only,
        passwordRequired: !!link.password_hash,
        expiresAt: toIso(link.expires_at)!,
        remaining: link.max_downloads === null ? null : link.max_downloads - link.download_count,
      };
    });
  }

  async open(token: string, dto: PublicShareOpenDto, ctx: RequestContext): Promise<FileStream> {
    const { orgId, linkId } = await this.resolve(token);
    let failed: { createdBy: string; locked: boolean; documentId: string } | null = null;
    const opened = await this.prisma.runWithTenantContext(orgId, async (db) => {
      const { link, v, doc } = await this.loadUsable(db, linkId);
      if (link.password_hash && !dto.password) throw new UnauthorizedException({ statusCode: 401, code: 'LINK_PASSWORD', message: 'This link needs a password' });
      if (link.password_hash) {
        const ok = await argon2.verify(link.password_hash, dto.password!).catch(() => false);
        if (!ok) {
          const attempts = link.failed_attempts + 1;
          const locked = attempts >= MAX_LINK_PASSWORD_FAILURES;
          await db.query(`UPDATE document_share_links SET failed_attempts = $2, revoked_at = CASE WHEN $3 THEN now() ELSE revoked_at END WHERE id = $1`, [link.id, attempts, locked]);
          await logAccess(db, { orgId, documentId: link.document_id, userId: null, action: 'PASSWORD_FAIL', ctx, detail: { shareLinkId: link.id, locked } });
          failed = { createdBy: link.created_by, locked, documentId: link.document_id };
          return null;
        }
      }
      if (link.view_only && dto.mode === 'download') throw new ForbiddenException('This link is view-only');
      // Every opening counts against the limit, atomically (two clicks cannot both get the last one).
      const counted = await db.query(
        `UPDATE document_share_links SET download_count = download_count + 1, failed_attempts = 0, last_used_at = now()
         WHERE id = $1 AND (max_downloads IS NULL OR download_count < max_downloads) RETURNING id`,
        [link.id],
      );
      if ((counted.rowCount ?? 0) === 0) throw new NotFoundException(GONE);
      const mode = link.view_only ? 'view' : dto.mode;
      await logAccess(db, { orgId, documentId: doc.id, versionId: v.id, userId: null, action: mode === 'download' ? 'DOWNLOAD' : 'VIEW', ctx, detail: { shareLinkId: link.id, mode } });
      return { v, dek: await this.vault.versionDek(orgId, doc.id, v), mode };
    });
    if (!opened) {
      const f = failed as { createdBy: string; locked: boolean; documentId: string } | null;
      if (f?.locked) {
        await this.notifications.notify(orgId, [{
          userId: f.createdBy, type: 'SHARE_LINK_LOCKED', title: 'A share link was revoked after wrong passwords',
          body: `Someone entered a wrong link password ${MAX_LINK_PASSWORD_FAILURES} times${ctx.ip ? ` from ${ctx.ip}` : ''}. The link no longer works; create a new one if needed.`,
          link: `/documents/${f.documentId}`, entityType: 'DOCUMENT', entityId: f.documentId, email: true,
        }]);
      }
      throw new UnauthorizedException({ statusCode: 401, code: 'LINK_PASSWORD', message: dto.password ? 'Wrong password' : 'This link needs a password' });
    }
    if (opened.mode === 'view') return await this.content.viewOnly(opened.v, opened.dek, watermarkText('Shared link', ctx.ip));
    return await this.content.original(opened.v, opened.dek);
  }
}
