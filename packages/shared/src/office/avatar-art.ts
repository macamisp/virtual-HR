/**
 * Source of the office character art (ADR 053): six original 32 x 32 pixel characters, drawn
 * from simple pixel shapes in code. This file is the editable source; the spritesheet PNG in
 * docs/assets/office-avatars/avatars.png is generated from it (scripts/generate-avatar-sheet.ts) and
 * the renderer builds its textures from the same function, so the two can never differ.
 *
 * Construction, per frame: legs and shoes, torso and outfit, arms, head and face, hair, glasses,
 * then a one-pixel dark outline around the whole silhouette. Left-facing frames are mirrored
 * right-facing ones. The feet always end on row 30 (outline on row 31), so the characters stand
 * on the same line in every frame and direction.
 *
 * To change a character, edit its entry in AVATAR_PRESETS (colours, hair style, outfit) or a
 * drawing function below, then run `node --experimental-strip-types scripts/generate-avatar-sheet.ts`.
 */
import { AVATAR_FRAMES, AVATAR_KEYS, AVATAR_POSES, AVATAR_SIZE, FACINGS, poseCell, SHEET_HEIGHT, SHEET_WIDTH, sheetCell } from './avatars.ts';
import type { AvatarFrame, AvatarKey, AvatarPose, Facing } from './avatars.ts';

export type HairStyle = 'crop' | 'bob' | 'bun' | 'curls' | 'spiky' | 'ponytail';
export type Outfit = 'collar' | 'tie' | 'stripe' | 'hoodie' | 'vest' | 'zip';

/** 0xRRGGBB colours. */
export interface AvatarPalette {
  skin: number;
  skinShade: number;
  hair: number;
  hairShade: number;
  hairLight: number;
  top: number;
  topShade: number;
  accent: number;
  bottom: number;
  bottomShade: number;
  shoes: number;
}

export interface AvatarPreset {
  key: AvatarKey;
  label: string;
  /** Short description for the picker (also its accessible description). */
  description: string;
  hair: HairStyle;
  outfit: Outfit;
  glasses: boolean;
  palette: AvatarPalette;
}

const OUTLINE = 0x231c26;
const EYE = 0x231c26;

export const AVATAR_PRESETS: Record<AvatarKey, AvatarPreset> = {
  sage: {
    key: 'sage', label: 'Sage', description: 'Short dark hair, green cardigan with a white collar',
    hair: 'crop', outfit: 'collar', glasses: false,
    palette: { skin: 0xe0ac7e, skinShade: 0xc08a5e, hair: 0x3b2a20, hairShade: 0x271b14, hairLight: 0x5c4232, top: 0x5b8c5a, topShade: 0x456c44, accent: 0xf3f0e6, bottom: 0x3d4a5c, bottomShade: 0x2d3746, shoes: 0x2b2b2b },
  },
  river: {
    key: 'river', label: 'River', description: 'Blonde bob, blue shirt and red tie',
    hair: 'bob', outfit: 'tie', glasses: false,
    palette: { skin: 0xf2d0b1, skinShade: 0xd6aa86, hair: 0xd9a441, hairShade: 0xa9792a, hairLight: 0xf2cd74, top: 0x3f6fb5, topShade: 0x30568f, accent: 0xc0392b, bottom: 0x34343f, bottomShade: 0x25252e, shoes: 0x4a2f22 },
  },
  ember: {
    key: 'ember', label: 'Ember', description: 'Big curly hair, orange striped jumper and white trainers',
    hair: 'curls', outfit: 'stripe', glasses: false,
    palette: { skin: 0x9a6440, skinShade: 0x7a4c2f, hair: 0x1f1b22, hairShade: 0x121015, hairLight: 0x3a3440, top: 0xd9653b, topShade: 0xb04d2a, accent: 0xf6d365, bottom: 0x6b5a45, bottomShade: 0x524434, shoes: 0xece6da },
  },
  juniper: {
    key: 'juniper', label: 'Juniper', description: 'Auburn ponytail, purple hoodie',
    hair: 'ponytail', outfit: 'hoodie', glasses: false,
    palette: { skin: 0xf5c9a6, skinShade: 0xd9a682, hair: 0x9a3f2f, hairShade: 0x6e2b20, hairLight: 0xc05a43, top: 0x7b5ea7, topShade: 0x5f4886, accent: 0xe4dbf1, bottom: 0x2c3e50, bottomShade: 0x1f2d3a, shoes: 0x8a8f98 },
  },
  sol: {
    key: 'sol', label: 'Sol', description: 'Hair in a top bun, mustard shirt under a teal vest',
    hair: 'bun', outfit: 'vest', glasses: false,
    palette: { skin: 0xc68955, skinShade: 0xa36b3e, hair: 0x4f3328, hairShade: 0x36221a, hairLight: 0x70493a, top: 0xe9c46a, topShade: 0xc9a44c, accent: 0x2a9d8f, bottom: 0x264653, bottomShade: 0x1a323b, shoes: 0x3b2a20 },
  },
  indigo: {
    key: 'indigo', label: 'Indigo', description: 'Spiky hair, glasses, navy zip jacket and red trainers',
    hair: 'spiky', outfit: 'zip', glasses: true,
    palette: { skin: 0x6f4a32, skinShade: 0x573823, hair: 0x2b2b33, hairShade: 0x1a1a20, hairLight: 0x4a4a5c, top: 0x2e3f73, topShade: 0x222f57, accent: 0xa9bce0, bottom: 0x1f2430, bottomShade: 0x151922, shoes: 0xb33a3a },
  },
};

// ---------------------------------------------------------------- pixel canvas

const N = AVATAR_SIZE;
const EMPTY = -1;

class Pixels {
  readonly c: Int32Array;
  private readonly dy: number;
  constructor(c: Int32Array = new Int32Array(N * N).fill(EMPTY), dy = 0) {
    this.c = c;
    this.dy = dy;
  }
  /** The same canvas with everything drawn `dy` rows lower (the walking bob of the upper body). */
  shifted(dy: number): Pixels {
    return new Pixels(this.c, dy);
  }
  set(x: number, y: number, colour: number): void {
    const yy = y + this.dy;
    if (x >= 0 && x < N && yy >= 0 && yy < N) this.c[yy * N + x] = colour;
  }
  get(x: number, y: number): number {
    const yy = y + this.dy;
    return x >= 0 && x < N && yy >= 0 && yy < N ? this.c[yy * N + x]! : EMPTY;
  }
  /** Inclusive rectangle. */
  rect(x0: number, y0: number, x1: number, y1: number, colour: number): void {
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) this.set(x, y, colour);
  }
  /** One filled span per row: rows[i] = [x0, x1] for row y0 + i. */
  rows(y0: number, spans: ReadonlyArray<readonly [number, number] | null>, colour: number): void {
    spans.forEach((s, i) => { if (s) this.rect(s[0], y0 + i, s[1], y0 + i, colour); });
  }
}

/** A dark one-pixel outline on every empty pixel next to the figure (4-neighbourhood). */
function outline(p: Pixels): void {
  const filled = Uint8Array.from(p.c, (v) => (v === EMPTY ? 0 : 1));
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      if (filled[y * N + x]) continue;
      const near = (x > 0 && filled[y * N + x - 1]) || (x < N - 1 && filled[y * N + x + 1]) || (y > 0 && filled[(y - 1) * N + x]) || (y < N - 1 && filled[(y + 1) * N + x]);
      if (near) p.c[y * N + x] = OUTLINE;
    }
  }
}

// ---------------------------------------------------------------- body parts
// Front and back views are symmetric about x = 15.5; the side view faces right.

type View = 'front' | 'back' | 'side';

/** Legs and shoes. `step` 0 = standing, 1 / 2 = the two walking steps. Feet end on row 30. */
function legs(p: Pixels, pal: AvatarPalette, view: View, step: AvatarFrame): void {
  p.rect(11, 24, 20, 25, pal.bottom); // hips
  p.rect(18, 24, 20, 25, pal.bottomShade);
  if (view === 'side') {
    if (step === 0) {
      p.rect(13, 26, 17, 28, pal.bottom);
      p.rect(13, 26, 13, 28, pal.bottomShade);
      p.rect(13, 29, 19, 30, pal.shoes);
      return;
    }
    // Stride: the near leg forward on step 1, back on step 2; the far leg is the shaded one.
    const front = step === 1 ? pal.bottom : pal.bottomShade;
    const back = step === 1 ? pal.bottomShade : pal.bottom;
    p.rect(11, 26, 13, 28, back);
    p.rect(10, 29, 13, 30, pal.shoes);
    p.rect(17, 26, 19, 28, front);
    p.rect(17, 29, 21, 30, pal.shoes);
    return;
  }
  // Front / back: one foot lifted a pixel on each step.
  const liftL = step === 1 ? 1 : 0;
  const liftR = step === 2 ? 1 : 0;
  p.rect(12, 26, 14, 28 - liftL, pal.bottom);
  p.rect(11, 29 - liftL, 14, 30 - liftL, pal.shoes);
  p.rect(17, 26, 19, 28 - liftR, pal.bottom);
  p.rect(19, 26, 19, 28 - liftR, pal.bottomShade);
  p.rect(17, 29 - liftR, 20, 30 - liftR, pal.shoes);
}

function torso(p: Pixels, pre: AvatarPreset, view: View): void {
  const pal = pre.palette;
  p.rect(14, 16, 17, 16, pal.skinShade); // neck
  if (view === 'side') {
    p.rect(12, 17, 19, 23, pal.top);
    p.rect(12, 17, 12, 23, pal.topShade);
    p.rect(12, 23, 19, 23, pal.topShade);
    switch (pre.outfit) {
      case 'collar': p.rect(17, 17, 19, 17, pal.accent); p.set(19, 18, pal.accent); break;
      case 'tie': p.set(19, 17, pal.accent); p.rect(19, 18, 19, 21, pal.accent); break;
      case 'stripe': p.rect(12, 20, 19, 21, pal.accent); break;
      case 'hoodie': p.rect(11, 16, 13, 18, pal.topShade); p.set(19, 18, pal.accent); p.set(19, 19, pal.accent); break;
      case 'vest': p.rect(12, 17, 17, 23, pal.accent); p.rect(12, 17, 12, 23, pal.bottomShade); break;
      case 'zip': p.rect(17, 17, 19, 17, pal.accent); p.rect(19, 18, 19, 23, pal.accent); break;
    }
    return;
  }
  p.rect(11, 17, 20, 23, pal.top);
  p.rect(20, 17, 20, 23, pal.topShade);
  p.rect(11, 23, 20, 23, pal.topShade);
  if (view === 'back') {
    if (pre.outfit === 'hoodie') { p.rect(12, 16, 19, 18, pal.topShade); p.rect(13, 16, 18, 16, pal.top); }
    else if (pre.outfit === 'vest') { p.rect(11, 17, 20, 22, pal.accent); p.rect(20, 17, 20, 22, pal.bottomShade); }
    else if (pre.outfit === 'stripe') p.rect(11, 20, 20, 21, pal.accent);
    else if (pre.outfit === 'collar' || pre.outfit === 'zip') p.rect(13, 17, 18, 17, pal.accent);
    return;
  }
  switch (pre.outfit) {
    case 'collar':
      p.rect(13, 17, 14, 17, pal.accent); p.rect(17, 17, 18, 17, pal.accent);
      p.set(14, 18, pal.accent); p.set(17, 18, pal.accent);
      p.rect(15, 17, 16, 17, pal.skinShade);
      p.rect(15, 19, 15, 22, pal.topShade); // cardigan opening
      break;
    case 'tie':
      p.set(14, 17, pal.topShade); p.set(17, 17, pal.topShade);
      p.rect(15, 17, 16, 17, pal.accent);
      p.rect(15, 18, 16, 21, pal.accent);
      p.set(16, 21, OUTLINE);
      break;
    case 'stripe':
      p.rect(11, 20, 20, 21, pal.accent);
      p.rect(14, 17, 17, 17, pal.topShade);
      break;
    case 'hoodie':
      p.rect(12, 16, 13, 17, pal.topShade); p.rect(18, 16, 19, 17, pal.topShade);
      p.rect(14, 18, 14, 20, pal.accent); p.rect(17, 18, 17, 20, pal.accent);
      p.rect(13, 22, 18, 22, pal.topShade); // pocket
      break;
    case 'vest':
      p.rect(11, 17, 13, 23, pal.accent); p.rect(18, 17, 20, 23, pal.accent);
      p.rect(20, 17, 20, 23, pal.bottomShade);
      p.set(16, 19, pal.topShade); p.set(16, 21, pal.topShade);
      break;
    case 'zip':
      p.rect(13, 17, 18, 17, pal.accent);
      p.rect(16, 18, 16, 23, pal.accent);
      break;
  }
}

/** Arms; the walking steps swing them opposite to the legs. */
function arms(p: Pixels, pal: AvatarPalette, view: View, step: AvatarFrame): void {
  if (view === 'side') {
    const dx = step === 1 ? -2 : step === 2 ? 2 : 0;
    const x = 15 + dx;
    p.rect(x - 1, 18, x - 1, 21, OUTLINE); // separates the arm from the body
    p.rect(x, 17, x + 1, 21, pal.top);
    p.rect(x + 1, 17, x + 1, 21, pal.topShade);
    p.rect(x, 22, x + 1, 23, pal.skin);
    return;
  }
  // Front / back: the arm on the side of the lifted foot swings back (shorter), the other forward.
  const l = step === 2 ? -1 : step === 1 ? 1 : 0;
  const r = -l;
  p.rect(8, 17, 9, 21 + l, pal.top);
  p.rect(8, 22 + l, 9, 23 + l, pal.skin);
  p.rect(22, 17, 23, 21 + r, pal.topShade);
  p.rect(22, 22 + r, 23, 23 + r, pal.skinShade);
}

function head(p: Pixels, pal: AvatarPalette, view: View): void {
  if (view === 'side') {
    p.rows(4, [[12, 19], [11, 20], [10, 21], [10, 21], [10, 21], [10, 21], [10, 21], [10, 22], [10, 21], [10, 21], [11, 20], [12, 19]], pal.skin);
    p.rect(10, 6, 10, 13, pal.skinShade);
    p.rect(12, 15, 19, 15, pal.skinShade);
    p.rect(14, 10, 14, 11, pal.skinShade); // ear
    p.rect(19, 10, 19, 11, EYE);
    p.set(20, 13, pal.skinShade); // mouth
    return;
  }
  p.rows(4, [[11, 20], [10, 21], [9, 22], [9, 22], [9, 22], [9, 22], [9, 22], [9, 22], [9, 22], [9, 22], [10, 21], [11, 20]], pal.skin);
  p.rect(22, 6, 22, 13, pal.skinShade);
  p.rect(11, 15, 20, 15, pal.skinShade);
  p.rect(8, 10, 8, 11, pal.skin); // ears
  p.rect(23, 10, 23, 11, pal.skinShade);
  if (view === 'back') return;
  p.rect(12, 10, 12, 11, EYE);
  p.rect(19, 10, 19, 11, EYE);
  p.set(11, 12, pal.skinShade); // cheeks
  p.set(20, 12, pal.skinShade);
  p.rect(15, 13, 16, 13, pal.skinShade); // mouth
}

function hair(p: Pixels, pre: AvatarPreset, view: View): void {
  const { hair: h, hairShade: s, hairLight: l } = pre.palette;
  const side = view === 'side';
  const back = view === 'back';
  // The cap every style starts from: rounded top of the head, rows 3..6.
  const cap = () => {
    if (side) p.rows(3, [[12, 19], [11, 20], [10, 21], [10, 21]], h);
    else p.rows(3, [[11, 20], [10, 21], [9, 22], [9, 22]], h);
    p.rect(side ? 13 : 12, 4, side ? 15 : 14, 4, l); // shine
  };
  switch (pre.hair) {
    case 'crop':
      cap();
      if (back) { p.rows(7, [[9, 22], [9, 22], [9, 22], [9, 22], [9, 22], [10, 21]], h); p.rect(10, 12, 21, 12, s); }
      else if (side) { p.rect(10, 7, 13, 11, h); p.rect(10, 11, 13, 11, s); p.rect(15, 7, 19, 7, h); p.rect(16, 7, 19, 7, s); }
      else { p.rect(9, 7, 12, 7, h); p.rect(17, 7, 22, 7, h); p.rect(9, 8, 9, 9, s); p.rect(22, 8, 22, 9, s); p.rect(18, 7, 22, 7, s); }
      break;
    case 'bob':
      cap();
      if (back) { p.rows(7, [[8, 23], [8, 23], [8, 23], [8, 23], [8, 23], [8, 23], [8, 23], [9, 22]], h); p.rect(9, 13, 22, 14, s); }
      else if (side) { p.rect(9, 6, 14, 14, h); p.rect(9, 12, 14, 14, s); p.rect(15, 7, 20, 8, h); p.rect(18, 8, 20, 8, s); }
      else {
        p.rect(10, 7, 21, 7, h); p.rect(10, 8, 12, 8, h); p.rect(19, 8, 21, 8, h); p.rect(13, 8, 13, 8, s);
        p.rect(8, 6, 10, 14, h); p.rect(21, 6, 23, 14, h); p.rect(8, 12, 10, 14, s); p.rect(21, 9, 23, 14, s);
      }
      break;
    case 'bun':
      cap();
      if (side) { p.rows(0, [[12, 13], [11, 14], [11, 14], [12, 13]], h); p.set(12, 1, l); p.rect(10, 7, 13, 12, h); p.rect(10, 11, 13, 12, s); p.rect(15, 7, 19, 7, h); }
      else {
        p.rows(0, [[15, 16], [14, 17], [14, 17], [15, 16]], h); p.set(15, 1, l);
        if (back) { p.rows(7, [[9, 22], [9, 22], [9, 22], [9, 22], [9, 22], [10, 21]], h); p.rect(10, 12, 21, 12, s); p.rect(15, 3, 16, 3, s); }
        else { p.rect(9, 7, 11, 8, h); p.rect(20, 7, 22, 8, h); p.rect(20, 8, 22, 8, s); }
      }
      break;
    case 'curls': {
      // Rounded volume with a curl texture.
      const spans: Array<[number, number]> = side
        ? [[12, 18], [10, 20], [9, 21], [8, 22], [8, 22], [8, 22], [8, 22], [8, 21]]
        : [[11, 20], [9, 22], [8, 23], [7, 24], [7, 24], [7, 24], [7, 24], [7, 24]];
      p.rows(1, spans, h);
      if (back) p.rows(9, [[7, 24], [7, 24], [7, 24], [8, 23], [9, 22]], h);
      else if (side) p.rows(9, [[8, 13], [8, 13], [8, 13], [9, 13], [10, 12]], h);
      else { p.rows(9, [[7, 9], [7, 9], [7, 9], [8, 9]], h); p.rows(9, [[22, 24], [22, 24], [22, 24], [22, 23]], h); }
      for (let y = 1; y <= 13; y += 1) for (let x = 7; x <= 24; x += 1) {
        if (p.get(x, y) === h && (x * 3 + y * 5) % 7 === 0) p.set(x, y, (x + y) % 2 ? l : s);
      }
      if (!back) { // fringe line above the eyes
        if (side) p.rect(14, 8, 21, 8, s);
        else p.rect(10, 8, 21, 8, s);
      }
      break;
    }
    case 'spiky': {
      // Column tops of the spikes.
      if (side) {
        const tops = [4, 3, 2, 2, 1, 2, 2, 3, 3, 4, 5, 5];
        tops.forEach((t, i) => p.rect(10 + i, t, 10 + i, 6, h));
        p.rect(10, 7, 13, 11, h); p.rect(10, 10, 13, 11, s);
        p.set(16, 7, h); p.set(18, 7, h); p.set(20, 7, h);
      } else {
        const tops = [5, 3, 2, 3, 4, 2, 1, 1, 2, 4, 3, 2, 3, 5];
        tops.forEach((t, i) => p.rect(9 + i, t, 9 + i, 6, h));
        if (back) { p.rows(7, [[9, 22], [9, 22], [9, 22], [9, 22], [9, 22], [10, 21]], h); p.rect(10, 12, 21, 12, s); }
        else { for (const x of [9, 10, 12, 13, 15, 16, 18, 19, 21, 22]) p.set(x, 7, h); p.rect(9, 8, 9, 8, s); p.rect(22, 8, 22, 8, s); }
      }
      p.set(side ? 14 : 15, 2, l); p.set(side ? 13 : 16, 3, l);
      break;
    }
    case 'ponytail':
      cap();
      if (back) {
        p.rows(7, [[9, 22], [9, 22], [9, 22], [9, 22], [10, 21]], h); p.rect(10, 11, 21, 11, s);
        p.rect(14, 11, 17, 12, OUTLINE); // hair tie
        p.rows(13, [[14, 17], [14, 17], [14, 17], [15, 17], [15, 16], [15, 16]], h);
        p.rect(17, 13, 17, 16, s);
      } else if (side) {
        p.rect(10, 7, 13, 10, h); p.rect(15, 7, 19, 7, h); p.rect(17, 7, 19, 7, s);
        p.set(9, 8, OUTLINE); // hair tie
        p.rows(8, [null, [7, 9], [7, 9], [7, 9], [7, 9], [8, 9], [8, 9], [8, 8]], h);
        p.rect(7, 12, 7, 12, s);
      } else {
        p.rect(9, 7, 13, 7, h); p.rect(18, 7, 22, 7, h); p.rect(9, 8, 10, 9, h); p.rect(21, 8, 22, 9, s); p.rect(19, 7, 22, 7, s);
      }
      break;
  }
}

function glasses(p: Pixels, view: View): void {
  if (view === 'back') return;
  const frame = 0x111015;
  if (view === 'side') {
    p.rect(18, 9, 20, 9, frame); p.rect(18, 12, 20, 12, frame); p.rect(20, 10, 20, 11, frame);
    p.rect(15, 10, 17, 10, frame); // arm to the ear
    return;
  }
  for (const x0 of [11, 18]) {
    p.rect(x0, 9, x0 + 2, 9, frame); p.rect(x0, 12, x0 + 2, 12, frame);
    p.rect(x0, 10, x0, 11, frame); p.rect(x0 + 2, 10, x0 + 2, 11, frame);
  }
  p.rect(14, 10, 17, 10, frame);
}

// ---------------------------------------------------------------- action poses (ADR 056)

/** A sleeve and a hand: `sleeve` rects in the top colour (shade on its outer column), then the hand. */
function limb(p: Pixels, pal: AvatarPalette, sleeve: Array<[number, number, number, number]>, hand: [number, number, number, number], shade = false): void {
  for (const [x0, y0, x1, y1] of sleeve) p.rect(x0, y0, x1, y1, shade ? pal.topShade : pal.top);
  p.rect(hand[0], hand[1], hand[2], hand[3], shade ? pal.skinShade : pal.skin);
}

/** Sitting: the upper body three pixels lower, thighs forward, feet on the floor. */
function sittingLegs(p: Pixels, pal: AvatarPalette, view: View): void {
  if (view === 'side') {
    p.rect(12, 25, 21, 27, pal.bottom); p.rect(12, 27, 21, 27, pal.bottomShade); // thigh
    p.rect(19, 28, 21, 29, pal.bottom); p.rect(19, 29, 21, 29, pal.bottomShade); // shin
    p.rect(19, 30, 23, 30, pal.shoes);
    return;
  }
  p.rect(11, 25, 20, 27, pal.bottom); p.rect(18, 25, 20, 27, pal.bottomShade); p.rect(15, 26, 16, 27, pal.bottomShade);
  if (view === 'front') { p.rect(11, 28, 14, 29, pal.shoes); p.rect(17, 28, 20, 29, pal.shoes); }
  else { p.rect(12, 28, 14, 29, pal.bottomShade); p.rect(17, 28, 19, 29, pal.bottomShade); }
}

/** One pose of one character, drawn facing right for the side poses (left ones are mirrored). */
function drawPose(key: AvatarKey, pose: AvatarPose): Int32Array {
  const pre = AVATAR_PRESETS[key];
  const pal = pre.palette;
  const mirrorOf: Partial<Record<AvatarPose, AvatarPose>> = { 'sit-left': 'sit-right', 'hug-left': 'hug-right', 'highfive-left': 'highfive-right' };
  const twin = mirrorOf[pose];
  if (twin) {
    const right = drawPose(key, twin);
    const out = new Int32Array(N * N);
    for (let y = 0; y < N; y += 1) for (let x = 0; x < N; x += 1) out[y * N + x] = right[y * N + (N - 1 - x)]!;
    return out;
  }
  const view: View = pose === 'sit-up' ? 'back' : pose === 'sit-right' || pose === 'hug-right' || pose === 'highfive-right' ? 'side' : 'front';
  const base = new Pixels();
  const sitting = pose.startsWith('sit-');
  const crouch = pose === 'jump-crouch';
  if (sitting) sittingLegs(base, pal, view);
  else legs(base, pal, view, pose === 'dance-a' ? 1 : pose === 'dance-b' ? 2 : 0);
  const upper = sitting ? base.shifted(3) : crouch ? base.shifted(2) : base;
  torso(upper, pre, view);
  // Arms that hang as usual are drawn before the head; raised ones after the hair, in front.
  const raised = ['wave-a', 'wave-b', 'dance-a', 'dance-b', 'jump-air', 'highfive-right'].includes(pose);
  if (!raised && pose !== 'hug-right') arms(upper, pal, view, 0);
  head(upper, pal, view);
  hair(upper, pre, view);
  if (pre.glasses) glasses(upper, view);
  // The viewer's right is the character's left hand in the front view; it does the waving.
  const leftDown = () => limb(upper, pal, [[8, 17, 9, 21]], [8, 22, 9, 23]);
  const rightUp = (out: number) => limb(upper, pal, [[22 + out, 12, 23 + out, 17]], [22 + out, 9, 23 + out, 11], true);
  switch (pose) {
    case 'wave-a': leftDown(); rightUp(1); break;
    case 'wave-b': leftDown(); limb(upper, pal, [[23, 15, 24, 17], [24, 12, 25, 15]], [25, 9, 26, 11], true); break;
    case 'dance-a': // a disco point: one arm up and out, the other low and out
      limb(upper, pal, [[6, 19, 8, 20], [8, 17, 9, 19]], [4, 20, 5, 21]);
      limb(upper, pal, [[23, 13, 25, 17], [22, 16, 23, 18]], [25, 10, 26, 12], true);
      break;
    case 'dance-b': limb(upper, pal, [[5, 17, 9, 18]], [3, 17, 4, 18]); limb(upper, pal, [[22, 17, 26, 18]], [27, 17, 28, 18], true); break;
    case 'jump-air': limb(upper, pal, [[6, 13, 8, 17], [8, 16, 9, 18]], [5, 10, 6, 12]); limb(upper, pal, [[23, 13, 25, 17], [22, 16, 23, 18]], [25, 10, 26, 12], true); break;
    case 'hug-right':
      upper.rect(13, 18, 13, 20, OUTLINE);
      limb(upper, pal, [[14, 18, 21, 19]], [22, 18, 23, 20]);
      limb(upper, pal, [[15, 20, 20, 21]], [21, 20, 22, 22], true);
      break;
    case 'highfive-right': // forward past the nose, then up: the palm held high in front
      upper.rect(15, 18, 15, 19, OUTLINE);
      limb(upper, pal, [[16, 17, 22, 18], [23, 11, 24, 18]], [23, 7, 25, 10]);
      upper.rect(25, 6, 25, 7, pal.skinShade); upper.rect(23, 6, 23, 6, pal.skinShade); // fingers
      break;
    default: break;
  }
  outline(base);
  return base.c;
}

/** ADR 056: one action pose (sit, wave, dance, jump, hug, high five) as colour values, like a frame. */
export function drawAvatarPose(key: AvatarKey, pose: AvatarPose): Int32Array {
  return drawPose(key, pose);
}

// ---------------------------------------------------------------- frames and the sheet

/** One frame as colour values (-1 = transparent), 32 x 32, row-major. */
export function drawAvatarFrame(key: AvatarKey, facing: Facing, frame: AvatarFrame): Int32Array {
  const pre = AVATAR_PRESETS[key];
  if (facing === 'left') {
    const right = drawAvatarFrame(key, 'right', frame);
    const out = new Int32Array(N * N);
    for (let y = 0; y < N; y += 1) for (let x = 0; x < N; x += 1) out[y * N + x] = right[y * N + (N - 1 - x)]!;
    return out;
  }
  const view: View = facing === 'down' ? 'front' : facing === 'up' ? 'back' : 'side';
  const base = new Pixels();
  legs(base, pre.palette, view, frame);
  // The side view bobs a pixel lower in mid-stride.
  const upper = view === 'side' && frame !== 0 ? base.shifted(1) : base;
  torso(upper, pre, view);
  arms(upper, pre.palette, view, frame);
  head(upper, pre.palette, view);
  hair(upper, pre, view);
  if (pre.glasses) glasses(upper, view);
  outline(base);
  return base.c;
}

/** The whole sheet as RGBA bytes (SHEET_WIDTH x SHEET_HEIGHT), the layout of sheetCell(). */
export function renderAvatarSheet(): { width: number; height: number; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(SHEET_WIDTH * SHEET_HEIGHT * 4);
  for (const key of AVATAR_KEYS) {
    for (const facing of FACINGS) {
      for (let f = 0; f < AVATAR_FRAMES.length; f += 1) {
        const frame = f as AvatarFrame;
        const px = drawAvatarFrame(key, facing, frame);
        const cell = sheetCell(key, facing, frame);
        for (let y = 0; y < N; y += 1) {
          for (let x = 0; x < N; x += 1) {
            const v = px[y * N + x]!;
            if (v === EMPTY) continue;
            const i = ((cell.y + y) * SHEET_WIDTH + cell.x + x) * 4;
            data[i] = (v >> 16) & 0xff;
            data[i + 1] = (v >> 8) & 0xff;
            data[i + 2] = v & 0xff;
            data[i + 3] = 0xff;
          }
        }
      }
    }
    for (const pose of AVATAR_POSES) {
      const px = drawPose(key, pose);
      const cell = poseCell(key, pose);
      for (let y = 0; y < N; y += 1) {
        for (let x = 0; x < N; x += 1) {
          const v = px[y * N + x]!;
          if (v === EMPTY) continue;
          const i = ((cell.y + y) * SHEET_WIDTH + cell.x + x) * 4;
          data[i] = (v >> 16) & 0xff;
          data[i + 1] = (v >> 8) & 0xff;
          data[i + 2] = v & 0xff;
          data[i + 3] = 0xff;
        }
      }
    }
  }
  return { width: SHEET_WIDTH, height: SHEET_HEIGHT, data };
}
