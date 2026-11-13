'use client';

/**
 * PixiJS renderer for the office (FR-VO-001, 002, 003; ADR 015, 053, 054). Everything is drawn in
 * code; there is no image asset. The static map is pixel art painted once per floor into canvas
 * textures (office-environment.ts). Avatars are
 * pixel-art characters cut from one spritesheet texture shared by everyone (built once per
 * renderer from the shared pixel source); each avatar is a reused container whose status ring is
 * redrawn only when the status changes, and whose walk animation runs here, in the render loop,
 * inferred from how far the avatar actually moved (no React state, no extra network message).
 */
// The CSP has no 'unsafe-eval' in production builds; this PixiJS module swaps its generated
// shader/uniform code for eval-free versions (otherwise the canvas never starts: "0 fps").
import 'pixi.js/unsafe-eval';
import { Application, BitmapText, CanvasSource, Container, Graphics, Rectangle, Sprite, Texture } from 'pixi.js';
import { AVATAR_FRAMES, AVATAR_KEYS, avatarKeyOr, createAnimation, FACINGS, gameObjects, objectLayer, sheetCell, stepAnimation, TILE_SIZE } from '@hrvo/shared';
import type { AvatarAnimation, AvatarFrame, AvatarKey, CampusGame, Facing, MapObject, OfficeMap, VoStatus } from '@hrvo/shared';
import { createAvatarSheetCanvas } from './avatar-sheet';
import { renderEnvironment } from './office-environment';
import { renderFestive } from './office-festive';
import type { AtlasSprite } from './pixel-kit';
import type { OfficeClient, RemoteAvatar } from './office-client';

export const STATUS_COLOUR: Record<VoStatus, number> = {
  ACTIVE: 0x16a34a, IDLE: 0xeab308, IN_MEETING: 0x7c3aed, ON_BREAK: 0x0ea5e9, AWAY: 0x9ca3af, DND: 0xdc2626, OFFLINE: 0x6b7280,
};

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

/** An atlas on screen: one texture source, its sub-textures and their sprites. */
interface SceneAtlas { source: CanvasSource; textures: Texture[]; sprites: Sprite[] }

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
  /** ADR 054: the environment chunk textures of the floor on screen, and how they are sampled. */
  private envTextures: Texture[] = [];
  private envScaleMode: 'nearest' | 'linear' = 'nearest';
  /** ADR 055: tall props (trees, cabinets, plants) from one atlas, sorted with the avatars. */
  private props: SceneAtlas | null = null;
  /** ADR 055: the festive layer, built only while festive mode is on. */
  private festiveOn = false;
  private festiveLayer = new Container();
  private festive: SceneAtlas | null = null;
  private bulbs: [Graphics, Graphics] | null = null;
  private twinkleMs = 0;
  private bulbCount = 0;
  private readonly reducedMotion = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private map: OfficeMap | null = null;
  private games: Array<{ object: MapObject; game: CampusGame }> = [];
  /** ADR 055: a click or tap on a campus game object (the page walks there and opens the game). */
  onGameObject: ((game: CampusGame, object: MapObject) => void) | null = null;
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
    this.world.addChild(this.mapLayer, this.festiveLayer, this.linkLayer, this.avatarLayer);
    this.avatarLayer.sortableChildren = true;
    this.app.stage.addChild(this.world);
    this.app.stage.eventMode = 'static';
    this.app.stage.hitArea = this.app.screen;
    this.app.stage.on('pointerdown', (e) => {
      const p = this.world.toLocal(e.global);
      const hit = this.games.find((g) => p.x >= g.object.x - 4 && p.x <= g.object.x + g.object.width + 4 && p.y >= g.object.y - 14 && p.y <= g.object.y + g.object.height + 4);
      if (hit && this.onGameObject) { this.onGameObject(hit.game, hit.object); return; }
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
    this.releaseEnvironment();
    this.releaseFestive();
    this.lastSelf = null;
    this.map = null;
    this.games = [];
    this.onGameObject = null;
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

  /**
   * ADR 054: the static scene. The pixel-art environment is painted once per floor into canvas
   * chunks (office-environment.ts) and shown as sprites; labels sit on top. Nothing is redrawn per
   * frame, and the avatar layer above is separate.
   */
  private drawMap(map: OfficeMap): void {
    for (const c of this.mapLayer.removeChildren()) c.destroy({ children: true });
    this.releaseEnvironment();
    const env = renderEnvironment(map);
    for (const chunk of env.chunks) {
      const source = new CanvasSource({ resource: chunk.canvas, scaleMode: this.envScaleMode });
      const texture = new Texture({ source });
      this.envTextures.push(texture);
      const sprite = new Sprite(texture);
      sprite.position.set(chunk.x, chunk.y);
      this.mapLayer.addChild(sprite);
    }
    // Labels on small cream plates, so they read on every floor.
    const plates = new Graphics();
    this.mapLayer.addChild(plates);
    for (const r of objectLayer(map, 'rooms')) {
      const label = new BitmapText({ text: r.name, style: { fontFamily: 'Arial', fontSize: 14, fill: 0x24324a } });
      label.position.set(r.x + 12, r.y + 8);
      plates.rect(r.x + 6, r.y + 5, Math.ceil(label.width) + 12, 22).fill({ color: 0xfbf6ea, alpha: 0.92 }).stroke({ width: 1, color: 0x2e3d5a, alpha: 0.55 });
      this.mapLayer.addChild(label);
    }
    for (const d of objectLayer(map, 'desks')) {
      const label = new BitmapText({ text: d.name, style: { fontFamily: 'Arial', fontSize: 10, fill: 0x1f2937 } });
      label.position.set(d.x + 6, d.y + 7);
      this.mapLayer.addChild(label);
    }
    this.props = env.props ? this.atlasSprites(env.props, this.mapLayer) : null;
    this.map = map;
    this.games = gameObjects(map);
    if (this.festiveOn) this.buildFestive();
  }

  /**
   * One texture for a whole atlas, a sub-texture and sprite per piece: flat pieces go on `flat`,
   * pieces with a depth into the avatar layer, sorted by their base.
   */
  private atlasSprites(atlas: { canvas: HTMLCanvasElement; sprites: AtlasSprite[] }, flat: Container): SceneAtlas {
    const source = new CanvasSource({ resource: atlas.canvas, scaleMode: this.envScaleMode });
    const out: SceneAtlas = { source, textures: [], sprites: [] };
    for (const a of atlas.sprites) {
      const texture = new Texture({ source, frame: new Rectangle(a.sx, a.sy, a.width, a.height) });
      const sprite = new Sprite(texture);
      sprite.position.set(a.x, a.y);
      sprite.roundPixels = true;
      if (a.depth === null) flat.addChild(sprite);
      else { sprite.zIndex = a.depth; this.avatarLayer.addChild(sprite); }
      out.textures.push(texture);
      out.sprites.push(sprite);
    }
    return out;
  }

  private releaseAtlas(a: SceneAtlas | null): void {
    if (!a) return;
    for (const sp of a.sprites) if (!sp.destroyed) sp.destroy();
    for (const t of a.textures) t.destroy(false);
    a.source.destroy();
  }

  /** ADR 055: festive mode on or off. Off destroys the whole seasonal layer; on builds it again. */
  setFestive(on: boolean): void {
    if (on === this.festiveOn) return;
    this.festiveOn = on;
    if (on) this.buildFestive();
    else this.releaseFestive();
  }

  private buildFestive(): void {
    this.releaseFestive();
    if (!this.map || this.destroyed) return;
    const f = renderFestive(this.map);
    this.festive = f.atlas ? this.atlasSprites(f.atlas, this.festiveLayer) : null;
    const a = new Graphics();
    const b = new Graphics();
    for (const bulb of f.bulbs) {
      const g = bulb.phase === 0 ? a : b;
      g.rect(bulb.x - 1, bulb.y - 1, 3, 3).fill(bulb.colour);
      g.rect(bulb.x - 2, bulb.y - 2, 5, 5).fill({ color: bulb.colour, alpha: 0.25 });
    }
    this.festiveLayer.addChild(a, b);
    this.bulbs = [a, b];
    this.bulbCount = f.bulbs.length;
    this.twinkleMs = 0;
  }

  private releaseFestive(): void {
    this.releaseAtlas(this.festive);
    this.festive = null;
    for (const g of this.bulbs ?? []) if (!g.destroyed) g.destroy();
    this.bulbs = null;
    this.bulbCount = 0;
    for (const c of this.festiveLayer.removeChildren()) if (!c.destroyed) c.destroy();
  }

  /** ADR 055: festive layer state (browser tests): on/off, pieces and bulbs currently alive. */
  festiveInfo(): { on: boolean; pieces: number; bulbs: number } {
    return { on: this.festiveOn, pieces: this.festive?.sprites.length ?? 0, bulbs: this.bulbCount };
  }

  /** ADR 055: the campus game objects on screen in host CSS pixels (overlay prompt, browser tests). */
  gamesOnScreen(): Array<{ game: CampusGame; x: number; y: number; id: number }> {
    return this.games.map((g) => {
      const p = this.world.toGlobal({ x: g.object.x + g.object.width / 2, y: g.object.y + g.object.height / 2 });
      return { game: g.game, x: Math.round(p.x), y: Math.round(p.y), id: g.object.id };
    });
  }

  /** ADR 054: how many static environment textures are alive and how they are sampled (browser tests). */
  environmentInfo(): { chunks: number; sampling: 'nearest' | 'linear' } {
    return { chunks: this.envTextures.length, sampling: this.envScaleMode };
  }

  private releaseEnvironment(): void {
    for (const t of this.envTextures) t.destroy(true);
    this.envTextures = [];
    this.releaseAtlas(this.props);
    this.props = null;
  }

  /**
   * Crisp pixels when the scene is shown at its own size or larger; smooth sampling when it is
   * shrunk below one screen pixel per art pixel (zoomed far out), where nearest-neighbour shimmers.
   */
  private updateSampling(): void {
    const mode = this.zoom * this.app.renderer.resolution >= 1 ? 'nearest' : 'linear';
    if (mode === this.envScaleMode) return;
    this.envScaleMode = mode;
    for (const t of this.envTextures) t.source.scaleMode = mode;
    if (this.props) this.props.source.scaleMode = mode;
    if (this.festive) this.festive.source.scaleMode = mode;
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
    this.updateSampling();
    // Snapped to whole device pixels, so the pixel art does not shimmer while the camera follows.
    const res = this.app.renderer.resolution;
    this.world.position.set(Math.round((this.app.screen.width / 2 - self.x * this.zoom) * res) / res, Math.round((this.app.screen.height / 2 - self.y * this.zoom) * res) / res);
    // ADR 055: fairy lights twinkle by swapping two prebuilt shapes (none with reduced motion).
    if (this.bulbs && !this.reducedMotion) {
      this.twinkleMs += dtMs;
      if (this.twinkleMs >= 650) {
        this.twinkleMs = 0;
        const [a, b] = this.bulbs;
        a.alpha = a.alpha === 1 ? 0.35 : 1;
        b.alpha = a.alpha === 1 ? 0.35 : 1;
      }
    }
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
