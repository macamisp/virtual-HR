/**
 * ADR 038: one lock order for every transaction that touches tenant data.
 *
 *   1. parent rows first: the organisation, then people (users, ascending id), each at the
 *      strength the transaction needs, never upgraded later in the same transaction;
 *   2. then the audit-chain advisory lock (one per organisation, audit-chain.ts);
 *   3. then child rows (attendance sessions, segments, presence events, daily rows, ...).
 *
 * Parent rows are locked with FOR NO KEY UPDATE, never FOR UPDATE. No code changes a key column of
 * organizations or users (their only unique columns are the primary keys and the organisation
 * slug, which is never updated), and FOR NO KEY UPDATE does not conflict with the FOR KEY SHARE
 * lock that every foreign-key check of a child insert takes. With FOR UPDATE, a settings or
 * person write blocked every heartbeat, session save and audit append of that organisation or
 * person, and closed a cycle with any of them that already held a session row or the audit lock.
 * test/lock-order.test.ts reproduces those cycles and checks that no FOR UPDATE on these tables
 * comes back.
 */
import type pg from 'pg';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sortedIds(ids: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && UUID.test(id)))].sort();
}

/** Serialises writers of the organisation's own settings. */
export async function lockOrgForWrite(db: pg.PoolClient, orgId: string): Promise<void> {
  await db.query(`SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE`, [orgId]);
}

/** Serialises writers of these people's rows (ascending id, so two such transactions never cross). */
export async function lockUsersForWrite(db: pg.PoolClient, userIds: ReadonlyArray<string>): Promise<void> {
  const ids = sortedIds(userIds);
  if (ids.length) await db.query(`SELECT 1 FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE`, [ids]);
}

/**
 * Step 1 for transactions that later lock child rows and insert rows referencing these parents
 * (attendance saves, audit appends): the FOR KEY SHARE locks their foreign-key checks would take
 * anyway, taken up front. Should anything hold a stronger lock on a parent (a delete), this
 * transaction waits here holding nothing, instead of waiting later while holding a session row
 * or the audit lock that the other one needs.
 */
export async function lockTenantParents(db: pg.PoolClient, orgId: string, userIds: ReadonlyArray<string | null | undefined> = []): Promise<void> {
  await db.query(`SELECT 1 FROM organizations WHERE id = $1 FOR KEY SHARE`, [orgId]);
  const ids = sortedIds(userIds);
  if (ids.length) await db.query(`SELECT 1 FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR KEY SHARE`, [ids]);
}
