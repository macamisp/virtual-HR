/**
 * Office persistence (ADR 015): the org's office row (created from the default map on first
 * use), and the rooms and desks synchronised from the map's object layers. Access settings,
 * passwords, invites and desk assignments survive a map change when the object id stays.
 */
import type pg from 'pg';
import { defaultOffice, mapDesks, mapRooms, OfficeDefinitionSchema } from '../../../../packages/shared/src/office/index.ts';
import type { AccessMode, OfficeDefinition, Rect, RoomType } from '../../../../packages/shared/src/office/index.ts';
import type { DeskInfo, RoomInfo } from './office-world.ts';

export interface OfficeRow {
  id: string;
  name: string;
  definition: OfficeDefinition;
  proximityRadius: number;
  version: number;
}

export async function ensureOffice(db: pg.PoolClient, orgId: string): Promise<OfficeRow> {
  const existing = await db.query<{ id: string; name: string; map_json: unknown; proximity_radius: number; version: number }>(
    `SELECT id, name, map_json, proximity_radius, version FROM offices WHERE org_id = $1`, [orgId],
  );
  if (existing.rows[0]) {
    const r = existing.rows[0];
    return { id: r.id, name: r.name, definition: OfficeDefinitionSchema.parse(r.map_json), proximityRadius: r.proximity_radius, version: r.version };
  }
  const def = defaultOffice();
  const created = await db.query<{ id: string }>(
    `INSERT INTO offices (org_id, name, map_json) VALUES ($1, $2, $3) ON CONFLICT (org_id) DO NOTHING RETURNING id`,
    [orgId, def.name, JSON.stringify(def)],
  );
  if (!created.rows[0]) return await ensureOffice(db, orgId); // another request created it first
  await syncLayout(db, orgId, created.rows[0].id, def);
  return { id: created.rows[0].id, name: def.name, definition: def, proximityRadius: 96, version: 1 };
}

/** Upserts rooms and desks from the map; removes those whose object no longer exists. */
export async function syncLayout(db: pg.PoolClient, orgId: string, officeId: string, def: OfficeDefinition): Promise<void> {
  const keepRooms: string[] = [];
  const keepDesks: string[] = [];
  for (const f of def.floors) {
    for (const r of mapRooms(f.map)) {
      // A map may declare a PASSWORD room, but a password is only ever set through the API.
      const access: AccessMode = r.access === 'PASSWORD' ? 'KNOCK' : r.access;
      const res = await db.query<{ id: string }>(
        `INSERT INTO rooms (org_id, office_id, floor_id, map_object_id, name, type, capacity, bounds, access_mode, livekit_room_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (office_id, floor_id, map_object_id) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type, bounds = EXCLUDED.bounds, updated_at = now()
         RETURNING id`,
        [orgId, officeId, f.id, r.objectId, r.name, r.type, r.capacity, JSON.stringify(r.bounds), access, `hrvo-${orgId}-${f.id}-${r.objectId}`],
      );
      keepRooms.push(res.rows[0]!.id);
    }
    for (const d of mapDesks(f.map)) {
      const res = await db.query<{ id: string }>(
        `INSERT INTO desks (org_id, office_id, floor_id, map_object_id, label, bounds) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (office_id, floor_id, map_object_id) DO UPDATE SET label = EXCLUDED.label, bounds = EXCLUDED.bounds, updated_at = now()
         RETURNING id`,
        [orgId, officeId, f.id, d.objectId, d.label, JSON.stringify(d.bounds)],
      );
      keepDesks.push(res.rows[0]!.id);
    }
  }
  await db.query(`DELETE FROM rooms WHERE office_id = $1 AND NOT (id = ANY($2::uuid[]))`, [officeId, keepRooms]);
  await db.query(`DELETE FROM desks WHERE office_id = $1 AND NOT (id = ANY($2::uuid[]))`, [officeId, keepDesks]);
}

export async function loadRooms(db: pg.PoolClient, officeId: string): Promise<RoomInfo[]> {
  const res = await db.query<{ id: string; floor_id: string; name: string; type: RoomType; capacity: number; access_mode: AccessMode; bounds: Rect; password_hash: string | null }>(
    `SELECT id, floor_id, name, type, capacity, access_mode, bounds, password_hash FROM rooms WHERE office_id = $1 ORDER BY floor_id, map_object_id`, [officeId],
  );
  return res.rows.map((r) => ({ id: r.id, floorId: r.floor_id, name: r.name, type: r.type, capacity: r.capacity, accessMode: r.access_mode, bounds: r.bounds, passwordHash: r.password_hash }));
}

export async function loadDesks(db: pg.PoolClient, officeId: string): Promise<DeskInfo[]> {
  const res = await db.query<{ id: string; floor_id: string; label: string; bounds: Rect; assigned_user_id: string | null }>(
    `SELECT id, floor_id, label, bounds, assigned_user_id FROM desks WHERE office_id = $1 ORDER BY floor_id, map_object_id`, [officeId],
  );
  return res.rows.map((d) => ({ id: d.id, floorId: d.floor_id, label: d.label, bounds: d.bounds, assignedUserId: d.assigned_user_id }));
}

export async function loadInvites(db: pg.PoolClient): Promise<Map<string, Set<string>>> {
  const res = await db.query<{ room_id: string; user_id: string }>(`SELECT room_id, user_id FROM room_invites`);
  const out = new Map<string, Set<string>>();
  for (const r of res.rows) out.set(r.room_id, (out.get(r.room_id) ?? new Set<string>()).add(r.user_id));
  return out;
}
