/**
 * Shared SQL for documents. The permission level is computed in SQL with the same rule as
 * document-policy.ts: HR / owner = MANAGE, linked user = DOWNLOAD, else the strongest
 * unexpired ACL grant (fn_acl_level, inherited through folders).
 */
import { hasPermission, Permission } from '../../../../packages/shared/src/auth/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import type { DocumentSummary, ScanStatus } from '../../../../packages/shared/src/documents/types.ts';
import { toIso, userRef } from '../tasks/tasks.sql.ts';
import { documentAbilities } from './document-policy.ts';
import { PREVIEWABLE } from './sniff.ts';
import type { FileKind } from './sniff.ts';

export interface DocActor {
  id: string;
  role: string;
  teamId: string | null;
  isHr: boolean;
}

export function docActor(user: AuthenticatedUser): DocActor {
  return { id: user.id, role: user.role, teamId: user.teamId ?? null, isHr: hasPermission(user.role, Permission.DOCUMENTS_READ_ALL) };
}

/** Appends the actor to params and returns the level expression for alias `d`. */
export function levelSql(a: DocActor, params: unknown[]): string {
  params.push(a.isHr, a.id, a.role, a.teamId);
  const n = params.length;
  const [hr, me, role, team] = [`$${n - 3}`, `$${n - 2}`, `$${n - 1}`, `$${n}::uuid`];
  return `(CASE WHEN ${hr} OR d.owner_id = ${me} THEN 4
    ELSE GREATEST(CASE WHEN d.linked_user_id = ${me} THEN 2 ELSE 0 END, fn_acl_level(d.id, NULL, ${me}, ${role}, ${team})) END)`;
}

export function folderLevelSql(a: DocActor, params: unknown[], folderExpr: string): string {
  params.push(a.isHr, a.id, a.role, a.teamId);
  const n = params.length;
  return `(CASE WHEN $${n - 3} THEN 4 ELSE fn_acl_level(NULL, ${folderExpr}, $${n - 2}, $${n - 1}, $${n}::uuid) END)`;
}

export const SUMMARY_COLUMNS = `
  d.id, d.title, d.category, d.confidentiality, d.folder_id, f.name AS folder_name,
  d.owner_id, o.display_name AS o_name, o.email AS o_email, o.role AS o_role,
  d.linked_user_id, lu.display_name AS lu_name, lu.email AS lu_email, lu.role AS lu_role,
  d.linked_contract_id, c.title AS contract_title, d.linked_project_id, p.name AS project_name,
  d.tags, to_char(d.expires_at, 'YYYY-MM-DD') AS expires_at, d.updated_at, d.created_at, d.version,
  cv.version_no AS current_version_no, cv.mime_type, cv.size_bytes, cv.scan_status AS current_status,
  (SELECT lv.scan_status FROM document_versions lv WHERE lv.document_id = d.id ORDER BY lv.version_no DESC LIMIT 1) AS latest_status`;

export const SUMMARY_FROM = `
  FROM documents d
  JOIN users o ON o.id = d.owner_id
  LEFT JOIN users lu ON lu.id = d.linked_user_id
  LEFT JOIN document_folders f ON f.id = d.folder_id
  LEFT JOIN contracts c ON c.id = d.linked_contract_id
  LEFT JOIN projects p ON p.id = d.linked_project_id
  LEFT JOIN document_versions cv ON cv.id = d.current_version_id`;

export interface SummaryRow {
  id: string;
  title: string;
  category: DocumentSummary['category'];
  confidentiality: DocumentSummary['confidentiality'];
  folder_id: string | null;
  folder_name: string | null;
  owner_id: string;
  o_name: string | null;
  o_email: string;
  o_role: string;
  linked_user_id: string | null;
  lu_name: string | null;
  lu_email: string | null;
  lu_role: string | null;
  linked_contract_id: string | null;
  contract_title: string | null;
  linked_project_id: string | null;
  project_name: string | null;
  tags: string[];
  expires_at: string | null;
  updated_at: Date;
  created_at: Date;
  version: number;
  current_version_no: number | null;
  mime_type: string | null;
  size_bytes: string | null;
  current_status: ScanStatus | null;
  latest_status: ScanStatus | null;
  level: number;
}

const KIND_BY_MIME: Record<string, FileKind> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export function isPreviewableMime(mime: string | null): boolean {
  const k = mime ? KIND_BY_MIME[mime] : undefined;
  return !!k && PREVIEWABLE.includes(k);
}

export function mapSummary(r: SummaryRow): DocumentSummary {
  const abilities = documentAbilities(r.level, r.current_status);
  return {
    id: r.id,
    title: r.title,
    category: r.category,
    confidentiality: r.confidentiality,
    folderId: r.folder_id,
    folderName: r.folder_name,
    owner: userRef(r.owner_id, r.o_name, r.o_email, r.o_role),
    linkedUser: r.linked_user_id && r.lu_email ? userRef(r.linked_user_id, r.lu_name, r.lu_email, r.lu_role) : null,
    linkedContract: r.linked_contract_id && r.contract_title !== null ? { id: r.linked_contract_id, title: r.contract_title } : null,
    linkedProject: r.linked_project_id && r.project_name !== null ? { id: r.linked_project_id, name: r.project_name } : null,
    tags: r.tags,
    expiresAt: r.expires_at,
    latestStatus: r.latest_status,
    currentVersionNo: r.current_version_no,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
    previewable: r.current_status === 'CLEAN' && isPreviewableMime(r.mime_type),
    updatedAt: toIso(r.updated_at)!,
    version: r.version,
    abilities: { ...abilities, canPreview: abilities.canPreview && isPreviewableMime(r.mime_type) },
  };
}
