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
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
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
  CompleteUploadDto,
  DocumentListQuery,
  FolderDto,
  PartUrlsDto,
  StartUploadDto,
  UpdateDocumentDto,
} from '../../../../packages/shared/src/documents/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import { DocumentsService } from './documents.service.ts';
import type { FileStream } from './documents.service.ts';
import { FoldersService } from './folders.service.ts';

const id = new ParseUUIDPipe({ version: '4' });
const optionalVersion = new ZodValidationPipe(z.string().uuid().optional());

/** RFC 6266 / 5987: an ASCII fallback plus the exact UTF-8 name. */
function disposition(kind: 'attachment' | 'inline', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function send(file: FileStream, kind: 'attachment' | 'inline', res: Response): StreamableFile {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Opened directly, the file is sandboxed: no scripts, no same-origin access.
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
  res.setHeader('X-Document-SHA256', file.sha256);
  return new StreamableFile(file.stream, { type: file.mimeType, disposition: disposition(kind, file.fileName), length: file.sizeBytes });
}

/** FR-DOC-001..004, 009, 012, 013, 019. Every route needs documents.use; rows are checked per document. */
@Controller('documents')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.DOCUMENTS_USE)
export class DocumentsController {
  constructor(
    private readonly docs: DocumentsService,
    private readonly folders: FoldersService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query(new ZodValidationPipe(DocumentListQuerySchema)) q: DocumentListQuery) {
    return this.docs.list(user, q);
  }

  // ---- uploads

  @Post('uploads')
  start(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(StartUploadDtoSchema)) dto: StartUploadDto) {
    return this.docs.startUpload(user, dto);
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
    return send(await this.docs.open(user, docId, versionId, 'download', ctx), 'attachment', res);
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
    return send(await this.docs.open(user, docId, versionId, 'preview', ctx), 'inline', res);
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
