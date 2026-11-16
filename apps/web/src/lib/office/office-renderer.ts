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
import { Application, BitmapText, CanvasSource, Container, Graphics, Rectangle, Sprite, Texture, UPDATE_PRIORITY } from 'pixi.js';
import { ACTION_MS, AVATAR_FRAMES, AVATAR_KEYS, AVATAR_POSES, avatarKeyOr, createAnimation, FACINGS, gameObjects, objectLayer, poseCell, prop, sheetCell, stepAnimation, TILE_SIZE } from '@hrvo/shared';
import type { AvatarActionKind, AvatarActionState, AvatarAnimation, Emote, AvatarFrame, AvatarKey, AvatarPose, CampusGame, Facing, MapObject, OfficeMap, VoStatus } from '@hrvo/shared';
import { createAvatarSheetCanvas } from './avatar-sheet';
import { renderEnvironment } from './office-environment';
import { renderIsoEnvironment } from './office-iso';
import { renderFestive } from './office-festive';
import type { AtlasSprite } from './pixel-kit';
import { depthOf, officeProjection, project, unproject, viewBounds } from './projection';
import type { Projection, Pt } from './projection';
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
    // ADR 056: the action poses, cut from the same sheet.
    for (const key of AVATAR_KEYS) for (const pose of AVATAR_POSES) {
      const c = poseCell(key, pose);
      this.frames.set(`${key}/pose/${pose}`, new Texture({ source: this.source, frame: new Rectangle(c.x, c.y, c.width, c.height) }));
    }
  }

  pose(key: AvatarKey, pose: AvatarPose): Texture {
    return this.frames.get(`${key}/pose/${pose}`)!;
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

/** Changes whenever a new action starts, so a second wave restarts the animation. */
const actionSig = (a: AvatarActionState): string => `${a.kind}|${a.with ?? ''}|${a.seat ?? ''}|${a.since ?? ''}`;

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
  /** ADR 056: the action shown (its signature and when it started here), its effect, its pose. */
  actSig: string;
  actAt: number;
  /** Created on the first action that needs an effect (most avatars never do). */
  fx: Graphics | null;
  fxSig: string;
  pose: AvatarPose | null;
  lift: number;
  /** For the browser tests: the last pose shown and the highest jump lift of the current action. */
  lastPose: AvatarPose | null;
  maxLift: number;
}

/** What an avatar is doing on screen right now (from the roster, or my own optimistic action). */
interface ShownAction { kind: AvatarActionKind; with?: string; facing?: Facing; sig: string; at?: number }

/** ADR 056: the pose, lift (px up), sway (px sideways) and effect of an action `t` ms in. */
type Fx = 'heart' | 'spark' | 'note' | Emote;
function actionLook(kind: AvatarActionKind, t: number, facing: Facing, partnerRight: boolean, reduced: boolean): { pose: AvatarPose | null; lift: number; sway: number; fx: Fx | null } {
  const alt = (period: number) => (reduced ? 0 : Math.floor(t / period) % 2);
  switch (kind) {
    case 'sit': return { pose: `sit-${facing}` as AvatarPose, lift: 0, sway: 0, fx: null };
    case 'jump': {
      if (t >= ACTION_MS.jump) return { pose: null, lift: 0, sway: 0, fx: null };
      if (reduced) return { pose: 'jump-air', lift: 0, sway: 0, fx: null };
      if (t < 90 || t > 510) return { pose: 'jump-crouch', lift: 0, sway: 0, fx: null };
      return { pose: 'jump-air', lift: Math.round(Math.sin(((t - 90) / 420) * Math.PI) * 14), sway: 0, fx: null };
    }
    case 'wave': return t < ACTION_MS.wave ? { pose: alt(230) ? 'wave-b' : 'wave-a', lift: 0, sway: 0, fx: null } : { pose: null, lift: 0, sway: 0, fx: null };
    case 'dance': return t < ACTION_MS.dance ? { pose: alt(260) ? 'dance-b' : 'dance-a', lift: reduced ? 0 : alt(130), sway: reduced ? 0 : (alt(260) ? 1 : -1), fx: 'note' } : { pose: null, lift: 0, sway: 0, fx: null };
    case 'hug': return t < ACTION_MS.hug ? { pose: partnerRight ? 'hug-right' : 'hug-left', lift: 0, sway: 0, fx: 'heart' } : { pose: null, lift: 0, sway: 0, fx: null };
    // FR-VO-018: an emote keeps the walk frame and shows its bubble.
    case 'laugh': case 'love': case 'thumbsup': case 'idea': case 'coffee':
      return t < ACTION_MS[kind] ? { pose: null, lift: 0, sway: 0, fx: kind } : { pose: null, lift: 0, sway: 0, fx: null };
    case 'highfive': return t < ACTION_MS.highfive ? { pose: partnerRight ? 'highfive-right' : 'highfive-left', lift: 0, sway: 0, fx: t > 250 ? 'spark' : null } : { pose: null, lift: 0, sway: 0, fx: null };
  }
}

/** What one avatar looks like right now (for the browser tests; no personal data beyond the id). */
export interface AvatarDebug { id: string; self: boolean; key: AvatarKey; facing: Facing; frame: AvatarFrame; walking: boolean; status: VoStatus | null; away: boolean; pose: AvatarPose | null; lift: number; lastPose: AvatarPose | null; maxLift: number; fx: string }

export class OfficeRenderer {
  app = new Application();
  private world = new Container();
  /**
   * ADR 061: the floor-flat layers (environment, festive layer). In the isometric view this
   * container carries the projection matrix; avatars, tall props, labels and links stay upright and
   * are placed at projected points instead.
   */
  private ground = new Container();
  private labelLayer = new Container();
  /** ADR 061: room names above the standing pieces (a counter or wall must not hide them). */
  private roomLabelLayer = new Container();
  readonly projection: Projection;
  /** ADR 061: standing pieces that fade while the user is behind them, and game bodies on screen (view px). */
  private isoFade: Sprite[] = [];
  private isoGames: Array<{ id: number; x: number; y: number; width: number; height: number }> = [];
  private P = (x: number, y: number): Pt => project(this.projection, x, y);
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
  /** FR-VO-019: sparkles on the pool and pond, two prebuilt sets swapped (none with reduced motion). */
  private water: [Graphics, Graphics] | null = null;
  private waterMs = 0;
  private twinkleMs = 0;
  private bulbCount = 0;
  /** ADR 056: the server start time of my own action already shown optimistically. */
  private echoed: number | null = null;
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
  /** Time per draw (Pixi's render), draws per second (only when the scene changed), draw-list rebuilds per second. */
  renderMs = 0;
  drawsPerSecond = 0;
  rebuildsPerSecond = 0;
  private drawCount = 0;
  private rebuildCount = 0;
  private statWindow = 0;
  private lastDraw = 0;
  private drawnSize = '';
  /**
   * Viewport culling (static scene pieces only): their bounds in world pixels, checked when the
   * camera has moved by a few pixels. Pieces outside the screen are not drawn and, more importantly,
   * not re-listed when the depth order changes.
   */
  private cullables: Array<{ c: Container; x0: number; y0: number; x1: number; y1: number }> = [];
  private lastCull: { x: number; y: number; zoom: number; w: number; h: number } | null = null;
  private linkKey = '';
  /** FR-VO-008: a right-click on another person's avatar; the page opens that person's menu. */
  onAvatarMenu: ((userId: string) => void) | null = null;

  /** `projection`: the view to draw (ADR 061); the person's saved choice or the build's default. */
  constructor(private readonly client: OfficeClient, private readonly host: HTMLElement, projection: Projection = officeProjection()) {
    this.projection = projection;
  }

  async init(): Promise<void> {
    await this.app.init({ resizeTo: this.host, background: 0xf8fafc, antialias: true, autoDensity: true, resolution: Math.min(window.devicePixelRatio || 1, 2) });
    if (this.destroyed) { this.app.destroy(true); return; }
    this.textures = new AvatarTextures();
    this.app.canvas.setAttribute('aria-hidden', 'true');
    this.host.appendChild(this.app.canvas);
    // ADR 061: in the isometric view the floor chunks are painted in view space already
    // (office-iso.ts), so the ground needs no matrix.
    this.ground.addChild(this.mapLayer, this.festiveLayer);
    this.world.addChild(this.ground, this.labelLayer, this.linkLayer, this.avatarLayer, this.roomLabelLayer);
    this.avatarLayer.sortableChildren = true;
    // Separate render groups: a depth change among the avatars and standing pieces (every step
    // someone takes) re-lists only that layer, and the water glint only the ground.
    this.avatarLayer.isRenderGroup = true;
    this.ground.isRenderGroup = true;
    this.app.stage.addChild(this.world);
    this.app.stage.eventMode = 'static';
    this.app.stage.hitArea = this.app.screen;
    this.app.stage.on('pointerdown', (e) => {
      const v = this.world.toLocal(e.global);
      // ADR 061: a click on a standing game cabinet or table (its body rises above its footprint).
      const body = this.isoGames.find((g) => v.x >= g.x && v.x <= g.x + g.width && v.y >= g.y && v.y <= g.y + g.height);
      const bodyHit = body ? this.games.find((g) => g.object.id === body.id) : undefined;
      if (bodyHit && this.onGameObject) { this.onGameObject(bodyHit.game, bodyHit.object); return; }
      const p = unproject(this.projection, v.x, v.y);
      const hit = this.games.find((g) => p.x >= g.object.x - 4 && p.x <= g.object.x + g.object.width + 4 && p.y >= g.object.y - 14 && p.y <= g.object.y + g.object.height + 4);
      if (hit && this.onGameObject) { this.onGameObject(hit.game, hit.object); return; }
      this.client.walkTo({ x: p.x, y: p.y });
    });
    this.host.addEventListener('wheel', this.onWheel, { passive: false });
    this.host.addEventListener('contextmenu', this.onContext);
    this.app.ticker.add((t) => this.frame(t.deltaMS));
    // Draw only when the scene changed (NFR-PERF-002). Pixi queues every change it will draw:
    // structure (added, removed, shown, hidden, re-sorted), transforms and colours, and view updates
    // (a texture swapped for the next walking frame, text, graphics). When all are empty, the next
    // frame would be the same picture, so the last one stays on screen. The frame logic above still
    // runs every tick (movement, animation timers); a redraw at least once a second is a safety net.
    this.app.ticker.remove(this.app.render, this.app);
    this.app.ticker.add((t) => this.renderIfChanged(t.deltaMS), undefined, UPDATE_PRIORITY.LOW);
  }

  private renderIfChanged(dtMs: number): void {
    const now = performance.now();
    const groups = [this.app.stage, this.avatarLayer, this.ground];
    const rebuild = groups.some((c) => c.renderGroup?.structureDidChange);
    const size = `${this.app.screen.width}x${this.app.screen.height}@${this.app.renderer.resolution}`;
    const changed = rebuild || size !== this.drawnSize || now - this.lastDraw >= 1000 || groups.some((c) => {
      const g = c.renderGroup;
      if (!g) return false;
      if (g.childrenRenderablesToUpdate.index > 0) return true;
      for (const k in g.childrenToUpdate) if ((g.childrenToUpdate[k]?.index ?? 0) > 0) return true;
      return false;
    });
    if (changed) {
      const t0 = performance.now();
      this.app.render();
      this.renderMs = this.renderMs * 0.9 + (performance.now() - t0) * 0.1;
      this.lastDraw = now;
      this.drawnSize = size;
      this.drawCount += 1;
      if (rebuild) this.rebuildCount += 1;
    }
    this.statWindow += dtMs;
    if (this.statWindow >= 1000) {
      this.drawsPerSecond = (this.drawCount * 1000) / this.statWindow;
      this.rebuildsPerSecond = (this.rebuildCount * 1000) / this.statWindow;
      this.drawCount = 0;
      this.rebuildCount = 0;
      this.statWindow = 0;
    }
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
    return [...this.sprites].map(([id, s]) => ({ id, self: s.self, key: s.key, facing: s.anim.facing, frame: s.anim.frame, walking: s.anim.walking, status: s.status, away: !!s.away, pose: s.pose, lift: s.lift, lastPose: s.lastPose, maxLift: s.maxLift, fx: s.fxSig }));
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
    this.cullables = [];
    this.lastCull = null;
    if (this.projection === 'iso') { this.drawIsoMap(map); return; }
    const env = renderEnvironment(map);
    for (const chunk of env.chunks) {
      const source = new CanvasSource({ resource: chunk.canvas, scaleMode: this.envScaleMode });
      const texture = new Texture({ source });
      this.envTextures.push(texture);
      const sprite = new Sprite(texture);
      sprite.position.set(chunk.x, chunk.y);
      this.mapLayer.addChild(sprite);
      this.cullable(sprite);
    }
    // Labels on small cream plates, so they read on every floor (the isometric view: drawLabels).
    for (const c of this.labelLayer.removeChildren()) c.destroy({ children: true });
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
    this.buildWater(map);
    this.map = map;
    this.games = gameObjects(map);
    if (this.festiveOn) this.buildFestive();
  }

  /**
   * ADR 061: the isometric scene. Floor chunks (painted in view space) on the ground; walls,
   * furniture and chairs as standing pieces sorted with the avatars; labels upright on top.
   */
  private drawIsoMap(map: OfficeMap): void {
    const env = renderIsoEnvironment(map);
    for (const chunk of env.chunks) {
      const texture = new Texture({ source: new CanvasSource({ resource: chunk.canvas, scaleMode: this.envScaleMode }) });
      this.envTextures.push(texture);
      const sprite = new Sprite(texture);
      sprite.position.set(chunk.x, chunk.y);
      this.mapLayer.addChild(sprite);
      this.cullable(sprite);
    }
    this.isoFade = [];
    this.isoGames = [];
    if (env.props) {
      const source = new CanvasSource({ resource: env.props.canvas, scaleMode: this.envScaleMode });
      const out: SceneAtlas = { source, textures: [], sprites: [] };
      env.props.sprites.forEach((a, i) => {
        const texture = new Texture({ source, frame: new Rectangle(a.sx, a.sy, a.width, a.height) });
        const sprite = new Sprite(texture);
        sprite.roundPixels = true;
        sprite.position.set(a.x, a.y);
        sprite.zIndex = a.depth ?? 0;
        this.avatarLayer.addChild(sprite);
        this.cullable(sprite);
        out.textures.push(texture);
        out.sprites.push(sprite);
        const info = env.info[i];
        if (info?.fade) this.isoFade.push(sprite);
        if (info?.game !== null && info?.game !== undefined) this.isoGames.push({ id: info.game, x: a.x, y: a.y, width: a.width, height: a.height });
      });
      this.props = out;
    }
    this.buildWater(map);
    this.drawLabels(map);
    this.map = map;
    this.games = gameObjects(map);
    if (this.festiveOn) this.buildFestive();
  }

  /** Room and desk labels, upright, at their projected points (isometric view). */
  private drawLabels(map: OfficeMap): void {
    for (const c of this.labelLayer.removeChildren()) c.destroy({ children: true });
    for (const c of this.roomLabelLayer.removeChildren()) c.destroy({ children: true });
    const plates = new Graphics();
    this.roomLabelLayer.addChild(plates);
    for (const r of objectLayer(map, 'rooms')) {
      const label = new BitmapText({ text: r.name, style: { fontFamily: 'Arial', fontSize: 14, fill: 0x24324a } });
      const at = this.P(r.x + r.width / 2, r.y + 20);
      const lx = at.x - Math.ceil(label.width) / 2;
      label.position.set(lx, at.y);
      plates.rect(lx - 6, at.y - 3, Math.ceil(label.width) + 12, 22).fill({ color: 0xfbf6ea, alpha: 0.92 }).stroke({ width: 1, color: 0x2e3d5a, alpha: 0.55 });
      this.roomLabelLayer.addChild(label);
    }
    for (const d of objectLayer(map, 'desks')) {
      const label = new BitmapText({ text: d.name, style: { fontFamily: 'Arial', fontSize: 10, fill: 0x1f2937 } });
      const at = this.P(d.x + d.width / 2, d.y + d.height);
      label.position.set(at.x - Math.ceil(label.width) / 2, at.y + 2);
      const plate = new Graphics().rect(at.x - Math.ceil(label.width) / 2 - 3, at.y + 1, Math.ceil(label.width) + 6, 14).fill({ color: 0xfbf6ea, alpha: 0.85 });
      this.labelLayer.addChild(plate, label);
    }
  }

  /** FR-VO-019: light glinting on the water of pools and ponds (map points, projected in the isometric view). */
  private buildWater(map: OfficeMap): void {
    this.water = null;
    const pools = objectLayer(map, 'furniture').filter((o) => ['pool', 'pond'].includes(String(prop(o, 'kind', '')).toLowerCase()));
    if (!pools.length) return;
    const frames: [Graphics, Graphics] = [new Graphics(), new Graphics()];
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (const o of pools) {
      const inset = String(prop(o, 'kind', '')) === 'pool' ? 12 : 14;
      for (const g of frames) for (let i = 0; i < Math.max(6, Math.round((o.width * o.height) / 900)); i += 1) {
        const mx = o.x + inset + rnd() * (o.width - inset * 2);
        const my = o.y + inset + rnd() * (o.height - inset * 2);
        const p = this.P(mx, my);
        g.rect(Math.round(p.x) - 2, Math.round(p.y) - (this.projection === 'iso' ? 2 : 0), 4, 1).fill({ color: 0xffffff, alpha: 0.75 });
        g.rect(Math.round(p.x) - 1, Math.round(p.y) - (this.projection === 'iso' ? 3 : 1), 2, 1).fill({ color: 0xe0f7ff, alpha: 0.6 });
      }
    }
    frames[1].visible = false;
    this.mapLayer.addChild(frames[0], frames[1]);
    this.water = frames;
    this.waterMs = 0;
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
      sprite.roundPixels = true;
      // ADR 061: flat seasonal pieces (garlands on the top-down walls) have no place in the isometric view.
      if (a.depth === null && this.projection === 'iso') { sprite.visible = false; flat.addChild(sprite); }
      else if (a.depth === null) { sprite.position.set(a.x, a.y); flat.addChild(sprite); }
      else if (this.projection === 'iso') {
        // ADR 061: standing pieces stay upright, their base centre placed at the projected point.
        const bx = a.x + a.width / 2;
        sprite.anchor.set(0.5, Math.min(1, Math.max(0, (a.depth - a.y) / a.height)));
        const at = this.P(bx, a.depth);
        sprite.position.set(at.x, at.y);
        sprite.zIndex = depthOf('iso', bx, a.depth);
        this.avatarLayer.addChild(sprite);
        this.cullable(sprite);
      } else { sprite.position.set(a.x, a.y); sprite.zIndex = a.depth; this.avatarLayer.addChild(sprite); this.cullable(sprite); }
      out.textures.push(texture);
      out.sprites.push(sprite);
    }
    return out;
  }

  /** A static piece (floor chunk, standing piece) drawn only while near the screen; bounds in world px. */
  private cullable(sp: Sprite): void {
    const x0 = sp.x - sp.anchor.x * sp.width;
    const y0 = sp.y - sp.anchor.y * sp.height;
    this.cullables.push({ c: sp, x0, y0, x1: x0 + sp.width, y1: y0 + sp.height });
  }

  /** Shows the static pieces within the screen (plus a margin) and hides the rest; only after the camera moved. */
  private cull(): void {
    const z = this.zoom;
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    const at = { x: this.world.x, y: this.world.y, zoom: z, w, h };
    const last = this.lastCull;
    if (last && last.zoom === z && last.w === w && last.h === h && Math.abs(last.x - at.x) < 24 && Math.abs(last.y - at.y) < 24) return;
    this.lastCull = at;
    const margin = 160;
    const vx0 = -at.x / z - margin;
    const vy0 = -at.y / z - margin;
    const vx1 = vx0 + w / z + margin * 2;
    const vy1 = vy0 + h / z + margin * 2;
    for (const k of this.cullables) k.c.visible = k.x1 >= vx0 && k.x0 <= vx1 && k.y1 >= vy0 && k.y0 <= vy1;
  }

  /** For tests and the benchmark: static pieces drawn now, of all. */
  cullStats(): { shown: number; total: number } {
    return { shown: this.cullables.filter((k) => k.c.visible).length, total: this.cullables.length };
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
    if (this.projection === 'iso') { this.bulbCount = 0; return; } // ADR 061: fairy lights belong to the top-down garlands
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
      const p = this.world.toGlobal(this.P(g.object.x + g.object.width / 2, g.object.y + g.object.height / 2));
      return { game: g.game, x: Math.round(p.x), y: Math.round(p.y), id: g.object.id };
    });
  }

  /** FR-VO-017: the point in front of each board-game table, on screen in host CSS pixels (walking there; browser tests). */
  boardTablesOnScreen(): Array<{ id: number; x: number; y: number }> {
    if (!this.map) return [];
    return objectLayer(this.map, 'furniture').filter((o) => String(prop(o, 'kind', '')).toLowerCase() === 'chess-table').map((o) => {
      const p = this.world.toGlobal(this.P(o.x + o.width / 2, o.y + o.height + 18));
      return { id: o.id, x: Math.round(p.x), y: Math.round(p.y) };
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
    this.isoFade = [];
    this.isoGames = [];
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
    s = { root, ring, body, self, status: null, away: null, name: label, badge, key, anim: createAnimation('down'), shown: `${key}/down/0`, actSig: '', actAt: 0, fx: null, fxSig: '', pose: null, lift: 0, lastPose: null, maxLift: 0 };
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
  private animate(s: AvatarView, key: AvatarKey, dx: number, dy: number, dtMs: number, act: ShownAction | null = null, partnerRight = true): void {
    stepAnimation(s.anim, dx, dy, dtMs);
    // ADR 056: nobody doing anything (the usual case): only the walk frame, no action work.
    if (!act && s.actSig === '' && s.pose === null) {
      const walk = `${key}/${s.anim.facing}/${s.anim.frame}`;
      if (walk !== s.shown) { s.key = key; s.shown = walk; s.body.texture = this.textures!.get(key, s.anim.facing, s.anim.frame); }
      return;
    }
    // An action's pose replaces the walk frame while it lasts.
    const now = performance.now();
    if (!act) s.actSig = '';
    else if (act.sig !== s.actSig) { s.actSig = act.sig; s.actAt = act.at ?? now; s.maxLift = 0; }
    const look = act ? actionLook(act.kind, now - s.actAt, act.facing ?? s.anim.facing, partnerRight, this.reducedMotion) : null;
    s.pose = look?.pose ?? null;
    s.lift = look?.pose ? look.lift : 0;
    if (s.pose) { s.lastPose = s.pose; s.maxLift = Math.max(s.maxLift, s.lift); }
    s.body.position.set(look?.pose ? look.sway : 0, FEET_Y - s.lift);
    this.drawFx(s, look?.fx ?? null, now - s.actAt);
    const shown = s.pose ? `${key}/pose/${s.pose}` : `${key}/${s.anim.facing}/${s.anim.frame}`;
    if (shown === s.shown) return;
    s.key = key;
    s.shown = shown;
    s.body.texture = s.pose ? this.textures!.pose(key, s.pose) : this.textures!.get(key, s.anim.facing, s.anim.frame);
  }

  /** A small heart, sparkle, note or emote bubble above the head; redrawn only when it changes, then just moved. */
  private drawFx(s: AvatarView, kind: Fx | null, t: number): void {
    if (s.fxSig !== (kind ?? '')) {
      s.fxSig = kind ?? '';
      if (!s.fx && kind) { s.fx = new Graphics(); s.root.addChildAt(s.fx, s.root.getChildIndex(s.body) + 1); }
      const g = s.fx;
      if (!g) return;
      g.clear();
      if (kind === 'heart') {
        g.rect(-5, -3, 4, 3).rect(1, -3, 4, 3).rect(-5, 0, 10, 2).rect(-4, 2, 8, 2).rect(-2, 4, 4, 2).fill(0xe0595c);
        g.rect(-4, -2, 2, 1).fill(0xffffff);
      } else if (kind === 'spark') {
        g.rect(-1, -7, 2, 14).rect(-7, -1, 14, 2).fill(0xf3d48a);
        g.rect(-1, -2, 2, 4).rect(-2, -1, 4, 2).fill(0xffffff);
        g.rect(-5, -5, 2, 2).rect(3, -5, 2, 2).rect(-5, 3, 2, 2).rect(3, 3, 2, 2).fill(0xd9a94e);
      } else if (kind === 'note') {
        g.rect(1, -8, 2, 9).rect(3, -8, 4, 2).fill(0x2e3d5a);
        g.rect(-2, -1, 4, 3).fill(0x2e3d5a);
      } else if (kind) {
        // FR-VO-018: a pixel speech bubble (white, dark outline, a tail) with the emote's icon.
        g.rect(-10, -10, 20, 17).fill(0x2a2230);
        g.rect(-9, -9, 18, 15).fill(0xffffff);
        g.rect(-2, 7, 4, 2).fill(0x2a2230);
        g.rect(-1, 6, 2, 2).fill(0xffffff);
        g.rect(-1, 9, 2, 1).fill(0x2a2230);
        if (kind === 'laugh') {
          g.rect(-6, -6, 12, 10).fill(0xfacc15);
          g.rect(-4, -4, 2, 2).rect(2, -4, 2, 2).fill(0x2a2230);
          g.rect(-4, 0, 8, 2).fill(0x7c2d12);
          g.rect(-3, 2, 6, 1).fill(0x7c2d12);
        } else if (kind === 'love') {
          g.rect(-6, -6, 5, 4).rect(1, -6, 5, 4).rect(-6, -2, 12, 3).rect(-4, 1, 8, 2).rect(-2, 3, 4, 2).fill(0xe0595c);
          g.rect(-5, -5, 2, 1).fill(0xffffff);
        } else if (kind === 'thumbsup') {
          g.rect(-6, -2, 3, 7).fill(0x2563eb);
          g.rect(-3, -2, 8, 7).fill(0xf2c79a);
          g.rect(-2, -7, 3, 5).fill(0xf2c79a);
          g.rect(-3, -2, 8, 1).rect(5, -1, 1, 5).fill(0xb7703c);
        } else if (kind === 'idea') {
          g.rect(-4, -7, 8, 8).fill(0xfacc15);
          g.rect(-2, -5, 2, 2).fill(0xfff7c2);
          g.rect(-3, 1, 6, 2).fill(0x9aa3af);
          g.rect(-2, 3, 4, 1).fill(0x4b5563);
        } else if (kind === 'coffee') {
          g.rect(-5, -2, 9, 7).fill(0xc47a5a);
          g.rect(-5, -2, 9, 2).fill(0x5b3a29);
          g.rect(4, 0, 2, 3).fill(0xc47a5a);
          g.rect(-3, -7, 1, 3).rect(0, -8, 1, 3).fill(0x9aa3af);
        }
      }
    }
    if (!kind || !s.fx) return;
    const rise = this.reducedMotion ? 0 : Math.min(8, t / 120);
    s.fx.position.set(kind === 'note' && !this.reducedMotion ? Math.round(Math.sin(t / 200) * 4) : 0, (kind === 'heart' || kind === 'spark' || kind === 'note' ? -26 : -34) - Math.round(rise));
  }

  /** The action to show for an avatar: the roster's, or (for me) the one I just started. */
  private shownAction(id: string, self: boolean): ShownAction | null {
    const r = this.client.roster.get(id)?.action ?? null;
    if (!r && !(self && this.client.selfAction)) return null;
    if (self) {
      const mine = this.client.selfAction;
      const playing = mine && performance.now() - mine.at < ACTION_MS[mine.kind];
      // The server's echo of the action I already started: play it once, not twice.
      if (r && mine && r.kind === mine.kind && r.since !== undefined && performance.now() - mine.at < ACTION_MS[mine.kind] + 2_000) this.echoed = r.since;
      if (playing && (!r || r.kind === mine.kind)) return { kind: mine.kind, sig: `${mine.kind}@${mine.at}`, at: mine.at };
      if (r && r.kind !== 'sit' && r.since !== undefined && r.since === this.echoed) return null;
    }
    return r ? { kind: r.kind, with: r.with, facing: r.facing, sig: actionSig(r) } : null;
  }

  /** For a hug or a high five: is the partner to the right of this avatar? */
  private partnerRight(act: ShownAction | null, x: number): boolean {
    if (!act?.with) return true;
    const p = this.sprites.get(act.with);
    return p ? p.root.position.x >= x : true;
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
      // Settle exactly: an endless approach would change the depth order (and re-list the scene) every frame.
      if (Math.abs(a.x - a.rx) < 0.05) a.rx = a.x;
      if (Math.abs(a.y - a.ry) < 0.05) a.ry = a.y;
      const entry = c.roster.get(a.id);
      const name = entry?.name ?? '…';
      const key = avatarKeyOr(entry?.avatar);
      const s = this.sprite(a.id, name, false, key);
      if (s.name.text !== name) s.name.text = name;
      this.setStatus(s, a.status, a.away);
      // Remote movement is inferred from the eased position the user actually sees.
      const act = this.shownAction(a.id, false);
      // ADR 061: walk direction and placement as seen on screen.
      const at = this.P(a.rx, a.ry);
      const was = this.P(px, py);
      this.animate(s, key, at.x - was.x, at.y - was.y, dtMs, act, this.partnerRight(act, at.x));
      s.root.position.set(at.x, at.y);
      s.root.zIndex = depthOf(this.projection, a.rx, a.ry);
      seen.add(a.id);
    }
    const meEntry = c.roster.get(meId);
    // The saved character (the server's roster); an unsaved choice in the picker never shows here.
    const myKey = avatarKeyOr(meEntry?.avatar ?? c.snapshot.me.avatarKey);
    const mine = this.sprite(meId, meEntry?.name ?? 'You', true, myKey);
    this.setStatus(mine, meEntry?.status ?? 'ACTIVE');
    const last = this.lastSelf;
    const moved = last && last.floorId === self.floorId ? { dx: self.x - last.x, dy: self.y - last.y } : { dx: 0, dy: 0 };
    const myAct = this.shownAction(meId, true);
    const me = this.P(self.x, self.y);
    const step = this.projection === 'iso' ? { dx: moved.dx - moved.dy, dy: (moved.dx + moved.dy) / 2 } : moved;
    this.animate(mine, myKey, step.dx, step.dy, dtMs, myAct, this.partnerRight(myAct, me.x));
    this.lastSelf = { x: self.x, y: self.y, floorId: self.floorId };
    mine.root.position.set(me.x, me.y);
    mine.root.zIndex = depthOf(this.projection, self.x, self.y) + 0.5;
    // ADR 061: a wall in front of the user goes see-through while they stand behind it.
    if (this.isoFade.length) {
      const myDepth = mine.root.zIndex;
      for (const sp of this.isoFade) {
        const covers = sp.zIndex > myDepth && me.x >= sp.x - 6 && me.x <= sp.x + sp.width + 6 && me.y - 30 <= sp.y + sp.height && me.y >= sp.y;
        sp.alpha = covers ? 0.35 : 1;
      }
    }
    seen.add(meId);
    for (const [id, s] of this.sprites) if (!seen.has(id)) { s.root.destroy({ children: true }); this.sprites.delete(id); }
    // FR-VO-005: links to the people in the same proximity group (redrawn only when they change).
    const links: Array<[Pt, Pt]> = [];
    for (const m of c.proximity.members) {
      if (m === meId) continue;
      const a = c.avatars.get(m);
      if (a) links.push([me, this.P(a.rx, a.ry)]);
    }
    const linkKey = links.map(([f, t]) => `${Math.round(f.x)},${Math.round(f.y)},${Math.round(t.x)},${Math.round(t.y)}`).join(';');
    if (linkKey !== this.linkKey) {
      this.linkKey = linkKey;
      this.linkLayer.clear();
      for (const [f, t] of links) this.linkLayer.moveTo(f.x, f.y).lineTo(t.x, t.y);
      if (links.length) this.linkLayer.stroke({ width: 2, color: 0x7c3aed, alpha: 0.35 });
    }
    // Camera follows the user (who stays in the middle, as the overlays expect). ADR 060: when the
    // whole map fits on an axis (zoomed out), it is centred on that axis instead of drifting with
    // the user and leaving an empty band.
    this.world.scale.set(this.zoom);
    this.updateSampling();
    // ADR 061: in view coordinates (projected), over the map's projected extent.
    const axis = (view: number, min: number, max: number, at: number): number => {
      const span = (max - min) * this.zoom;
      return span <= view ? (view - span) / 2 - min * this.zoom : view / 2 - at * this.zoom;
    };
    const b = this.map ? viewBounds(this.projection, this.map.width * TILE_SIZE, this.map.height * TILE_SIZE) : null;
    const camX = b ? axis(this.app.screen.width, b.minX, b.maxX, me.x) : this.app.screen.width / 2 - me.x * this.zoom;
    const camY = b ? axis(this.app.screen.height, b.minY, b.maxY, me.y) : this.app.screen.height / 2 - me.y * this.zoom;
    // Snapped to whole device pixels, so the pixel art does not shimmer while the camera follows.
    const res = this.app.renderer.resolution;
    this.world.position.set(Math.round(camX * res) / res, Math.round(camY * res) / res);
    this.cull();
    // FR-VO-019: the water glints by swapping two prebuilt sets of sparkles (none with reduced motion).
    if (this.water && !this.reducedMotion) {
      this.waterMs += dtMs;
      if (this.waterMs >= 700) { this.waterMs = 0; this.water[0].visible = !this.water[0].visible; this.water[1].visible = !this.water[0].visible; }
    }
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
