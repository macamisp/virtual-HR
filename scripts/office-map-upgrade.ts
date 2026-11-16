/**
 * Upgrades ONE organisation's stored office map to the campus map (ADR 055) through the existing,
 * audited admin route PUT /office/map. It never touches the database directly. Run it yourself,
 * in your own terminal: it asks for the e-mail and password of an account that may manage the
 * workspace (the password is not echoed), for the 2FA code when the server asks for one, and for
 * the workspace when the address belongs to several. It prints no password and no token.
 *
 *   node --experimental-strip-types scripts/office-map-upgrade.ts https://api.virtual-hr.site --dry-run
 *   node --experimental-strip-types scripts/office-map-upgrade.ts https://api.virtual-hr.site --apply
 *   node --experimental-strip-types scripts/office-map-upgrade.ts https://api.virtual-hr.site --rollback
 *
 * Options: --workspace <slug> (sign in to that workspace), --org <organisation id or its first 8+
 * characters> (stop unless the session is in that organisation), --backup-dir <dir>.
 *
 * Map versions:
 * - original: the 60 x 40 office;
 * - campus v1 (ADR 055): the Garden, Café and Arcade;
 * - campus v2 (ADR 063): campus v1 plus the pool and the pond in the garden, as new objects only.
 *
 * Each stored map is identified by two independent checks: a recorded fingerprint, and equality to
 * the map derived from code. A customised map (neither) is never overwritten. Every step keeps each
 * room and desk under its object id, so desk assignments and invitations stay.
 *
 * - --dry-run changes nothing: no request other than sign-in, reads and sign-out; no file.
 * - --apply moves the original or campus v1 to the current campus map (v2). It first saves the
 *   current map, rooms, desks and invitations to a backup file and asks for a typed confirmation;
 *   after sending the map, it reads the office again and checks every room and desk kept its row,
 *   settings, invitations and assignment.
 * - --rollback goes back one version, with the same backup and checks: v2 to v1 (the pool and pond
 *   go), v1 to the original (the campus areas go).
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import { CAMPUS_V1_LAST_ID, defaultOffice, objectLayer, OfficeDefinitionSchema, OfficeSnapshotSchema } from '../packages/shared/src/office/index.ts';
import type { OfficeDefinition, OfficeMap, OfficeSnapshot } from '../packages/shared/src/office/index.ts';

/**
 * SHA-256 of the original office (`defaultOffice()` as it is on `main`, before ADR 055), in the
 * canonical form `fingerprint` produces. Recorded from that code, not derived from the campus map,
 * so a mistake in `originalOffice` below cannot make a customised map look original.
 */
export const LEGACY_MAP_FINGERPRINT = '6462df4159d9b7c553e9e78082c91cefe5eb36a25c595c8b9f63bd873f781920';
/**
 * SHA-256 of the campus v1 map (ADR 055: `defaultOffice()` before ADR 063 added the pool and the
 * pond), recorded from that code, like the original's, so it is checked independently of
 * `campusV1Office` below.
 */
export const CAMPUS_V1_FINGERPRINT = '179be98643c509b705aa13ff037f10bcc2866ac6bbbf96a121ed81202dbfb58a';
const CAMPUS_ROOMS = ['Garden', 'Café', 'Arcade'];
const ORG_MANAGE = 'org.manage';

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

/** Campus v1: today's map without the objects campus v2 added (only objects were added, no tiles). */
export function campusV1Office(): OfficeDefinition {
  const def = defaultOffice();
  const m = def.floors[0]!.map;
  const layers = m.layers.map((l) => (l.type === 'tilelayer' ? l : { ...l, objects: l.objects.filter((o) => o.id <= CAMPUS_V1_LAST_ID) }));
  return OfficeDefinitionSchema.parse({ ...def, floors: [{ ...def.floors[0]!, map: { ...m, layers } as OfficeMap }] });
}

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortKeys)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]))
      : v;

/** Order-independent SHA-256 of a map (the database returns JSON keys in its own order). */
export function fingerprint(def: unknown): string {
  return createHash('sha256').update(JSON.stringify(sortKeys(OfficeDefinitionSchema.parse(def)))).digest('hex');
}

/** `campus1` = campus v1 (ADR 055); `campus` = the current campus map (v2, ADR 063: pool and pond). */
export type StoredMap = 'original' | 'campus1' | 'campus' | 'customised' | 'uncertain';
/** Which map is stored. `uncertain` = the two independent checks for the original, or for campus v1, disagree. */
export function identifyStoredMap(stored: OfficeDefinition): StoredMap {
  const fp = fingerprint(stored);
  const original = [fp === LEGACY_MAP_FINGERPRINT, isDeepStrictEqual(stored, originalOffice())];
  const campus1 = [fp === CAMPUS_V1_FINGERPRINT, isDeepStrictEqual(stored, campusV1Office())];
  if (original[0] !== original[1] || campus1[0] !== campus1[1]) return 'uncertain';
  if (original[0]) return 'original';
  if (campus1[0]) return 'campus1';
  return fp === fingerprint(defaultOffice()) ? 'campus' : 'customised';
}

/**
 * One step: --apply upgrades the original or campus v1 to the current campus map; --rollback goes
 * back one version (campus v2 to campus v1, campus v1 to the original). Null when not eligible.
 */
export function stepTarget(kind: StoredMap, rollback: boolean): { target: OfficeDefinition; to: 'original' | 'campus1' | 'campus' } | null {
  if (!rollback) return kind === 'original' || kind === 'campus1' ? { target: OfficeDefinitionSchema.parse(defaultOffice()), to: 'campus' } : null;
  if (kind === 'campus') return { target: campusV1Office(), to: 'campus1' };
  if (kind === 'campus1') return { target: originalOffice(), to: 'original' };
  return null;
}

/**
 * Rooms and desks are matched to their database rows by map object id (office-store syncLayout).
 * Returns every room or desk of `from` that `to` does not carry with the same id, name and place.
 */
export function objectsNotCarried(from: OfficeDefinition, to: OfficeDefinition): string[] {
  const out: string[] = [];
  for (const f of from.floors) {
    const tf = to.floors.find((x) => x.id === f.id);
    for (const layer of ['rooms', 'desks']) {
      const there = tf ? objectLayer(tf.map, layer) : [];
      for (const o of objectLayer(f.map, layer)) {
        if (!there.some((t) => isDeepStrictEqual(t, o))) out.push(`${layer} object ${o.id} "${o.name}" on floor ${f.id}`);
      }
    }
  }
  return out;
}

export interface Check { label: string; ok: boolean }
type Invites = Record<string, string[]>;
const roomRow = (r: OfficeSnapshot['rooms'][number]) => JSON.stringify([r.id, r.floorId, r.name, r.type, r.capacity, r.accessMode, r.bounds]);
const deskRow = (d: OfficeSnapshot['desks'][number]) => JSON.stringify([d.id, d.floorId, d.label, d.bounds]);
const assigned = (s: OfficeSnapshot) => s.desks.filter((d) => d.assignee).map((d) => `${d.id}=${d.assignee!.id}`).sort();
const storedDefinition = (s: OfficeSnapshot): OfficeDefinition => OfficeDefinitionSchema.parse({ name: s.office.name, floors: s.floors });

/** What must be true after the change. `rollback` = back to the original (the campus rooms go). */
export function verifyChange(before: OfficeSnapshot, after: OfficeSnapshot, invitesBefore: Invites, invitesAfter: Invites, target: OfficeDefinition, rollback: boolean): Check[] {
  const tm = target.floors[0]!.map;
  const am = storedDefinition(after).floors[0]!.map;
  const kept = before.rooms.filter((r) => !(rollback && CAMPUS_ROOMS.includes(r.name)));
  const afterRooms = new Set(after.rooms.map(roomRow));
  const afterDesks = new Set(after.desks.map(deskRow));
  const names = after.rooms.map((r) => r.name);
  const sameInvites = kept.every((r) => isDeepStrictEqual([...(invitesBefore[r.id] ?? [])].sort(), [...(invitesAfter[r.id] ?? [])].sort()));
  return [
    { label: `map dimensions ${tm.width} x ${tm.height}`, ok: am.width === tm.width && am.height === tm.height },
    { label: 'stored map is exactly the intended map', ok: fingerprint(storedDefinition(after)) === fingerprint(target) },
    { label: `the ${kept.length} existing rooms kept their row, name, type, capacity, access mode and place`, ok: kept.every((r) => afterRooms.has(roomRow(r))) },
    ...CAMPUS_ROOMS.map((n) => ({ label: rollback ? `${n} removed` : `${n} present`, ok: names.filter((x) => x === n).length === (rollback ? 0 : 1) })),
    { label: `room count ${objectLayer(tm, 'rooms').length}`, ok: after.rooms.length === objectLayer(tm, 'rooms').length },
    { label: `the ${before.desks.length} desks kept their row, label and place`, ok: after.desks.length === before.desks.length && before.desks.every((d) => afterDesks.has(deskRow(d))) },
    { label: `the ${assigned(before).length} desk assignments are unchanged`, ok: isDeepStrictEqual(assigned(before), assigned(after)) },
    { label: 'room invitations are unchanged', ok: sameInvites },
    { label: `office version ${before.office.version} -> ${before.office.version + 1}`, ok: after.office.version === before.office.version + 1 },
  ];
}

/** Everything the run needs from its surroundings, so a test can drive it without a terminal. */
export interface Io {
  ask(question: string): Promise<string>;
  /** Not echoed and not trimmed. */
  askHidden(question: string): Promise<string>;
  log(line: string): void;
  now?(): Date;
}

class Stop extends Error {}
const stop = (msg: string): never => { throw new Stop(msg); };

interface Session { token: string; user: { id: string; orgId: string; email: string; displayName: string | null; role: string }; workspace: { slug: string; name: string } | null }

async function serverMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => null) as { message?: unknown } | null;
  const m = body && typeof body.message === 'string' ? body.message : Array.isArray(body?.message) ? body.message.join('; ') : '';
  return m.slice(0, 200);
}

async function signIn(api: string, io: Io, workspaceArg: string | undefined): Promise<Session> {
  const email = (await io.ask('E-mail of an account that may manage the workspace: ')).trim();
  const password = await io.askHidden('Password: ');
  const body: { email: string; password: string; workspace?: string; totpCode?: string } = { email, password, ...(workspaceArg ? { workspace: workspaceArg } : {}) };
  let workspace: Session['workspace'] = null;
  for (let step = 0; step < 4; step += 1) {
    const res = await fetch(`${api}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.status !== 200) {
      const why = await serverMessage(res);
      const hint = res.status === 401
        ? ' The server answers 401 for: a wrong password; an address with no account (or none in the workspace named); an account that has no password because it was created with Google (set one with "Forgot your password?" on the sign-in page; Google sign-in and 2FA stay as they are); a locked account (5 failed attempts, 15 minutes); an inactive account; a wrong or already used 2FA code.'
        : res.status === 429 ? ' Too many attempts: wait a minute.' : '';
      stop(`sign-in refused (${res.status})${why ? `: ${why}` : ''}.${hint}`);
    }
    const r = await res.json() as { accessToken?: string; user?: Session['user']; chooseWorkspace?: boolean; workspaces?: Array<{ slug: string; name: string }>; requires2fa?: boolean; requires2faSetup?: boolean };
    if (r.accessToken && r.user) return { token: r.accessToken, user: r.user, workspace };
    if (r.chooseWorkspace && r.workspaces?.length && !body.workspace) {
      io.log('This address belongs to several workspaces:');
      r.workspaces.forEach((w, i) => io.log(`  ${i + 1}. ${w.name} (${w.slug})`));
      const n = Number((await io.ask(`Which one (1-${r.workspaces.length})? `)).trim());
      const chosen = Number.isInteger(n) ? r.workspaces[n - 1] : undefined;
      if (!chosen) stop('no workspace chosen');
      workspace = chosen!;
      body.workspace = chosen!.slug;
    } else if (r.requires2fa && !body.totpCode) {
      const code = (await io.ask('2FA code from your authenticator app: ')).trim();
      if (!/^(\d{6}|[0-9a-f]{10})$/.test(code)) stop('that is not a 6-digit code (or a recovery code)');
      body.totpCode = code;
    } else if (r.requires2faSetup) {
      stop('this account must set up two-factor authentication first: sign in once in the web app and finish the 2FA setup, then run this again');
    } else {
      stop('the server did not start a session');
    }
  }
  return stop('sign-in did not finish');
}

/** Runs the whole thing; returns the process exit code (0 = fine, 1 = stopped). */
export async function run(argv: string[], io: Io): Promise<number> {
  let token = '';
  let api = '';
  try {
    const [apiArg, ...rest] = argv;
    const flags = new Map<string, string>();
    for (let i = 0; i < rest.length; i += 1) {
      const a = rest[i]!;
      if (['--dry-run', '--apply', '--rollback'].includes(a)) flags.set('mode', flags.has('mode') ? 'twice' : a);
      else if (['--workspace', '--org', '--backup-dir'].includes(a) && rest[i + 1]) { flags.set(a, rest[i + 1]!); i += 1; } else flags.set('bad', a);
    }
    const mode = flags.get('mode');
    if (!apiArg || !/^https?:\/\/[^/]+$/.test(apiArg) || !mode || mode === 'twice' || flags.has('bad')) {
      stop('usage: office-map-upgrade.ts <api base url, e.g. https://api.virtual-hr.site> (--dry-run | --apply | --rollback) [--workspace <slug>] [--org <organisation id>] [--backup-dir <dir>]');
    }
    api = apiArg!;
    const dry = mode === '--dry-run';
    const rollback = mode === '--rollback';
    const orgArg = flags.get('--org')?.toLowerCase();
    if (orgArg !== undefined && !/^[0-9a-f-]{8,36}$/.test(orgArg)) stop('--org takes an organisation id or at least its first 8 characters');

    const session = await signIn(api, io, flags.get('--workspace')?.toLowerCase());
    token = session.token;
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const get = async (path: string): Promise<unknown> => {
      const res = await fetch(`${api}${path}`, { headers: auth });
      if (res.status !== 200) stop(`GET ${path} answered ${res.status}`);
      return await res.json();
    };
    const readOffice = async () => OfficeSnapshotSchema.parse(await get('/office'));
    const readInvites = async (s: OfficeSnapshot): Promise<Invites> => {
      const out: Invites = {};
      for (const r of s.rooms) out[r.id] = ((await get(`/office/rooms/${r.id}/invites`)) as { userIds: string[] }).userIds;
      return out;
    };

    const { user } = session;
    const access = await get('/me/access') as { permissions?: string[]; isOwner?: boolean };
    const workspaceLabel = session.workspace ? `${session.workspace.name} (${session.workspace.slug})` : flags.has('--workspace') ? `workspace "${flags.get('--workspace')}"` : 'name not shown by the API for an address with one workspace';
    io.log('');
    io.log(`Signed in as:      ${user.displayName ?? '(no name)'} <${user.email}>, role ${user.role}${access.isOwner ? ', workspace owner' : ''}`);
    io.log(`Organisation:      ${user.orgId}  ${workspaceLabel}`);
    if (orgArg !== undefined && !user.orgId.toLowerCase().startsWith(orgArg)) stop(`this session is in organisation ${user.orgId}, not ${orgArg}: wrong workspace`);
    const granted = access.permissions?.includes(ORG_MANAGE) === true;
    io.log(`Permission:        ${ORG_MANAGE} ${granted ? 'granted' : 'NOT granted'}`);
    const denied = (): never => stop(`this account may not change the office (${ORG_MANAGE}). Sign in as the workspace owner or an administrator of this workspace.`);
    if (!granted) denied();
    const before = await readOffice();
    if (!before.canManage) denied();

    const stored = storedDefinition(before);
    const sm = stored.floors[0]!.map;
    const kind = identifyStoredMap(stored);
    const step = stepTarget(kind, rollback);
    const target = step?.target ?? (rollback ? originalOffice() : OfficeDefinitionSchema.parse(defaultOffice()));
    const tm = target.floors[0]!.map;
    const fp = fingerprint(stored);
    const count = (def: OfficeDefinition, layer: string) => def.floors.reduce((n, f) => n + objectLayer(f.map, layer).length, 0);
    io.log(`Office:            "${before.office.name}", version ${before.office.version}, ${stored.floors.length} floor(s)`);
    io.log(`Current map:       ${sm.width} x ${sm.height}; ${before.rooms.length} rooms, ${before.desks.length} desks (${assigned(before).length} assigned); map objects: ${count(stored, 'rooms')} rooms, ${count(stored, 'desks')} desks`);
    io.log(`Current rooms:     ${before.rooms.map((r) => `${r.name} [${r.accessMode}]`).join(', ')}`);
    io.log(`Proposed map:      ${tm.width} x ${tm.height}; ${count(target, 'rooms')} rooms, ${count(target, 'desks')} desks`);
    io.log(`Proposed rooms:    ${objectLayer(tm, 'rooms').map((o) => o.name).join(', ')}`);
    io.log(`Fingerprint:       ${fp}`);
    io.log(`Original map is:   ${LEGACY_MAP_FINGERPRINT}  ->  ${fp === LEGACY_MAP_FINGERPRINT ? 'MATCH' : 'no match'}`);
    io.log(`Stored map is:     ${{ original: 'the unmodified original 60 x 40 map', campus1: 'the campus v1 map (no pool or pond yet)', campus: 'already the current campus map (v2)', customised: 'CUSTOMISED (neither the original nor the campus map)', uncertain: 'NOT IDENTIFIED (the fingerprint and the derived original disagree)' }[kind]}`);
    const stamp = (io.now?.() ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const backupFile = join(resolve(flags.get('--backup-dir') ?? 'office-map-backups'), `office-map-${user.orgId}-v${before.office.version}-${stamp}.json`);
    io.log(`Backup file:       ${backupFile}${dry ? '  (written by --apply / --rollback, not by a dry run)' : ''}`);

    if (!rollback && kind === 'campus') stop('already upgraded: the stored map is the current campus map, nothing to do');
    if (kind === 'uncertain') stop('the stored map cannot be identified with confidence: not changing it');
    if (!step) stop(rollback ? 'the stored map is not a campus map this script made: nothing to roll back' : 'the stored map is neither the unmodified original nor campus v1: not overwriting a customised map');
    const toOriginal = step!.to === 'original';
    const lost = objectsNotCarried(rollback ? target : stored, rollback ? stored : target);
    if (lost.length) stop(`the two maps do not share these objects, so their rows would be replaced: ${lost.join('; ')}`);
    if (before.rooms.length !== count(stored, 'rooms') || before.desks.length !== count(stored, 'desks')) stop('the rooms and desks in the database do not match the stored map: not changing it');
    const invitesBefore = await readInvites(before);
    io.log(`Eligibility:       ELIGIBLE (${rollback ? `${kind === 'campus' ? 'campus v2 back to campus v1 (the pool and pond go)' : 'campus v1 back to the original'}` : `${kind === 'original' ? 'unmodified original' : 'campus v1'} to the current campus map; every room and desk keeps its object id`})`);
    if (dry) { io.log('Dry run: nothing was changed.'); return 0; }

    const word = `${rollback ? 'ROLLBACK' : 'UPGRADE'} ${user.orgId.slice(0, 8)}`;
    if ((await io.ask(`Type "${word}" to change the office map of organisation ${user.orgId}: `)).trim() !== word) stop('not confirmed: nothing was changed');
    const again = await readOffice();
    if (again.office.version !== before.office.version || fingerprint(storedDefinition(again)) !== fp) stop('the office changed while this was running: nothing was changed, run it again');
    await mkdir(resolve(backupFile, '..'), { recursive: true, mode: 0o700 });
    await writeFile(backupFile, `${JSON.stringify({ takenAt: (io.now?.() ?? new Date()).toISOString(), api, organisationId: user.orgId, takenBy: user.id, fingerprint: fp, office: before.office, definition: { name: before.office.name, floors: before.floors }, rooms: before.rooms, desks: before.desks, invites: invitesBefore }, null, 1)}\n`, { mode: 0o600, flag: 'wx' });
    io.log(`Backup written:    ${backupFile}`);

    const res = await fetch(`${api}/office/map`, { method: 'PUT', headers: auth, body: JSON.stringify(target) });
    if (res.status !== 200) stop(`the API refused the map (${res.status}): ${await serverMessage(res)}. Nothing was changed.`);
    const after = await readOffice();
    const checks = verifyChange(before, after, invitesBefore, await readInvites(after), target, toOriginal);
    io.log('');
    io.log(`Done: office version ${after.office.version}; ${after.rooms.length} rooms, ${after.desks.length} desks. Checked by reading the office again:`);
    for (const c of checks) io.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.label}`);
    io.log('  note room passwords are never sent by the API, so they cannot be compared; PUT /office/map does not write them (a room still in PASSWORD mode is covered by the access-mode check)');
    if (checks.some((c) => !c.ok)) stop(`the result is not what was intended. The previous state is in ${backupFile}; ${rollback ? 'run --apply to put the campus map back' : 'run --rollback to go back one version'}.`);
    io.log(rollback ? `Rolled back to ${step!.to === 'original' ? 'the original map' : 'campus v1'}.` : 'Upgraded. Now reload the office page in the web app (Ctrl+Shift+R): the campus (Garden, Café, Arcade) is to the right of the Lounge, with the pool and the pond in the garden.');
    return 0;
  } catch (e) {
    // Anything unexpected (network failure, an answer of the wrong shape) stops the run the same way.
    io.log(`STOP: ${e instanceof Stop ? e.message : `unexpected ${e instanceof Error ? `${e.name}: ${e.message.slice(0, 300)}` : 'error'}${api ? ` talking to ${api}` : ''}`}`);
    return 1;
  } finally {
    // End the session this run opened; the token is useless afterwards.
    if (token) await fetch(`${api}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
  }
}

/** Prompts on the terminal with ONE reader for the whole run (a reader per question loses piped input). */
function terminalIo(): Io & { close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  let muted = false;
  const out = rl as unknown as { _writeToOutput: (s: string) => void };
  const write = out._writeToOutput.bind(rl);
  out._writeToOutput = (s: string) => { if (!muted || s.includes('\n')) write(muted ? '\n' : s); };
  const lines: string[] = [];
  const waiting: Array<(l: string) => void> = [];
  rl.on('line', (l) => { const w = waiting.shift(); if (w) w(l); else lines.push(l); });
  rl.on('close', () => { for (const w of waiting.splice(0)) w(''); });
  const ask = (q: string, hidden: boolean): Promise<string> => {
    process.stdout.write(q);
    muted = hidden;
    return new Promise((res) => {
      const done = (l: string) => { muted = false; res(l); };
      const l = lines.shift();
      if (l !== undefined) done(l); else waiting.push(done);
    });
  };
  return { ask: (q) => ask(q, false), askHidden: (q) => ask(q, true), log: (l) => console.log(l), close: () => rl.close() };
}

if (process.argv[1]?.endsWith('office-map-upgrade.ts')) {
  const io = terminalIo();
  void run(process.argv.slice(2), io).then((code) => { process.exitCode = code; }).finally(() => io.close());
}
