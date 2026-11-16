/**
 * Upgrades ONE organisation's stored office map to the campus map (ADR 055) through the existing,
 * audited admin route PUT /office/map. Run it yourself, in your own terminal: it asks for your
 * e-mail, password and 2FA code there (the password is not echoed) and prints no token.
 *
 *   node --experimental-strip-types scripts/office-map-upgrade.ts https://api.virtual-hr.site --dry-run
 *   node --experimental-strip-types scripts/office-map-upgrade.ts https://api.virtual-hr.site
 *
 * It refuses unless the stored map is still the unmodified original 60 x 40 map (a customised map
 * is never overwritten), and checks afterwards that every room and desk kept its row, settings and
 * assignment. Roll back with --rollback, which puts the original map back (the campus rooms go;
 * nobody's desk or room settings change).
 */
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import { defaultOffice, objectLayer, OfficeDefinitionSchema, OfficeSnapshotSchema, tileLayer } from '../packages/shared/src/office/index.ts';
import type { OfficeDefinition, OfficeMap, OfficeSnapshot } from '../packages/shared/src/office/index.ts';

/** The original 60 x 40 office: the campus map cut back, the Lounge wall closed, ids <= 59. */
export function originalOffice(): OfficeDefinition {
  const def = defaultOffice();
  const m = def.floors[0]!.map;
  const W = m.width;
  const layers = m.layers.map((l) => {
    if (l.type === 'tilelayer') {
      const data: number[] = [];
      for (let y = 0; y < m.height; y += 1) for (let x = 0; x < 60; x += 1) data.push(l.data[y * W + x]!);
      if (l.name === 'walls') for (const y of [33, 34, 35]) data[y * 60 + 59] = 1;
      return { ...l, width: 60, data };
    }
    return { ...l, objects: l.objects.filter((o) => o.id <= 59) };
  });
  return OfficeDefinitionSchema.parse({ ...def, floors: [{ ...def.floors[0]!, map: { ...m, width: 60, layers } as OfficeMap }] });
}

function ask(q: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => { if (s.startsWith(q)) process.stdout.write(q); };
  return new Promise((res) => rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); res(a.trim()); }));
}

const fail = (msg: string): never => { console.error(`STOP: ${msg}`); process.exit(1); };
const rows = (s: OfficeSnapshot) => ({
  rooms: s.rooms.map((r) => JSON.stringify([r.id, r.name, r.type, r.capacity, r.accessMode, r.bounds])).sort(),
  desks: s.desks.map((d) => JSON.stringify([d.id, d.label, d.assignee?.id ?? null])).sort(),
});

async function main(): Promise<void> {
  const [api, mode] = process.argv.slice(2);
  if (!api || !/^https?:\/\/[^/]+$/.test(api)) fail('usage: office-map-upgrade.ts <api base url, e.g. https://api.virtual-hr.site> [--dry-run | --rollback]');
  const dry = mode === '--dry-run';
  const rollback = mode === '--rollback';
  const email = await ask('Admin e-mail: ');
  const password = await ask('Password: ', true);
  const totp = await ask('2FA code (blank if none): ');
  const login = await fetch(`${api}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, ...(totp ? { totpCode: totp } : {}) }) });
  if (login.status !== 200 && login.status !== 201) fail(`sign-in refused (${login.status})`);
  const { accessToken } = (await login.json()) as { accessToken?: string };
  if (!accessToken) fail('no session (2FA required?)');
  const auth = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  const before = OfficeSnapshotSchema.parse(await (await fetch(`${api}/office`, { headers: auth })).json());
  if (!before.canManage) fail('this account may not change the office (org.manage)');
  const stored = OfficeDefinitionSchema.parse({ name: before.office.name, floors: before.floors });
  const original = originalOffice();
  const target = rollback ? original : OfficeDefinitionSchema.parse(defaultOffice());
  const storedIsOriginal = isDeepStrictEqual(stored, original);
  const storedIsCampus = isDeepStrictEqual(stored, OfficeDefinitionSchema.parse(defaultOffice()));
  console.log(`office version ${before.office.version}; ${before.rooms.length} rooms, ${before.desks.length} desks (${before.desks.filter((d) => d.assignee).length} assigned)`);
  console.log(`stored map: ${storedIsOriginal ? 'the unmodified original 60 x 40 map' : storedIsCampus ? 'already the campus map' : 'CUSTOMISED'}`);
  if (rollback ? !storedIsCampus : !storedIsOriginal) fail(rollback ? 'the stored map is not the campus map: nothing to roll back' : 'the stored map is not the unmodified original: not overwriting a customised map');
  const tm = target.floors[0]!.map;
  console.log(`target: ${tm.width} x ${tm.height}, ${objectLayer(tm, 'rooms').length} rooms, ${objectLayer(tm, 'desks').length} desks, ${tileLayer(tm, 'walls')!.length} tiles`);
  if (dry) { console.log('dry run: nothing changed'); return; }
  if ((await ask(`Type ${rollback ? 'ROLLBACK' : 'UPGRADE'} to apply: `)) !== (rollback ? 'ROLLBACK' : 'UPGRADE')) fail('not confirmed');
  const res = await fetch(`${api}/office/map`, { method: 'PUT', headers: auth, body: JSON.stringify(target) });
  if (res.status !== 200) fail(`the API refused the map (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const after = OfficeSnapshotSchema.parse(await res.json());
  const b = rows(before);
  const a = rows(after);
  const lostRooms = b.rooms.filter((r) => !a.rooms.includes(r) && !(rollback && ['Garden', 'Café', 'Arcade'].includes(JSON.parse(r)[1] as string)));
  const lostDesks = b.desks.filter((d) => !a.desks.includes(d));
  console.log(`done: version ${after.office.version}; ${after.rooms.length} rooms, ${after.desks.length} desks`);
  console.log(lostRooms.length || lostDesks.length ? `CHECK: changed rooms ${lostRooms.length}, changed desks ${lostDesks.length}` : 'every room and desk kept its row, settings and assignment');
}

if (process.argv[1]?.endsWith('office-map-upgrade.ts')) void main();
