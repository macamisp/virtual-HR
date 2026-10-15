/**
 * FR-DOC-009 effective permission on a document, as a level:
 * 0 none, 1 VIEW, 2 DOWNLOAD, 3 EDIT, 4 MANAGE (each includes the ones below).
 *
 *  - HR and admins (documents.read.all): MANAGE on everything.
 *  - The owner: MANAGE. The linked person: DOWNLOAD (their own contract, ID, invoice).
 *  - ACL grants on the document or any ancestor folder, for the user, their role or their
 *    team, while not expired (computed in SQL: fn_document_acl_level). Subcontractors only
 *    receive grants made to them by name or to the SUBCONTRACTOR role, never team-wide grants,
 *    so by default they see only documents linked to themselves (agreed default).
 */
export const LEVEL = { NONE: 0, VIEW: 1, DOWNLOAD: 2, EDIT: 3, MANAGE: 4 } as const;
export type DocumentPermissionName = 'VIEW' | 'DOWNLOAD' | 'EDIT' | 'MANAGE';

export interface LevelFacts {
  isHr: boolean;
  isOwner: boolean;
  isLinked: boolean;
  aclLevel: number;
}

export function effectiveLevel(f: LevelFacts): number {
  if (f.isHr || f.isOwner) return LEVEL.MANAGE;
  return Math.max(f.isLinked ? LEVEL.DOWNLOAD : LEVEL.NONE, f.aclLevel);
}

export interface DocumentAbilities {
  canView: boolean;
  canPreview: boolean;
  canDownload: boolean;
  canEdit: boolean;
  canManage: boolean;
}

/** `currentStatus` is the scan status of the current version (null: nothing uploaded yet). */
export function documentAbilities(level: number, currentStatus: string | null): DocumentAbilities {
  const clean = currentStatus === 'CLEAN';
  return {
    canView: level >= LEVEL.VIEW,
    canPreview: level >= LEVEL.VIEW && clean,
    canDownload: level >= LEVEL.DOWNLOAD && clean,
    canEdit: level >= LEVEL.EDIT,
    canManage: level >= LEVEL.MANAGE,
  };
}
