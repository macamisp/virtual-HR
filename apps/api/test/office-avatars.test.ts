/**
 * Pixel-art office avatars (FR-VO-002, ADR 053), the pure parts shared by the API and the web
 * renderer: the preset allowlist, the generated art, the spritesheet, direction mapping and the
 * walk animation. The renderer and the picker are covered in the browser (e2e 42-office-avatars).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AVATAR_FPS, AVATAR_FRAME_MS, AVATAR_KEYS, AVATAR_PRESETS, AVATAR_SIZE, AvatarDtoSchema, avatarKeyOr, AvatarKeySchema, createAnimation, DEFAULT_AVATAR_KEY,
  dirFromDelta, drawAvatarFrame, FACINGS, facingFromDir, isAvatarKey, OfficeSnapshotSchema, renderAvatarSheet, SHEET_HEIGHT, SHEET_WIDTH, sheetCell, stepAnimation,
} from '../../../packages/shared/src/office/index.ts';
import type { AvatarAnimation, AvatarFrame, Facing } from '../../../packages/shared/src/office/index.ts';
import { decodePng, encodePng, SHEET_PATH } from '../../../scripts/generate-avatar-sheet.ts';

const N = AVATAR_SIZE;
const opaque = (px: Int32Array, x: number, y: number) => px[y * N + x]! !== -1;
const FRAMES: AvatarFrame[] = [0, 1, 2];
/** 60 fps frame time. */
const DT = 1000 / 60;
/** One frame of walking at the office speed (200 px/s). */
const STEP = (200 * DT) / 1000;

describe('Office avatar presets and art (ADR 053)', () => {
  it('six presets, each with a label, description and its own look', () => {
    assert.equal(AVATAR_KEYS.length, 6);
    assert.deepEqual(Object.keys(AVATAR_PRESETS).sort(), [...AVATAR_KEYS].sort());
    for (const k of AVATAR_KEYS) {
      const p = AVATAR_PRESETS[k];
      assert.equal(p.key, k);
      assert.ok(p.label.length > 0 && p.description.length > 0);
    }
    assert.equal(new Set(AVATAR_KEYS.map((k) => AVATAR_PRESETS[k].hair)).size, 6, 'six hair silhouettes');
    assert.equal(new Set(AVATAR_KEYS.map((k) => AVATAR_PRESETS[k].palette.top)).size, 6, 'six clothing colours');
    // Every character looks different from every other in every frame.
    for (const facing of FACINGS) for (const f of FRAMES) {
      const seen = new Set(AVATAR_KEYS.map((k) => drawAvatarFrame(k, facing, f).join(',')));
      assert.equal(seen.size, 6, `${facing} ${f}`);
    }
  });

  it('valid and invalid avatar keys: an allowlist, strictly validated', () => {
    for (const k of AVATAR_KEYS) { assert.ok(isAvatarKey(k)); assert.ok(AvatarKeySchema.safeParse(k).success); }
    for (const bad of ['', 'SAGE', 'dragon', 'sage ', '../sage', 'https://example.com/a.png', 'data:image/png;base64,AAAA', null, 1, {}]) {
      assert.equal(isAvatarKey(bad), false, String(bad));
      assert.equal(AvatarKeySchema.safeParse(bad).success, false, String(bad));
    }
    assert.ok(AvatarDtoSchema.safeParse({ avatarKey: 'river' }).success);
    assert.equal(AvatarDtoSchema.safeParse({ avatarKey: 'river', userId: '00000000-0000-4000-8000-000000000000' }).success, false, 'no target user');
    assert.equal(AvatarDtoSchema.safeParse({}).success, false);
    assert.equal(avatarKeyOr('ember'), 'ember');
    assert.equal(avatarKeyOr('unknown-future-key'), DEFAULT_AVATAR_KEY, 'unknown keys draw the default');
    assert.equal(avatarKeyOr(undefined), DEFAULT_AVATAR_KEY);
    // A snapshot from an API without the field still parses, with the default.
    const snap = OfficeSnapshotSchema.parse({ office: { id: 'o', name: 'O', proximityRadius: 1, version: 1 }, floors: [], rooms: [], desks: [], me: { id: 'u', deskId: null, manualStatus: 'AUTO', statusMessage: '' }, canManage: false });
    assert.equal(snap.me.avatarKey, DEFAULT_AVATAR_KEY);
  });

  it('the database allowlist (CHECK constraint) and default match the shared keys', () => {
    const sql = readFileSync(resolve('apps/api/prisma/migrations/20261113000000_user_vo_avatar_key/migration.sql'), 'utf8');
    const listed = /IN \(([^)]*)\)/.exec(sql)?.[1]?.split(',').map((s) => s.trim().replace(/'/g, ''));
    assert.deepEqual(listed, [...AVATAR_KEYS]);
    assert.match(sql, new RegExp(`DEFAULT '${DEFAULT_AVATAR_KEY}'`));
    assert.match(readFileSync(resolve('apps/api/prisma/schema.prisma'), 'utf8'), new RegExp(`voAvatarKey\\s+String\\s+@default\\("${DEFAULT_AVATAR_KEY}"\\)`));
  });

  it('frames: 32 x 32, transparent background, outlined, feet on the same line in every frame and facing', () => {
    for (const k of AVATAR_KEYS) for (const facing of FACINGS) for (const f of FRAMES) {
      const px = drawAvatarFrame(k, facing, f);
      const at = `${k} ${facing} ${f}`;
      assert.equal(px.length, N * N, at);
      for (const [x, y] of [[0, 0], [N - 1, 0], [0, N - 1], [N - 1, N - 1]] as const) assert.ok(!opaque(px, x, y), `${at}: transparent corner`);
      let bottom = -1;
      let top = N;
      let minX = N;
      let maxX = -1;
      for (let y = 0; y < N; y += 1) for (let x = 0; x < N; x += 1) if (opaque(px, x, y)) { bottom = Math.max(bottom, y); top = Math.min(top, y); minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
      assert.equal(bottom, N - 1, `${at}: the outline under the feet is the last row`);
      assert.ok(top >= 0 && top <= 4, `${at}: head near the top (${top})`);
      assert.ok(minX >= 3 && maxX <= N - 4, `${at}: inside the frame (${minX}..${maxX})`);
      // The outermost pixels of each row are the outline colour (crisp, dark silhouette).
      for (let y = 0; y < N; y += 1) {
        const row = [...px.subarray(y * N, y * N + N)];
        const first = row.findIndex((v) => v !== -1);
        if (first >= 0) assert.equal(row[first], 0x231c26, `${at}: outline at row ${y}`);
      }
    }
  });

  it('left is the mirror of right; the walking frames differ from standing and from each other', () => {
    for (const k of AVATAR_KEYS) for (const f of FRAMES) {
      const r = drawAvatarFrame(k, 'right', f);
      const l = drawAvatarFrame(k, 'left', f);
      for (let y = 0; y < N; y += 1) for (let x = 0; x < N; x += 1) assert.equal(l[y * N + x], r[y * N + (N - 1 - x)]);
    }
    for (const k of AVATAR_KEYS) for (const facing of FACINGS) {
      const [idle, a, b] = FRAMES.map((f) => drawAvatarFrame(k, facing, f).join(','));
      assert.ok(idle !== a && idle !== b && a !== b, `${k} ${facing}`);
    }
  });

  it('the sheet: rows of presets, columns of facing x frame; the committed PNG is what the generator makes', () => {
    assert.equal(SHEET_WIDTH, (12 + 14) * N, 'walk frames, then the 14 action poses (ADR 056)');
    assert.equal(SHEET_HEIGHT, 6 * N);
    assert.deepEqual(sheetCell('sage', 'down', 0), { x: 0, y: 0, width: N, height: N });
    assert.deepEqual(sheetCell('indigo', 'up', 2), { x: 11 * N, y: 5 * N, width: N, height: N });
    assert.deepEqual(sheetCell('river', 'left', 1), { x: 4 * N, y: N, width: N, height: N });
    const sheet = renderAvatarSheet();
    assert.equal(sheet.data.length, SHEET_WIDTH * SHEET_HEIGHT * 4);
    // A cell of the sheet holds exactly its frame.
    const cell = sheetCell('juniper', 'right', 1);
    const px = drawAvatarFrame('juniper', 'right', 1);
    for (let y = 0; y < N; y += 1) for (let x = 0; x < N; x += 1) {
      const alpha = sheet.data[((cell.y + y) * SHEET_WIDTH + cell.x + x) * 4 + 3];
      assert.equal(alpha, opaque(px, x, y) ? 255 : 0);
    }
    // Pixels, not file bytes: compressed bytes differ between zlib builds (local Node vs CI).
    const committed = decodePng(readFileSync(resolve(SHEET_PATH)));
    assert.deepEqual([committed.width, committed.height], [sheet.width, sheet.height]);
    assert.ok(Buffer.from(committed.data).equals(Buffer.from(sheet.data)), `${SHEET_PATH} is stale: run node --experimental-strip-types scripts/generate-avatar-sheet.ts`);
    // And the encoder round-trips.
    assert.ok(Buffer.from(decodePng(encodePng(sheet.width, sheet.height, sheet.data)).data).equals(Buffer.from(sheet.data)));
  });
});

describe('Office avatar direction and animation (ADR 053)', () => {
  it('four-direction frame selection from the eight movement directions', () => {
    // 0 = east, counter-clockwise (the office:move "dir").
    assert.equal(facingFromDir(0, 'down'), 'right');
    assert.equal(facingFromDir(2, 'down'), 'up');
    assert.equal(facingFromDir(4, 'up'), 'left');
    assert.equal(facingFromDir(6, 'up'), 'down');
    // Diagonals keep the last facing when it is part of the diagonal, else face sideways.
    assert.equal(facingFromDir(1, 'up'), 'up');
    assert.equal(facingFromDir(1, 'right'), 'right');
    assert.equal(facingFromDir(1, 'down'), 'right');
    assert.equal(facingFromDir(3, 'left'), 'left');
    assert.equal(facingFromDir(3, 'right'), 'left');
    assert.equal(facingFromDir(5, 'down'), 'down');
    assert.equal(facingFromDir(5, 'up'), 'left');
    assert.equal(facingFromDir(7, 'down'), 'down');
    assert.equal(facingFromDir(7, 'left'), 'right');
    // Out-of-range values are wrapped, never thrown.
    assert.equal(facingFromDir(8, 'down'), 'right');
    assert.equal(facingFromDir(-2, 'up'), 'down');
    // Screen coordinates: y grows downwards.
    assert.equal(dirFromDelta(1, 0), 0);
    assert.equal(dirFromDelta(0, -1), 2);
    assert.equal(dirFromDelta(-1, 0), 4);
    assert.equal(dirFromDelta(0, 1), 6);
    assert.equal(dirFromDelta(1, 1), 7);
  });

  it('idle -> walking -> idle: the first step at once, alternating steps at about 7 fps, standing at once on stop', () => {
    const a = createAnimation();
    assert.deepEqual(a, { facing: 'down', walking: false, frame: 0, elapsedMs: 0 });
    stepAnimation(a, STEP, 0, DT);
    assert.deepEqual([a.walking, a.facing, a.frame], [true, 'right', 1], 'a walking frame on the first moving frame');
    const frames: AvatarFrame[] = [];
    for (let i = 0; i < 60; i += 1) { stepAnimation(a, STEP, 0, DT); frames.push(a.frame); }
    const changes = frames.filter((f, i) => i > 0 && f !== frames[i - 1]).length;
    assert.ok(Math.abs(changes - AVATAR_FPS) <= 1, `~${AVATAR_FPS} frame changes in a second (${changes})`);
    assert.ok(frames.every((f) => f === 1 || f === 2), 'only the walking frames while walking');
    assert.ok(Math.abs(AVATAR_FRAME_MS - 1000 / 7) < 0.01);
    stepAnimation(a, 0, 0, DT);
    assert.deepEqual([a.walking, a.frame, a.facing], [false, 0, 'right'], 'standing at once, still facing the way it walked');
  });

  it('direction changes switch the facing; a diagonal keeps the last cardinal facing', () => {
    const a = createAnimation();
    const go = (dx: number, dy: number, n = 3) => { for (let i = 0; i < n; i += 1) stepAnimation(a, dx * STEP, dy * STEP, DT); return a.facing; };
    assert.equal(go(0, -1), 'up');
    assert.equal(go(Math.SQRT1_2, -Math.SQRT1_2), 'up', 'up-right after up still faces up');
    assert.equal(go(1, 0), 'right');
    assert.equal(go(Math.SQRT1_2, Math.SQRT1_2), 'right');
    assert.equal(go(0, 1), 'down');
    assert.equal(go(-1, 0), 'left');
    assert.ok(a.walking);
  });

  it('blocked movement stays idle: no actual movement, no walking frame, no turn', () => {
    const a = createAnimation('up');
    for (let i = 0; i < 30; i += 1) stepAnimation(a, 0, 0, DT);
    assert.deepEqual(a, { facing: 'up', walking: false, frame: 0, elapsedMs: 0 });
    // Sub-pixel jitter from interpolation is not walking either.
    stepAnimation(a, 0.05, -0.05, DT);
    assert.equal(a.walking, false);
  });

  it('a remote avatar easing to a stop walks while it visibly moves and stands once it arrives', () => {
    // The renderer eases rendered positions towards each 10 Hz server position (k = dt / 100).
    const a = createAnimation();
    let rx = 0;
    let target = 0;
    const trace: Array<{ walking: boolean; moved: number }> = [];
    for (let t = 0; t < 1500; t += DT) {
      if (t < 600 && Math.floor(t / 100) !== Math.floor((t - DT) / 100)) target += 20; // 200 px/s in 10 Hz packets
      const before = rx;
      rx += (target - rx) * Math.min(1, DT / 100);
      stepAnimation(a, rx - before, 0, DT);
      trace.push({ walking: a.walking, moved: rx - before });
    }
    assert.ok(trace.slice(5, 30).every((s) => s.walking), 'walking during the stream');
    assert.equal(a.walking, false, 'standing at the end');
    const firstIdle = trace.findIndex((s, i) => i > 30 && !s.walking);
    assert.ok(trace.slice(firstIdle).every((s) => !s.walking), 'no flicker back to walking after stopping');
    assert.ok(trace[firstIdle]!.moved < 0.25, 'stops once it barely moves');
  });

  it('a jump (teleport, server correction) is not a step', () => {
    const a: AvatarAnimation = createAnimation('left');
    stepAnimation(a, 400, 0, DT);
    assert.deepEqual([a.walking, a.frame, a.facing], [false, 0, 'left' as Facing]);
    stepAnimation(a, -20, 0, DT);
    assert.equal(a.walking, false, 'a 20 px snap-back within one frame');
    stepAnimation(a, STEP, 0, 0);
    assert.equal(a.walking, false, 'no time, no step');
  });
});
