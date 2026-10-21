import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
  UseGuards, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { ThrottlerGuard } from '@nestjs/throttler';
import { DeniedAccessLogInterceptor } from './denied-access-log.interceptor.ts';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ReqContext } from '../common/decorators/request-context.decorator.ts';
import type { RequestContext } from '../common/decorators/request-context.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { Permission } from '../../../../packages/shared/src/auth/types.ts';
import {
  AccessLogQuerySchema,
  AclGrantDtoSchema,
  LegalHoldDtoSchema,
  OpenContentDtoSchema,
  RecoverDocumentPasswordDtoSchema,
  RemoveDocumentPasswordDtoSchema,
  RetentionRulesDtoSchema,
  SetDocumentPasswordDtoSchema,
  ShareLinkDtoSchema,
  CompleteUploadDtoSchema,
  DocumentListQuerySchema,
  FolderDtoSchema,
  PartUrlsDtoSchema,
  StartUploadDtoSchema,
  UpdateDocumentDtoSchema,
} from '../../../../packages/shared/src/documents/types.ts';
import type {
  AccessLogQuery,
  AclGrantDto,
  LegalHoldDto,
  OpenContentDto,
  RecoverDocumentPasswordDto,
  RemoveDocumentPasswordDto,
  RetentionRulesDto,
  SetDocumentPasswordDto,
  ShareLinkDto,
  CompleteUploadDto,
  DocumentListQuery,
  FolderDto,
  PartUrlsDto,
  StartUploadDto,
  UpdateDocumentDto,
} from '../../../../packages/shared/src/documents/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import { DocumentsService } from './documents.service.ts';
import type { FileStream } from './document-content.service.ts';
import { FoldersService } from './folders.service.ts';
import { VaultService } from './vault.service.ts';
import { ShareLinksService } from './share-links.service.ts';
import { RateLimit } from '../common/rate-limit.ts';

const id = new ParseUUIDPipe({ version: '4' });
const optionalVersion = new ZodValidationPipe(z.string().uuid().optional());

/** RFC 6266 / 5987: an ASCII fallback plus the exact UTF-8 name. */
function disposition(kind: 'attachment' | 'inline', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function send(file: FileStream, kind: 'attachment' | 'inline', res: Response): StreamableFile {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Opened directly, the file is sandboxed: no scripts, no same-origin access.
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
  if (file.sha256) res.setHeader('X-Document-SHA256', file.sha256);
  // FR-DOC-011: the watermarked rendering is never offered as a download.
  if (file.viewOnly) res.setHeader('X-View-Only', '1');
  return new StreamableFile(file.stream, { type: file.mimeType, disposition: disposition(file.viewOnly ? 'inline' : kind, file.fileName), length: file.sizeBytes ?? undefined });
}

/** FR-DOC-001..004, 009, 012, 013, 019. Every route needs documents.use; rows are checked per document. */
@Controller('documents')
@UseGuards(ThrottlerGuard, JwtAuthGuard, PermissionsGuard)
@UseInterceptors(DeniedAccessLogInterceptor)
@RequirePermissions(Permission.DOCUMENTS_USE)
export class DocumentsController {
  constructor(
    private readonly docs: DocumentsService,
    private readonly folders: FoldersService,
    private readonly vault: VaultService,
    private readonly shares: ShareLinksService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query(new ZodValidationPipe(DocumentListQuerySchema)) q: DocumentListQuery) {
    return this.docs.list(user, q);
  }

  // ---- uploads

  @Post('uploads')
  @RateLimit('vault')
  start(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(StartUploadDtoSchema)) dto: StartUploadDto, @ReqContext() ctx: RequestContext) {
    return this.docs.startUpload(user, dto, ctx);
  }

  @Get('uploads/:versionId')
  uploadState(@CurrentUser() user: AuthenticatedUser, @Param('versionId', id) versionId: string) {
    return this.docs.uploadState(user, versionId);
  }

  @Post('uploads/:versionId/parts')
  @HttpCode(HttpStatus.OK)
  parts(@CurrentUser() user: AuthenticatedUser, @Param('versionId', id) versionId: string, @Body(new ZodValidationPipe(PartUrlsDtoSchema)) dto: PartUrlsDto) {
    return this.docs.partUrls(user, versionId, dto.partNumbers);
  }

  @Post('uploads/:versionId/complete')
  @HttpCode(HttpStatus.OK)
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('versionId', id) versionId: string,
    @Body(new ZodValidationPipe(CompleteUploadDtoSchema)) dto: CompleteUploadDto,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.docs.completeUpload(user, versionId, dto, ctx);
  }

  @Delete('uploads/:versionId')
  abort(@CurrentUser() user: AuthenticatedUser, @Param('versionId', id) versionId: string) {
    return this.docs.abortUpload(user, versionId);
  }

  @Get('share-targets')
  shareTargets(@CurrentUser() user: AuthenticatedUser) {
    return this.folders.shareTargets(user);
  }

  // ---- folders

  @Get('folders')
  listFolders(@CurrentUser() user: AuthenticatedUser) {
    return this.folders.list(user);
  }

  @Post('folders')
  createFolder(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(FolderDtoSchema)) dto: FolderDto) {
    return this.folders.create(user, dto);
  }

  @Delete('folders/:folderId')
  removeFolder(@CurrentUser() user: AuthenticatedUser, @Param('folderId', id) folderId: string) {
    return this.folders.remove(user, folderId);
  }

  @Get('folders/:folderId/acl')
  folderAcl(@CurrentUser() user: AuthenticatedUser, @Param('folderId', id) folderId: string) {
    return this.docs.acl(user, { folderId });
  }

  @Post('folders/:folderId/acl')
  grantFolder(
    @CurrentUser() user: AuthenticatedUser,
    @Param('folderId', id) folderId: string,
    @Body(new ZodValidationPipe(AclGrantDtoSchema)) dto: AclGrantDto,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.docs.grant(user, { folderId }, dto, ctx);
  }

  @Delete('folders/:folderId/acl/:aclId')
  revokeFolder(@CurrentUser() user: AuthenticatedUser, @Param('folderId', id) folderId: string, @Param('aclId', id) aclId: string, @ReqContext() ctx: RequestContext) {
    return this.docs.revoke(user, { folderId }, aclId, ctx);
  }

  // ---- organisation-wide access log (FR-DOC-012): audit readers, exportable

  @Get('access-logs')
  @RequirePermissions(Permission.DOCUMENTS_USE, Permission.AUDIT_READ)
  async accessLogs(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(AccessLogQuerySchema)) q: AccessLogQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    const out = await this.folders.accessLog(user, q, true);
    if (q.format !== 'csv') return out;
    res.setHeader('Cache-Control', 'no-store');
    const body = Buffer.from(this.folders.accessLogCsv(out.items), 'utf8');
    return new StreamableFile(body, { type: 'text/csv; charset=utf-8', disposition: 'attachment; filename="document-access-log.csv"', length: body.length });
  }

  // ---- trash and retention (FR-DOC-017)

  @Get('trash')
  trash(@CurrentUser() user: AuthenticatedUser) {
    return this.vault.trash(user);
  }

  @Get('retention')
  retention(@CurrentUser() user: AuthenticatedUser) {
    return this.vault.retentionRules(user);
  }

  @Put('retention')
  @RequirePermissions(Permission.DOCUMENTS_USE, Permission.DOCUMENTS_RETENTION)
  setRetention(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(RetentionRulesDtoSchema)) dto: RetentionRulesDto) {
    return this.vault.setRetentionRules(user, dto);
  }

  // ---- one document

  @Get(':id')
  detail(@CurrentUser() user: AuthenticatedUser, @Param('id', id) docId: string, @ReqContext() ctx: RequestContext) {
    return this.docs.detail(user, docId, ctx);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthenticatedUser, @Param('id', id) docId: string, @Body(new ZodValidationPipe(UpdateDocumentDtoSchema)) dto: UpdateDocumentDto, @ReqContext() ctx: RequestContext) {
    return this.docs.update(user, docId, dto, ctx);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id', id) docId: string, @ReqContext() ctx: RequestContext) {
    return this.docs.remove(user, docId, ctx);
  }

  @Get(':id/download')
  async download(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id) docId: string,
    @Query('versionId', optionalVersion) versionId: string | undefined,
    @ReqContext() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    return send(await this.docs.open(user, docId, { mode: 'download', versionId }, ctx), 'attachment', res);
  }

  /** FR-DOC-019: PDFs and images only, inline. */
  @Get(':id/preview')
  async preview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id) docId: string,
    @Query('versionId', optionalVersion) versionId: string | undefined,
    @ReqContext() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    return send(await this.docs.open(user, docId, { mode: 'preview', versionId }, ctx), 'inline', res);
  }

  /** FR-DOC-011: watermarked view-only rendering (viewer, time, IP); VIEW is enough. */
  @Get(':id/view')
  async view(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id) docId: string,
    @Query('versionId', optionalVersion) versionId: string | undefined,
    @ReqContext() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    return send(await this.docs.open(user, docId, { mode: 'view', versionId }, ctx), 'inline', res);
  }

  /** FR-DOC-006: content of a password-protected document (the password goes in the body, never the URL). */
  @Post(':id/content')
  @HttpCode(HttpStatus.OK)
  @RateLimit('vault')
  async content(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id) docId: string,
    @Body(new ZodValidationPipe(OpenContentDtoSchema)) dto: OpenContentDto,
    @ReqContext() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    return send(await this.docs.open(user, docId, dto, ctx), dto.mode === 'download' ? 'attachment' : 'inline', res);
  }

  // ---- document password (FR-DOC-006)

  @Put(':id/password')
  @RateLimit('vault')
  setPassword(@CurrentUser() user: AuthenticatedUser, @Param('id', id) docId: string, @Body(new ZodValidationPipe(SetDocumentPasswordDtoSchema)) dto: SetDocumentPasswordDto, @ReqContext() ctx: RequestContext) {
    return this.vault.setPassword(user, docId, dto, ctx);
  }

  @Post(':id/password/remove')
  @HttpCode(HttpStatus.OK)
  @RateLimit('vault')
  removePassword(@CurrentUser() user: AuthenticatedUser, @Param('id', id) docId: string, @Body(new ZodValidationPipe(RemoveDocumentPasswordDtoSchema)) dto: RemoveDocumentPasswordDto, @ReqContext() ctx: RequestContext) {
    return this.vault.removePassword(user, docId, dto, ctx);
  }

  @Post(':id/password/recover')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.DOCUMENTS_USE, Permission.VAULT_RECOVER)
  recoverPassword(@CurrentUser() user: AuthenticatedUser, @Param('id', id) docId: string, @Body(new ZodValidationPipe(RecoverDocumentPasswordDtoSchema)) dto: RecoverDocumentPasswordDto, @ReqContext() ctx: RequestContext) {
    return this.vault.recoverPassword(user, docId, dto, ctx);
  }

  // ---- legal hold and trash (FR-DOC-017)

  @Put(':id/legal-hold')
  @RequirePermissions(Permission.DOCUMENTS_USE, Permission.DOCUMENTS_LEGAL_HOLD)
  legalHold(@CurrentUser() user: AuthenticatedUser, @Param('id', id) docId: string, @Body(new ZodValidationPipe(LegalHoldDtoSchema)) dto: LegalHoldDto, @ReqContext() ctx: RequestContext) {
    return this.vault.setLegalHold(user, docId, dto, ctx);
  }

  @Post(':id/untrash')
  @HttpCode(HttpStatus.OK)
  untrash(@CurrentUser() user: AuthenticatedUser, @Param('id', id) docId: string, @ReqContext() ctx: RequestContext) {
    return this.vault.restoreFromTrash(user, docId, ctx);
  }

  // ---- share links (FR-DOC-010)

  @Get(':id/share-links')
  shareLinks(@CurrentUser() user: AuthenticatedUser, @Param('id', id) docId: string) {
    return this.shares.list(user, docId);
  }

  @Post(':id/share-links')
  createShareLink(@CurrentUser() user: AuthenticatedUser, @Param('id', id) docId: string, @Body(new ZodValidationPipe(ShareLinkDtoSchema)) dto: ShareLinkDto, @ReqContext() ctx: RequestContext) {
    return this.shares.create(user, docId, dto, ctx);
  }

  @Delete(':id/share-links/:linkId')
  revokeShareLink(@CurrentUser() user: AuthenticatedUser, @Param('id', id) docId: string, @Param('linkId', id) linkId: string, @ReqContext() ctx: RequestContext) {
    return this.shares.revoke(user, docId, linkId, ctx);
  }

  @Post(':id/versions/:versionId/restore')
  @HttpCode(HttpStatus.OK)
  restore(@CurrentUser() user: AuthenticatedUser, @Param('id', id) docId: string, @Param('versionId', id) versionId: string, @ReqContext() ctx: RequestContext) {
    return this.docs.restore(user, docId, versionId, ctx);
  }

  @Get(':id/acl')
  acl(@CurrentUser() user: AuthenticatedUser, @Param('id', id) docId: string) {
    return this.docs.acl(user, { documentId: docId });
  }

  @Post(':id/acl')
  grant(@CurrentUser() user: AuthenticatedUser, @Param('id', id) docId: string, @Body(new ZodValidationPipe(AclGrantDtoSchema)) dto: AclGrantDto, @ReqContext() ctx: RequestContext) {
    return this.docs.grant(user, { documentId: docId }, dto, ctx);
  }

  @Delete(':id/acl/:aclId')
  revoke(@CurrentUser() user: AuthenticatedUser, @Param('id', id) docId: string, @Param('aclId', id) aclId: string, @ReqContext() ctx: RequestContext) {
    return this.docs.revoke(user, { documentId: docId }, aclId, ctx);
  }

  @Get(':id/access-log')
  @Header('Cache-Control', 'no-store')
  accessLog(@CurrentUser() user: AuthenticatedUser, @Param('id', id) docId: string, @Query(new ZodValidationPipe(AccessLogQuerySchema)) q: AccessLogQuery) {
    return this.folders.accessLog(user, { ...q, documentId: docId }, false);
  }
}
