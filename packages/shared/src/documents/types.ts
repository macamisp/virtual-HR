/**
 * Document contracts (FR-DOC-001..004, 007, 009, 012, 013, 015, 019) and minimal contracts
 * (SRS 7.4). Uploads go straight to object storage through presigned multipart URLs; the
 * API never trusts the browser's file type.
 */
import { z } from 'zod';
import { UserRefSchema } from '../tasks/types.ts';

const workDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const isoDate = z.string().datetime({ offset: true });

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** S3 parts must be at least 5 MiB except the last; 8 MiB keeps a 100 MB file at 13 parts. */
export const UPLOAD_PART_BYTES = 8 * 1024 * 1024;

export const DOCUMENT_CATEGORIES = ['CONTRACT', 'NDA', 'IDENTITY', 'TAX', 'INVOICE', 'POLICY', 'CERTIFICATE', 'OTHER'] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];
export const CATEGORY_LABEL: Record<DocumentCategory, string> = {
  CONTRACT: 'Contracts',
  NDA: 'NDAs',
  IDENTITY: 'Identity',
  TAX: 'Tax forms',
  INVOICE: 'Invoices',
  POLICY: 'Policies',
  CERTIFICATE: 'Certificates',
  OTHER: 'Other',
};

export const CONFIDENTIALITY_LEVELS = ['NORMAL', 'CONFIDENTIAL', 'RESTRICTED'] as const;
export type Confidentiality = (typeof CONFIDENTIALITY_LEVELS)[number];

export const DOCUMENT_PERMISSIONS = ['VIEW', 'DOWNLOAD', 'EDIT', 'MANAGE'] as const;
export type DocumentPermission = (typeof DOCUMENT_PERMISSIONS)[number];
export const PRINCIPAL_TYPES = ['USER', 'ROLE', 'TEAM'] as const;

export const SCAN_STATUSES = ['UPLOADING', 'PENDING', 'CLEAN', 'INFECTED', 'REJECTED'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const ACCESS_ACTIONS = [
  'VIEW', 'DOWNLOAD', 'UPLOAD', 'SHARE', 'DELETE', 'ACL_CHANGE', 'PASSWORD_FAIL', 'RECOVER', 'RESTORE', 'QUARANTINE', 'UPDATE',
  'SHRED', 'TRASH_RESTORE', 'LEGAL_HOLD', 'PASSWORD_SET', 'PASSWORD_REMOVED', 'REAUTH_REQUIRED',
] as const;
export type AccessAction = (typeof ACCESS_ACTIONS)[number];

export const CONTRACT_STATUSES = ['DRAFT', 'ACTIVE', 'EXPIRED', 'TERMINATED'] as const;

const fileName = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((v) => !/[\\/\u0000-\u001f]/.test(v), 'The file name cannot contain slashes or control characters');
const tag = z.string().trim().min(1).max(40);

// ---- requests

export const DocumentMetaDtoSchema = z.object({
  title: z.string().trim().min(1).max(300),
  category: z.enum(DOCUMENT_CATEGORIES),
  confidentiality: z.enum(CONFIDENTIALITY_LEVELS).default('NORMAL'),
  folderId: z.string().uuid().nullable().optional(),
  linkedUserId: z.string().uuid().nullable().optional(),
  linkedContractId: z.string().uuid().nullable().optional(),
  linkedProjectId: z.string().uuid().nullable().optional(),
  tags: z.array(tag).max(20).default([]),
  expiresAt: workDate.nullable().optional(),
});
export type DocumentMetaDto = z.infer<typeof DocumentMetaDtoSchema>;

/** A new document (metadata) or a new version of an existing one (documentId). */
export const StartUploadDtoSchema = z
  .object({
    fileName,
    size: z.number().int().min(1, 'The file is empty').max(MAX_UPLOAD_BYTES, 'Files can be at most 100 MB'),
    documentId: z.string().uuid().optional(),
    metadata: DocumentMetaDtoSchema.optional(),
    /** Needed to add a version to a password-protected document. */
    documentPassword: z.string().max(200).optional(),
  })
  .refine((v) => (v.documentId ? !v.metadata : !!v.metadata), 'Send either documentId (new version) or metadata (new document)');
export type StartUploadDto = z.infer<typeof StartUploadDtoSchema>;

export const PartUrlsDtoSchema = z.object({ partNumbers: z.array(z.number().int().min(1).max(10000)).min(1).max(100) });
export type PartUrlsDto = z.infer<typeof PartUrlsDtoSchema>;

export const CompleteUploadDtoSchema = z.object({
  parts: z.array(z.object({ partNumber: z.number().int().min(1).max(10000), etag: z.string().min(1).max(200) })).min(1).max(10000),
});
export type CompleteUploadDto = z.infer<typeof CompleteUploadDtoSchema>;

export const UpdateDocumentDtoSchema = DocumentMetaDtoSchema.partial().extend({ version: z.number().int().min(1) });
export type UpdateDocumentDto = z.infer<typeof UpdateDocumentDtoSchema>;

export const FolderDtoSchema = z.object({
  name: z.string().trim().min(1).max(120).refine((v) => !/[\\/]/.test(v), 'Folder names cannot contain slashes'),
  parentId: z.string().uuid().nullable().optional(),
});
export type FolderDto = z.infer<typeof FolderDtoSchema>;

export const AclGrantDtoSchema = z
  .object({
    principalType: z.enum(PRINCIPAL_TYPES),
    principalId: z.string().uuid().optional(),
    principalRole: z.string().max(50).optional(),
    permission: z.enum(DOCUMENT_PERMISSIONS),
    expiresAt: isoDate.nullable().optional(),
  })
  .refine((v) => (v.principalType === 'ROLE' ? !!v.principalRole && !v.principalId : !!v.principalId && !v.principalRole), 'A role grant names a role; user and team grants name an id');
export type AclGrantDto = z.infer<typeof AclGrantDtoSchema>;

export const DocumentListQuerySchema = z.object({
  folderId: z.string().uuid().optional(),
  category: z.enum(DOCUMENT_CATEGORIES).optional(),
  q: z.string().trim().max(100).optional(),
  linkedUserId: z.string().uuid().optional(),
  expiringWithinDays: z.coerce.number().int().min(1).max(366).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type DocumentListQuery = z.infer<typeof DocumentListQuerySchema>;

export const AccessLogQuerySchema = z.object({
  documentId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  action: z.enum(ACCESS_ACTIONS).optional(),
  from: workDate.optional(),
  to: workDate.optional(),
  format: z.enum(['json', 'csv']).default('json'),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
export type AccessLogQuery = z.infer<typeof AccessLogQuerySchema>;

export const ContractDtoSchema = z.object({
  userId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  scope: z.string().max(10000).default(''),
  startDate: workDate,
  endDate: workDate.nullable().optional(),
  status: z.enum(CONTRACT_STATUSES).default('DRAFT'),
  renewalNoticeDays: z.number().int().min(0).max(365).default(30),
  documentId: z.string().uuid().nullable().optional(),
});
export type ContractDto = z.infer<typeof ContractDtoSchema>;

export const ContractUpdateDtoSchema = ContractDtoSchema.omit({ userId: true }).partial().extend({ version: z.number().int().min(1) });
export type ContractUpdateDto = z.infer<typeof ContractUpdateDtoSchema>;

// ---- responses

export const UploadTicketSchema = z.object({
  documentId: z.string(),
  versionId: z.string(),
  partSize: z.number(),
  partCount: z.number(),
  parts: z.array(z.object({ partNumber: z.number(), url: z.string() })),
  /** Presigned URLs live 5 minutes (SRS 10.3); ask for fresh ones with /parts. */
  expiresAt: isoDate,
});
export type UploadTicket = z.infer<typeof UploadTicketSchema>;

export const UploadStateSchema = z.object({
  versionId: z.string(),
  status: z.enum(SCAN_STATUSES),
  uploadedParts: z.array(z.object({ partNumber: z.number(), etag: z.string(), size: z.number() })),
  partSize: z.number(),
  partCount: z.number(),
});
export type UploadState = z.infer<typeof UploadStateSchema>;

export const DocumentAbilitiesSchema = z.object({
  canView: z.boolean(),
  /** The original file inline (needs DOWNLOAD). */
  canPreview: z.boolean(),
  /** FR-DOC-011: the watermarked, view-only rendering (VIEW is enough; PDF, PNG, JPEG). */
  canViewOnly: z.boolean(),
  canDownload: z.boolean(),
  canEdit: z.boolean(),
  canManage: z.boolean(),
});

export const DocumentVersionSchema = z.object({
  id: z.string(),
  versionNo: z.number(),
  fileName: z.string(),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  sha256: z.string().nullable(),
  scanStatus: z.enum(SCAN_STATUSES),
  scanDetail: z.string().nullable(),
  uploadedBy: UserRefSchema,
  uploadedAt: isoDate,
  scannedAt: isoDate.nullable(),
  restoredFromVersionNo: z.number().nullable(),
  isCurrent: z.boolean(),
});
export type DocumentVersion = z.infer<typeof DocumentVersionSchema>;

export const DocumentSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  category: z.enum(DOCUMENT_CATEGORIES),
  confidentiality: z.enum(CONFIDENTIALITY_LEVELS),
  folderId: z.string().nullable(),
  folderName: z.string().nullable(),
  owner: UserRefSchema,
  linkedUser: UserRefSchema.nullable(),
  linkedContract: z.object({ id: z.string(), title: z.string() }).nullable(),
  linkedProject: z.object({ id: z.string(), name: z.string() }).nullable(),
  tags: z.array(z.string()),
  expiresAt: workDate.nullable(),
  /** Scan status of the newest version (what the uploader is waiting for). */
  latestStatus: z.enum(SCAN_STATUSES).nullable(),
  currentVersionNo: z.number().nullable(),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  previewable: z.boolean(),
  /** FR-DOC-005: opening the content needs a re-authentication in the last N minutes. */
  requiresReauth: z.boolean(),
  passwordProtected: z.boolean(),
  legalHold: z.boolean(),
  deletedAt: isoDate.nullable(),
  updatedAt: isoDate,
  version: z.number(),
  abilities: DocumentAbilitiesSchema,
});
export type DocumentSummary = z.infer<typeof DocumentSummarySchema>;
export const DocumentListSchema = z.object({ items: z.array(DocumentSummarySchema) });

export const AclEntrySchema = z.object({
  id: z.string(),
  target: z.enum(['DOCUMENT', 'FOLDER']),
  folderName: z.string().nullable(),
  principalType: z.enum(PRINCIPAL_TYPES),
  principalId: z.string().nullable(),
  principalLabel: z.string(),
  permission: z.enum(DOCUMENT_PERMISSIONS),
  expiresAt: isoDate.nullable(),
  expired: z.boolean(),
  grantedBy: UserRefSchema,
  createdAt: isoDate,
});
export type AclEntry = z.infer<typeof AclEntrySchema>;
export const AclListSchema = z.object({ items: z.array(AclEntrySchema) });

export const DocumentDetailSchema = DocumentSummarySchema.extend({
  versions: z.array(DocumentVersionSchema),
  createdAt: isoDate,
});
export type DocumentDetail = z.infer<typeof DocumentDetailSchema>;

export const FolderSchema = z.object({ id: z.string(), name: z.string(), parentId: z.string().nullable(), canEdit: z.boolean(), canManage: z.boolean() });
export type Folder = z.infer<typeof FolderSchema>;
export const FolderListSchema = z.object({ items: z.array(FolderSchema), canCreateTopLevel: z.boolean() });

export const AccessLogEntrySchema = z.object({
  id: z.string(),
  documentId: z.string().nullable(),
  documentTitle: z.string().nullable(),
  versionNo: z.number().nullable(),
  user: UserRefSchema.nullable(),
  action: z.enum(ACCESS_ACTIONS),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()).nullable(),
  createdAt: isoDate,
});
export type AccessLogEntry = z.infer<typeof AccessLogEntrySchema>;
export const AccessLogListSchema = z.object({ items: z.array(AccessLogEntrySchema) });

export const ContractSchema = z.object({
  id: z.string(),
  user: UserRefSchema,
  title: z.string(),
  scope: z.string(),
  startDate: workDate,
  endDate: workDate.nullable(),
  status: z.enum(CONTRACT_STATUSES),
  renewalNoticeDays: z.number(),
  document: z.object({ id: z.string(), title: z.string(), latestStatus: z.enum(SCAN_STATUSES).nullable() }).nullable(),
  version: z.number(),
  canEdit: z.boolean(),
});
export type Contract = z.infer<typeof ContractSchema>;
export const ContractListSchema = z.object({ items: z.array(ContractSchema), canManage: z.boolean() });

export const ShareTargetsSchema = z.object({
  users: z.array(UserRefSchema),
  teams: z.array(z.object({ id: z.string(), name: z.string() })),
  roles: z.array(z.string()),
});
export type ShareTargets = z.infer<typeof ShareTargetsSchema>;

// ---- confidential vault (FR-DOC-005, 006, 010, 011, 017)

const docPassword = z.string().min(10, 'Use at least 10 characters').max(200);

export const ReauthDtoSchema = z
  .object({ password: z.string().min(1).max(200).optional(), totpCode: z.string().regex(/^\d{6}$/, 'Six digits').optional() })
  .refine((v) => !!v.password !== !!v.totpCode, 'Give either your password or a code from your authenticator app');
export type ReauthDto = z.infer<typeof ReauthDtoSchema>;

export const ReauthStatusSchema = z.object({ validUntil: isoDate.nullable(), windowMinutes: z.number(), totpAvailable: z.boolean() });
export type ReauthStatus = z.infer<typeof ReauthStatusSchema>;

export const OpenContentDtoSchema = z.object({
  mode: z.enum(['download', 'preview', 'view']),
  versionId: z.string().uuid().optional(),
  password: z.string().max(200).optional(),
});
export type OpenContentDto = z.infer<typeof OpenContentDtoSchema>;

export const SetDocumentPasswordDtoSchema = z.object({ password: docPassword, currentPassword: z.string().max(200).optional() });
export type SetDocumentPasswordDto = z.infer<typeof SetDocumentPasswordDtoSchema>;

export const RemoveDocumentPasswordDtoSchema = z.object({ currentPassword: z.string().min(1).max(200) });
export type RemoveDocumentPasswordDto = z.infer<typeof RemoveDocumentPasswordDtoSchema>;

export const RecoverDocumentPasswordDtoSchema = z.object({ newPassword: docPassword, reason: z.string().trim().min(5, 'Explain why').max(500) });
export type RecoverDocumentPasswordDto = z.infer<typeof RecoverDocumentPasswordDtoSchema>;

export const ShareLinkDtoSchema = z.object({
  expiresAt: isoDate,
  maxDownloads: z.number().int().min(1).max(1000).nullable().optional(),
  password: z.string().min(8, 'Use at least 8 characters').max(200).optional(),
  viewOnly: z.boolean().default(false),
});
export type ShareLinkDto = z.infer<typeof ShareLinkDtoSchema>;

export const ShareLinkSchema = z.object({
  id: z.string(),
  viewOnly: z.boolean(),
  passwordProtected: z.boolean(),
  expiresAt: isoDate,
  maxDownloads: z.number().nullable(),
  downloadCount: z.number(),
  revokedAt: isoDate.nullable(),
  active: z.boolean(),
  createdBy: UserRefSchema,
  createdAt: isoDate,
  lastUsedAt: isoDate.nullable(),
});
export type ShareLink = z.infer<typeof ShareLinkSchema>;
export const ShareLinkListSchema = z.object({ items: z.array(ShareLinkSchema) });
/** The token is shown once, at creation; only its hash is kept. */
export const CreatedShareLinkSchema = z.object({ link: ShareLinkSchema, token: z.string(), url: z.string() });
export type CreatedShareLink = z.infer<typeof CreatedShareLinkSchema>;

export const PublicShareInfoSchema = z.object({
  title: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  viewOnly: z.boolean(),
  passwordRequired: z.boolean(),
  expiresAt: isoDate,
  remaining: z.number().nullable(),
});
export type PublicShareInfo = z.infer<typeof PublicShareInfoSchema>;

export const PublicShareOpenDtoSchema = z.object({ mode: z.enum(['download', 'view']), password: z.string().max(200).optional() });
export type PublicShareOpenDto = z.infer<typeof PublicShareOpenDtoSchema>;

export const LegalHoldDtoSchema = z
  .object({ hold: z.boolean(), reason: z.string().trim().max(500).optional() })
  .refine((v) => !v.hold || (v.reason ?? '').length >= 5, 'A legal hold needs a reason');
export type LegalHoldDto = z.infer<typeof LegalHoldDtoSchema>;

export const RetentionRuleSchema = z.object({
  category: z.enum(DOCUMENT_CATEGORIES),
  minYears: z.number().int().min(1).max(100).nullable(),
  autoShredYears: z.number().int().min(1).max(100).nullable(),
});
export type RetentionRule = z.infer<typeof RetentionRuleSchema>;
export const RetentionRulesDtoSchema = z.object({ rules: z.array(RetentionRuleSchema).max(8) }).refine(
  (v) => v.rules.every((r) => r.minYears === null || r.autoShredYears === null || r.autoShredYears >= r.minYears),
  'Automatic shredding cannot come before the minimum retention',
);
export type RetentionRulesDto = z.infer<typeof RetentionRulesDtoSchema>;
export const RetentionRulesSchema = z.object({ rules: z.array(RetentionRuleSchema), canManage: z.boolean() });
