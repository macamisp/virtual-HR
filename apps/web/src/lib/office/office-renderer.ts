'use client';

/**
 * PixiJS renderer for the office (FR-VO-001, 002, 003; ADR 015, 053). Everything is drawn in code;
 * there is no image asset. The static map is drawn once and cached as a texture. Avatars are
 * pixel-art characters cut from one spritesheet texture shared by everyone (built once per
 * renderer from the shared pixel source); each avatar is a reused container whose status ring is
 * redrawn only when the status changes, and whose walk animation runs here, in the render loop,
 * inferred from how far the avatar actually moved (no React state, no extra network message).
 */
// The CSP has no 'unsafe-eval' in production builds; this PixiJS module swaps its generated
// shader/uniform code for eval-free versions (otherwise the canvas never starts: "0 fps").
import 'pixi.js/unsafe-eval';
import { Application, BitmapText, CanvasSource, Container, Graphics, Rectangle, Sprite, Texture } from 'pixi.js';
import { AVATAR_FRAMES, AVATAR_KEYS, avatarKeyOr, createAnimation, FACINGS, objectLayer, prop, sheetCell, stepAnimation, TILE_SIZE, tileLayer } from '@hrvo/shared';
import type { AvatarAnimation, AvatarFrame, AvatarKey, Facing, OfficeMap, VoStatus } from '@hrvo/shared';
import { createAvatarSheetCanvas } from './avatar-sheet';
import type { OfficeClient, RemoteAvatar } from './office-client';

export const STATUS_COLOUR: Record<VoStatus, number> = {
  ACTIVE: 0x16a34a, IDLE: 0xeab308, IN_MEETING: 0x7c3aed, ON_BREAK: 0x0ea5e9, AWAY: 0x9ca3af, DND: 0xdc2626, OFFLINE: 0x6b7280,
};
const FLOOR_COLOUR: Record<number, number> = { 1: 0xe8ecf2, 2: 0xe9dcc6, 3: 0xdde7f5, 4: 0xe7e1f3, 5: 0xdcefe3 };
const WALL = 0x475569;
const FURNITURE: Record<string, number> = { table: 0xa8a29e, sofa: 0x93c5fd, counter: 0x86efac, plant: 0x4ade80 };

/** Where the character stands in its container: feet on the ground ring, centred on the avatar point. */
const FEET_Y = 13;
const RING_Y = 11;
const RING_RX = 14;
const RING_RY = 5;

/**
 * Every frame of every character as a sub-texture of one sheet texture (nearest-neighbour, so the
 * pixels stay crisp when zoomed). Created once per renderer and shared by all avatars.
 */
class AvatarTextures {
  private readonly source = new CanvasSource({ resource: createAvatarSheetCanvas(), scaleMode: 'nearest' });
  private readonly frames = new Map<string, Texture>();

  constructor() {
    for (const key of AVATAR_KEYS) for (const facing of FACINGS) for (let f = 0; f < AVATAR_FRAMES.length; f += 1) {
      const c = sheetCell(key, facing, f as AvatarFrame);
      this.frames.set(`${key}/${facing}/${f}`, new Texture({ source: this.source, frame: new Rectangle(c.x, c.y, c.width, c.height) }));
    }
  }

  get(key: AvatarKey, facing: Facing, frame: AvatarFrame): Texture {
    return this.frames.get(`${key}/${facing}/${frame}`)!;
  }

  destroy(): void {
    for (const t of this.frames.values()) t.destroy(false);
    this.frames.clear();
    this.source.destroy();
  }
}

interface AvatarView {
  root: Container;
  ring: Graphics;
  body: Sprite;
  self: boolean;
  status: VoStatus | null;
  /** ADR 048: drawn faded with a dashed ring and an "away" badge. */
  away: boolean | null;
  badge: BitmapText;
  name: BitmapText;
  /** ADR 053: the character shown, its walk state, and the texture currently on the body. */
  key: AvatarKey;
  anim: AvatarAnimation;
  shown: string;
}

/** What one avatar looks like right now (for the browser tests; no personal data beyond the id). */
export interface AvatarDebug { id: string; self: boolean; key: AvatarKey; facing: Facing; frame: AvatarFrame; walking: boolean; status: VoStatus | null; away: boolean }

export class OfficeRenderer {
  app = new Application();
  private world = new Container();
  private mapLayer = new Container();
  private linkLayer = new Graphics();
  private avatarLayer = new Container();
  private sprites = new Map<string, AvatarView>();
  private textures: AvatarTextures | null = null;
  /** The own avatar's previous position, to see whether it actually moved this frame. */
  private lastSelf: { x: number; y: number; floorId: string } | null = null;
  private benchTimer: ReturnType<typeof setInterval> | null = null;
  private floorId: string | null = null;
  private zoom = 1;
  private destroyed = false;
  fps = 0;
  frameMs = 0;
  /** FR-VO-008: a right-click on another person's avatar; the page opens that person's menu. */
  onAvatarMenu: ((userId: string) => void) | null = null;

  constructor(private readonly client: OfficeClient, private readonly host: HTMLElement) {}

  async init(): Promise<void> {
    await this.app.init({ resizeTo: this.host, background: 0xf8fafc, antialias: true, autoDensity: true, resolution: Math.min(window.devicePixelRatio || 1, 2) });
    if (this.destroyed) { this.app.destroy(true); return; }
    this.textures = new AvatarTextures();
    this.app.canvas.setAttribute('aria-hidden', 'true');
    this.host.appendChild(this.app.canvas);
    this.world.addChild(this.mapLayer, this.linkLayer, this.avatarLayer);
    this.avatarLayer.sortableChildren = true;
    this.app.stage.addChild(this.world);
    this.app.stage.eventMode = 'static';
    this.app.stage.hitArea = this.app.screen;
    this.app.stage.on('pointerdown', (e) => {
      const p = this.world.toLocal(e.global);
      this.client.walkTo({ x: p.x, y: p.y });
    });
    this.host.addEventListener('wheel', this.onWheel, { passive: false });
    this.host.addEventListener('contextmenu', this.onContext);
    this.app.ticker.add((t) => this.frame(t.deltaMS));
  }

  destroy(): void {
    this.destroyed = true;
    if (this.benchTimer) clearInterval(this.benchTimer);
    this.benchTimer = null;
    this.host.removeEventListener('wheel', this.onWheel);
    this.host.removeEventListener('contextmenu', this.onContext);
    try { this.app.destroy(true, { children: true }); } catch { /* not initialised yet */ }
    // Sprites are gone with the stage; the shared sheet texture is released here, once.
    this.sprites.clear();
    this.textures?.destroy();
    this.textures = null;
    this.lastSelf = null;
  }

  /** ADR 053: the state of every avatar on the map (browser tests). */
  avatarStates(): AvatarDebug[] {
    return [...this.sprites].map(([id, s]) => ({ id, self: s.self, key: s.key, facing: s.anim.facing, frame: s.anim.frame, walking: s.anim.walking, status: s.status, away: !!s.away }));
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.zoom = Math.max(0.4, Math.min(2, this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
  };

  private onContext = (e: MouseEvent) => {
    const box = this.host.getBoundingClientRect();
    const id = this.avatarAt(e.clientX - box.left, e.clientY - box.top);
    if (!id) return;
    e.preventDefault();
    this.onAvatarMenu?.(id);
  };

  /** The other people's avatars in host CSS pixels (autoDensity), for the accessible overlay over the canvas. */
  avatarsOnScreen(): Array<{ id: string; x: number; y: number }> {
    const meId = this.client.snapshot.me.id;
    const out: Array<{ id: string; x: number; y: number }> = [];
    for (const [id, s] of this.sprites) {
      if (id === meId || id.startsWith('bench-') || s.root.destroyed) continue;
      const p = s.root.getGlobalPosition();
      out.push({ id, x: p.x, y: p.y });
    }
    return out;
  }

  private avatarAt(x: number, y: number): string | null {
    let best: { id: string; d: number } | null = null;
    for (const a of this.avatarsOnScreen()) {
      const d = Math.hypot(a.x - x, a.y - y);
      if (d <= 24 * Math.max(1, this.zoom) && (!best || d < best.d)) best = { id: a.id, d };
    }
    return best?.id ?? null;
  }

  zoomBy(f: number): void {
    this.zoom = Math.max(0.4, Math.min(2, this.zoom * f));
  }

  private drawMap(map: OfficeMap): void {
    for (const c of this.mapLayer.removeChildren()) c.destroy({ children: true });
    const g = new Graphics();
    const floor = tileLayer(map, 'floor') ?? [];
    const walls = tileLayer(map, 'walls') ?? [];
    const T = TILE_SIZE;
    // Runs of equal tiles per row keep the shape count low.
    for (let y = 0; y < map.height; y += 1) {
      let x = 0;
      while (x < map.width) {
        const v = floor[y * map.width + x] ?? 0;
        let end = x + 1;
        while (end < map.width && (floor[y * map.width + end] ?? 0) === v) end += 1;
        if (v !== 0) g.rect(x * T, y * T, (end - x) * T, T).fill(FLOOR_COLOUR[v] ?? 0xe5e7eb);
        x = end;
      }
    }
    // Subtle tile grid on the floor.
    for (let x = 0; x <= map.width; x += 1) g.moveTo(x * T, 0).lineTo(x * T, map.height * T);
    for (let y = 0; y <= map.height; y += 1) g.moveTo(0, y * T).lineTo(map.width * T, y * T);
    g.stroke({ width: 1, color: 0x000000, alpha: 0.04 });
    for (let y = 0; y < map.height; y += 1) {
      let x = 0;
      while (x < map.width) {
        if ((walls[y * map.width + x] ?? 0) === 0) { x += 1; continue; }
        let end = x + 1;
        while (end < map.width && (walls[y * map.width + end] ?? 0) !== 0) end += 1;
        g.rect(x * T, y * T, (end - x) * T, T).fill(WALL);
        x = end;
      }
    }
    for (const d of objectLayer(map, 'desks')) {
      g.roundRect(d.x + 4, d.y + T + 6, d.width - 8, T - 12, 6).fill({ color: 0x64748b, alpha: 0.25 }); // seat
    }
    for (const f of objectLayer(map, 'furniture')) {
      const kind = String(prop(f, 'kind', 'table'));
      if (kind === 'plant') g.circle(f.x + f.width / 2, f.y + f.height / 2, f.width / 2 - 4).fill(FURNITURE.plant!);
      else g.roundRect(f.x + 2, f.y + 2, f.width - 4, f.height - 4, 6).fill(FURNITURE[kind] ?? 0xa8a29e).stroke({ width: 1, color: 0x000000, alpha: 0.15 });
    }
    this.mapLayer.addChild(g);
    for (const r of objectLayer(map, 'rooms')) {
      const label = new BitmapText({ text: r.name, style: { fontFamily: 'Arial', fontSize: 14, fill: 0x334155 } });
      label.position.set(r.x + 10, r.y + 6);
      label.alpha = 0.85;
      this.mapLayer.addChild(label);
    }
    for (const d of objectLayer(map, 'desks')) {
      const label = new BitmapText({ text: d.name, style: { fontFamily: 'Arial', fontSize: 10, fill: 0x1f2937 } });
      label.position.set(d.x + 6, d.y + 8);
      this.mapLayer.addChild(label);
    }
    this.mapLayer.cacheAsTexture(true);
  }

  private sprite(id: string, name: string, self: boolean, key: AvatarKey): AvatarView {
    let s = this.sprites.get(id);
    if (s) return s;
    const root = new Container();
    // Ground shadow and status ring under the feet, then the character, its name and the away badge.
    const ring = new Graphics();
    const body = new Sprite(this.textures!.get(key, 'down', 0));
    body.anchor.set(0.5, 1);
    body.position.set(0, FEET_Y);
    body.roundPixels = true;
    const label = new BitmapText({ text: name, style: { fontFamily: 'Arial', fontSize: 11, fill: 0x0f172a } });
    label.anchor.set(0.5, 0);
    label.position.set(0, 18);
    const badge = new BitmapText({ text: 'away', style: { fontFamily: 'Arial', fontSize: 9, fill: 0x64748b } });
    badge.anchor.set(0.5, 1);
    badge.position.set(0, -20);
    badge.visible = false;
    root.addChild(ring, body, label, badge);
    s = { root, ring, body, self, status: null, away: null, name: label, badge, key, anim: createAnimation('down'), shown: `${key}/down/0` };
    this.sprites.set(id, s);
    this.avatarLayer.addChild(root);
    return s;
  }

  private setStatus(s: AvatarView, status: VoStatus, away = false): void {
    if (s.status === status && s.away === away) return;
    s.status = status;
    s.away = away;
    const g = s.ring;
    g.clear();
    g.ellipse(0, RING_Y, 10, 3.5).fill({ color: 0x000000, alpha: 0.18 });
    if (away) {
      // Dashed ring: twelve dashes round the ellipse.
      for (let i = 0; i < 12; i += 1) {
        const a0 = (i * Math.PI) / 6;
        g.moveTo(Math.cos(a0) * RING_RX, RING_Y + Math.sin(a0) * RING_RY);
        for (let k = 1; k <= 4; k += 1) {
          const a = a0 + (k * Math.PI) / 48;
          g.lineTo(Math.cos(a) * RING_RX, RING_Y + Math.sin(a) * RING_RY);
        }
      }
      g.stroke({ width: 3, color: STATUS_COLOUR[status] });
    } else g.ellipse(0, RING_Y, RING_RX, RING_RY).stroke({ width: 3, color: STATUS_COLOUR[status] });
    // The own avatar keeps its dark marker, now a thin ring inside the status ring.
    if (s.self) g.ellipse(0, RING_Y, RING_RX - 3, RING_RY - 1.5).stroke({ width: 1.5, color: 0x0f172a, alpha: 0.85 });
    s.root.alpha = away ? 0.55 : 1;
    s.badge.visible = away;
  }

  /** ADR 053: one animation step from how far the avatar moved, and the matching frame of its character. */
  private animate(s: AvatarView, key: AvatarKey, dx: number, dy: number, dtMs: number): void {
    stepAnimation(s.anim, dx, dy, dtMs);
    const shown = `${key}/${s.anim.facing}/${s.anim.frame}`;
    if (shown === s.shown) return;
    s.key = key;
    s.shown = shown;
    s.body.texture = this.textures!.get(key, s.anim.facing, s.anim.frame);
  }

  private frame(dtMs: number): void {
    const t0 = performance.now();
    const c = this.client;
    c.step(dtMs);
    const self = c.self;
    if (!self) return;
    if (this.floorId !== self.floorId) {
      const f = c.snapshot.floors.find((x) => x.id === self.floorId);
      if (f) this.drawMap(f.map as OfficeMap);
      this.floorId = self.floorId;
    }
    // Others: ease towards the latest server position (positions arrive at 10 Hz).
    const k = Math.min(1, dtMs / 100);
    const seen = new Set<string>();
    const meId = c.snapshot.me.id;
    for (const a of c.avatars.values()) {
      const px = a.rx;
      const py = a.ry;
      a.rx += (a.x - a.rx) * k;
      a.ry += (a.y - a.ry) * k;
      const entry = c.roster.get(a.id);
      const name = entry?.name ?? '…';
      const key = avatarKeyOr(entry?.avatar);
      const s = this.sprite(a.id, name, false, key);
      if (s.name.text !== name) s.name.text = name;
      this.setStatus(s, a.status, a.away);
      // Remote movement is inferred from the eased position the user actually sees.
      this.animate(s, key, a.rx - px, a.ry - py, dtMs);
      s.root.position.set(a.rx, a.ry);
      s.root.zIndex = a.ry;
      seen.add(a.id);
    }
    const meEntry = c.roster.get(meId);
    // The saved character (the server's roster); an unsaved choice in the picker never shows here.
    const myKey = avatarKeyOr(meEntry?.avatar ?? c.snapshot.me.avatarKey);
    const mine = this.sprite(meId, meEntry?.name ?? 'You', true, myKey);
    this.setStatus(mine, meEntry?.status ?? 'ACTIVE');
    const last = this.lastSelf;
    const moved = last && last.floorId === self.floorId ? { dx: self.x - last.x, dy: self.y - last.y } : { dx: 0, dy: 0 };
    this.animate(mine, myKey, moved.dx, moved.dy, dtMs);
    this.lastSelf = { x: self.x, y: self.y, floorId: self.floorId };
    mine.root.position.set(self.x, self.y);
    mine.root.zIndex = self.y + 0.5;
    seen.add(meId);
    for (const [id, s] of this.sprites) if (!seen.has(id)) { s.root.destroy({ children: true }); this.sprites.delete(id); }
    // FR-VO-005: links to the people in the same proximity group.
    this.linkLayer.clear();
    for (const m of c.proximity.members) {
      if (m === meId) continue;
      const a = c.avatars.get(m);
      if (a) this.linkLayer.moveTo(self.x, self.y).lineTo(a.rx, a.ry);
    }
    if (c.proximity.members.length) this.linkLayer.stroke({ width: 2, color: 0x7c3aed, alpha: 0.35 });
    // Camera follows the user.
    this.world.scale.set(this.zoom);
    this.world.position.set(this.app.screen.width / 2 - self.x * this.zoom, this.app.screen.height / 2 - self.y * this.zoom);
    this.fps = this.app.ticker.FPS;
    this.frameMs = this.frameMs * 0.95 + (performance.now() - t0) * 0.05;
  }

  /** Bench mode (?bench=N): N local avatars wandering, to measure rendering alone (NFR-PERF-002). */
  startBench(n: number, map: OfficeMap): void {
    const w = map.width * TILE_SIZE;
    const h = map.height * TILE_SIZE;
    const bots: RemoteAvatar[] = [];
    const statuses: VoStatus[] = ['ACTIVE', 'ACTIVE', 'ACTIVE', 'IDLE', 'IN_MEETING', 'ON_BREAK', 'AWAY', 'DND'];
    for (let i = 0; i < n; i += 1) {
      const x = 64 + Math.random() * (w - 128);
      const y = 64 + Math.random() * (h - 128);
      const a: RemoteAvatar = { id: `bench-${i}`, x, y, rx: x, ry: y, dir: 0, status: statuses[i % statuses.length]!, roomId: null, away: false };
      bots.push(a);
      this.client.avatars.set(a.id, a);
      this.client.roster.set(a.id, { id: a.id, name: `Bench ${i + 1}`, status: a.status, statusMessage: '', floorId: this.client.self?.floorId ?? null, roomId: null, away: false, avatar: AVATAR_KEYS[i % AVATAR_KEYS.length]! });
    }
    // 10 Hz targets, like the server.
    if (this.benchTimer) clearInterval(this.benchTimer);
    this.benchTimer = setInterval(() => {
      for (const a of bots) {
        a.x = Math.max(48, Math.min(w - 48, a.x + (Math.random() - 0.5) * 40));
        a.y = Math.max(48, Math.min(h - 48, a.y + (Math.random() - 0.5) * 40));
      }
    }, 100);
  }
}
