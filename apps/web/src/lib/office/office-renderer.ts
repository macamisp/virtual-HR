'use client';

/**
 * PixiJS renderer for the office (FR-VO-001, 002, 003; ADR 015). Everything is drawn from simple
 * shapes in code; there is no image asset. The static map is drawn once and cached as a texture;
 * avatars are reused containers whose status ring is redrawn only when the status changes.
 */
import { Application, BitmapText, Container, Graphics } from 'pixi.js';
import { objectLayer, prop, TILE_SIZE, tileLayer } from '@hrvo/shared';
import type { OfficeMap, VoStatus } from '@hrvo/shared';
import type { OfficeClient, RemoteAvatar } from './office-client';

export const STATUS_COLOUR: Record<VoStatus, number> = {
  ACTIVE: 0x16a34a, IDLE: 0xeab308, IN_MEETING: 0x7c3aed, ON_BREAK: 0x0ea5e9, AWAY: 0x9ca3af, DND: 0xdc2626, OFFLINE: 0x6b7280,
};
const FLOOR_COLOUR: Record<number, number> = { 1: 0xe8ecf2, 2: 0xe9dcc6, 3: 0xdde7f5, 4: 0xe7e1f3, 5: 0xdcefe3 };
const WALL = 0x475569;
const FURNITURE: Record<string, number> = { table: 0xa8a29e, sofa: 0x93c5fd, counter: 0x86efac, plant: 0x4ade80 };

function hue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  // Pleasant mid-saturation colours from the hash.
  const hh = (h % 360) / 360;
  const f = (n: number) => { const k = (n + hh * 12) % 12; return 0.45 - 0.25 * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}

const initials = (name: string) => name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');

interface Sprite {
  root: Container;
  ring: Graphics;
  status: VoStatus | null;
  name: BitmapText;
}

export class OfficeRenderer {
  app = new Application();
  private world = new Container();
  private mapLayer = new Container();
  private linkLayer = new Graphics();
  private avatarLayer = new Container();
  private sprites = new Map<string, Sprite>();
  private floorId: string | null = null;
  private zoom = 1;
  private destroyed = false;
  fps = 0;
  frameMs = 0;

  constructor(private readonly client: OfficeClient, private readonly host: HTMLElement) {}

  async init(): Promise<void> {
    await this.app.init({ resizeTo: this.host, background: 0xf8fafc, antialias: true, autoDensity: true, resolution: Math.min(window.devicePixelRatio || 1, 2) });
    if (this.destroyed) { this.app.destroy(true); return; }
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
    this.app.ticker.add((t) => this.frame(t.deltaMS));
  }

  destroy(): void {
    this.destroyed = true;
    this.host.removeEventListener('wheel', this.onWheel);
    try { this.app.destroy(true, { children: true }); } catch { /* not initialised yet */ }
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.zoom = Math.max(0.4, Math.min(2, this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
  };

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

  private sprite(id: string, name: string, self: boolean): Sprite {
    let s = this.sprites.get(id);
    if (s) return s;
    const root = new Container();
    const body = new Graphics().circle(0, 0, 12).fill(hue(id));
    if (self) body.circle(0, 0, 12).stroke({ width: 2, color: 0x0f172a });
    const ring = new Graphics();
    const text = new BitmapText({ text: initials(name), style: { fontFamily: 'Arial', fontSize: 10, fill: 0xffffff, fontWeight: 'bold' } });
    text.anchor.set(0.5);
    const label = new BitmapText({ text: name, style: { fontFamily: 'Arial', fontSize: 11, fill: 0x0f172a } });
    label.anchor.set(0.5, 0);
    label.position.set(0, 17);
    root.addChild(ring, body, text, label);
    s = { root, ring, status: null, name: label };
    this.sprites.set(id, s);
    this.avatarLayer.addChild(root);
    return s;
  }

  private setStatus(s: Sprite, status: VoStatus): void {
    if (s.status === status) return;
    s.status = status;
    s.ring.clear().circle(0, 0, 16).stroke({ width: 3, color: STATUS_COLOUR[status] });
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
      a.rx += (a.x - a.rx) * k;
      a.ry += (a.y - a.ry) * k;
      const name = c.roster.get(a.id)?.name ?? '…';
      const s = this.sprite(a.id, name, false);
      if (s.name.text !== name) s.name.text = name;
      this.setStatus(s, a.status);
      s.root.position.set(a.rx, a.ry);
      s.root.zIndex = a.ry;
      seen.add(a.id);
    }
    const mine = this.sprite(meId, c.roster.get(meId)?.name ?? 'You', true);
    this.setStatus(mine, c.roster.get(meId)?.status ?? 'ACTIVE');
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
      const a: RemoteAvatar = { id: `bench-${i}`, x, y, rx: x, ry: y, dir: 0, status: statuses[i % statuses.length]!, roomId: null };
      bots.push(a);
      this.client.avatars.set(a.id, a);
      this.client.roster.set(a.id, { id: a.id, name: `Bench ${i + 1}`, status: a.status, statusMessage: '', floorId: this.client.self?.floorId ?? null, roomId: null });
    }
    // 10 Hz targets, like the server.
    setInterval(() => {
      for (const a of bots) {
        a.x = Math.max(48, Math.min(w - 48, a.x + (Math.random() - 0.5) * 40));
        a.y = Math.max(48, Math.min(h - 48, a.y + (Math.random() - 0.5) * 40));
      }
    }, 100);
  }
}
