/**
 * Virtual office map (FR-VO-001): a subset of the Tiled JSON format, one map per floor.
 * Layers used:
 *  - tile layer "floor": floor style per tile (0 = void, 1 carpet, 2 wood, 3 meeting, 4 private, 5 reception)
 *  - tile layer "walls": non-zero = wall (blocks movement)
 *  - object group "rooms": rectangles with properties type, capacity, access
 *  - object group "desks": rectangles; the object name is the desk label
 *  - object group "furniture": rectangles; property collides=true blocks movement
 *  - object group "spawn": a point where newcomers appear (first object wins)
 * ADR 015. Pure and shared by the API (validation) and the browser (rendering, prediction).
 */
import { z } from 'zod';

export const TILE_SIZE = 32;
export const MAX_MAP_TILES = 200; // per side
export const ROOM_TYPES = ['OPEN', 'MEETING', 'PRIVATE', 'BROADCAST'] as const;
export type RoomType = (typeof ROOM_TYPES)[number];
export const ACCESS_MODES = ['OPEN', 'KNOCK', 'INVITE', 'PASSWORD'] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

const PropertySchema = z.object({ name: z.string().max(40), type: z.enum(['string', 'int', 'float', 'bool']).default('string'), value: z.union([z.string().max(200), z.number(), z.boolean()]) });

const MapObjectSchema = z.object({
  id: z.number().int().nonnegative(),
  name: z.string().max(80).default(''),
  type: z.string().max(40).default(''),
  x: z.number().min(0),
  y: z.number().min(0),
  width: z.number().min(0).default(0),
  height: z.number().min(0).default(0),
  properties: z.array(PropertySchema).max(20).optional(),
});
export type MapObject = z.infer<typeof MapObjectSchema>;

const TileLayerSchema = z.object({
  type: z.literal('tilelayer'),
  name: z.string().max(40),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  data: z.array(z.number().int().min(0).max(255)),
});
const ObjectGroupSchema = z.object({
  type: z.literal('objectgroup'),
  name: z.string().max(40),
  objects: z.array(MapObjectSchema).max(2000),
});

export const OfficeMapSchema = z
  .object({
    type: z.literal('map').default('map'),
    orientation: z.literal('orthogonal').default('orthogonal'),
    infinite: z.literal(false).default(false),
    width: z.number().int().min(8).max(MAX_MAP_TILES),
    height: z.number().int().min(8).max(MAX_MAP_TILES),
    tilewidth: z.literal(TILE_SIZE),
    tileheight: z.literal(TILE_SIZE),
    layers: z.array(z.discriminatedUnion('type', [TileLayerSchema, ObjectGroupSchema])).min(1).max(12),
  })
  .superRefine((m, ctx) => {
    for (const l of m.layers) {
      if (l.type === 'tilelayer' && (l.width !== m.width || l.height !== m.height || l.data.length !== m.width * m.height)) {
        ctx.addIssue({ code: 'custom', message: `Layer "${l.name}" must be ${m.width}×${m.height} with ${m.width * m.height} tiles` });
      }
      if (l.type === 'objectgroup') {
        for (const o of l.objects) {
          if (o.x + o.width > m.width * TILE_SIZE || o.y + o.height > m.height * TILE_SIZE) ctx.addIssue({ code: 'custom', message: `Object ${o.id} in "${l.name}" lies outside the map` });
        }
      }
    }
    if (!m.layers.some((l) => l.type === 'tilelayer' && l.name === 'walls')) ctx.addIssue({ code: 'custom', message: 'A "walls" tile layer is required' });
  });
export type OfficeMap = z.infer<typeof OfficeMapSchema>;

export const OfficeDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(100),
  floors: z
    .array(z.object({ id: z.string().regex(/^[a-z0-9-]{1,32}$/), name: z.string().trim().min(1).max(60), map: OfficeMapSchema }))
    .min(1)
    .max(5)
    .refine((f) => new Set(f.map((x) => x.id)).size === f.length, { message: 'Floor ids must be unique' }),
});
export type OfficeDefinition = z.infer<typeof OfficeDefinitionSchema>;

export interface Rect { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }

export function prop<T extends string | number | boolean>(o: MapObject, name: string, fallback: T): T {
  const p = o.properties?.find((x) => x.name === name);
  return (p ? p.value : fallback) as T;
}

export function objectLayer(map: OfficeMap, name: string): MapObject[] {
  const l = map.layers.find((x) => x.type === 'objectgroup' && x.name === name);
  return l && l.type === 'objectgroup' ? l.objects : [];
}

export function tileLayer(map: OfficeMap, name: string): number[] | null {
  const l = map.layers.find((x) => x.type === 'tilelayer' && x.name === name);
  return l && l.type === 'tilelayer' ? l.data : null;
}

export interface MapRoom { objectId: number; name: string; type: RoomType; capacity: number; access: AccessMode; bounds: Rect }
export interface MapDesk { objectId: number; label: string; bounds: Rect }

/** Rooms and desks declared in a floor map (synchronised into the rooms / desks tables). */
export function mapRooms(map: OfficeMap): MapRoom[] {
  return objectLayer(map, 'rooms').map((o) => {
    const type = String(prop(o, 'type', 'OPEN')).toUpperCase();
    const access = String(prop(o, 'access', 'OPEN')).toUpperCase();
    return {
      objectId: o.id,
      name: o.name || `Room ${o.id}`,
      type: (ROOM_TYPES as readonly string[]).includes(type) ? (type as RoomType) : 'OPEN',
      capacity: Math.max(1, Math.min(500, Number(prop(o, 'capacity', 8)) || 8)),
      access: (ACCESS_MODES as readonly string[]).includes(access) ? (access as AccessMode) : 'OPEN',
      bounds: { x: o.x, y: o.y, width: o.width, height: o.height },
    };
  });
}

export function mapDesks(map: OfficeMap): MapDesk[] {
  return objectLayer(map, 'desks').map((o) => ({ objectId: o.id, label: o.name || `Desk ${o.id}`, bounds: { x: o.x, y: o.y, width: o.width, height: o.height } }));
}

export function spawnPoint(map: OfficeMap): Point {
  const s = objectLayer(map, 'spawn')[0];
  return s ? { x: s.x, y: s.y } : { x: (map.width * TILE_SIZE) / 2, y: (map.height * TILE_SIZE) / 2 };
}

export const inRect = (r: Rect, p: Point): boolean => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
export const centre = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
