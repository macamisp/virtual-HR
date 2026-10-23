/**
 * Ending sessions (FR-AUTH-003, FR-AUTH-009). One place for every caller: logout, password reset,
 * role or ownership changes, suspension and offboarding. Marks every still-valid auth_sessions
 * row of a family or a person as revoked and drops the matching heartbeat secrets; the database
 * trigger (hrvo_auth_events) then disconnects their sockets (ADR 028). Rows already revoked for
 * a non-rotation reason keep their original reason.
 */
export type RevokeReason =
  | 'ROTATED' | 'LOGOUT' | 'FAMILY_REUSE' | 'PASSWORD_RESET' | 'USER_DEACTIVATED' | 'DEVICE_REVOKED' | 'ADMIN_REVOKED'
  | 'ROLE_CHANGED' | 'OWNERSHIP_CHANGED' | 'USER_SUSPENDED' | 'USER_OFFBOARDED';

interface Db { query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null }> }

export async function revokeSessionsOf(
  db: Db,
  orgId: string,
  scope: { familyId: string } | { userId: string },
  reason: Exclude<RevokeReason, 'ROTATED'>,
): Promise<number> {
  const [column, value] = 'familyId' in scope ? ['family_id', scope.familyId] : ['user_id', scope.userId];
  const res = await db.query(
    `UPDATE auth_sessions
     SET is_revoked = true, revoked_reason = $3, updated_at = CURRENT_TIMESTAMP
     WHERE org_id = $1 AND ${column} = $2
       AND (NOT is_revoked OR revoked_reason IS NULL OR revoked_reason = 'ROTATED')
     RETURNING id`,
    [orgId, value, reason],
  );
  await db.query(
    `DELETE FROM session_secrets
     WHERE org_id = $1 AND session_id IN (SELECT id::text FROM auth_sessions WHERE org_id = $1 AND ${column} = $2)`,
    [orgId, value],
  );
  return res.rowCount ?? 0;
}
