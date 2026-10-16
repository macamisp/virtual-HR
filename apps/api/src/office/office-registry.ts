/**
 * One OfficeWorld per organisation, loaded on first use and reloaded after admin changes
 * (ADR 015). Holds the 10 Hz tick that batches position updates.
 */
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.ts';
import { ensureOffice, loadDesks, loadInvites, loadRooms } from './office-store.ts';
import { OfficeWorld } from './office-world.ts';
import type { WorldEmitter } from './office-world.ts';

export const TICK_MS = 100; // 10 Hz (SRS 8.4)

@Injectable()
export class OfficeRegistry implements OnModuleDestroy {
  private readonly worlds = new Map<string, Promise<OfficeWorld>>();
  private readonly ready = new Map<string, OfficeWorld>();
  private timer: NodeJS.Timeout | null = null;
  private emitter: WorldEmitter | null = null;
  /** Last tick statistics, for tests and the load report. */
  stats = { ticks: 0, messages: 0, entries: 0, maxTickMs: 0 };

  constructor(private readonly prisma: PrismaService) {}

  start(emitter: WorldEmitter): void {
    this.emitter = emitter;
    if (this.timer) return;
    this.timer = setInterval(() => void this.tickAll(), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async world(orgId: string): Promise<OfficeWorld> {
    let w = this.worlds.get(orgId);
    if (!w) {
      w = this.load(orgId);
      this.worlds.set(orgId, w);
      w.then((x) => this.ready.set(orgId, x), () => this.worlds.delete(orgId));
    }
    return await w;
  }

  /** After an admin change: rebuild the static parts, keep the people where they are. */
  async reload(orgId: string): Promise<void> {
    const old = this.worlds.has(orgId) ? await this.world(orgId) : null;
    const next = this.load(orgId);
    this.worlds.set(orgId, next);
    const w = await next;
    this.ready.set(orgId, w);
    if (old) {
      const now = Date.now();
      for (const a of old.avatars.values()) {
        const floor = w.grids.has(a.floorId) ? a.floorId : w.definition.floors[0]!.id;
        const p = w.teleportTarget(floor, { x: a.x, y: a.y }) ?? w.startPoint(a.userId).p;
        a.version += 1;
        w.avatars.set(a.userId, a);
        w.place(a, floor, p, now);
      }
      for (const [u, g] of old.grants) w.grants.set(u, g);
    }
  }

  private async load(orgId: string): Promise<OfficeWorld> {
    return await this.prisma.runWithTenantContext(orgId, async (db) => {
      const office = await ensureOffice(db, orgId);
      return new OfficeWorld(orgId, office.id, office.definition, await loadRooms(db, office.id), await loadDesks(db, office.id), await loadInvites(db), office.proximityRadius);
    });
  }

  /** A loaded world, without loading it (for event hooks). */
  peek(orgId: string): OfficeWorld | null {
    return this.ready.get(orgId) ?? null;
  }

  /** Worlds already loaded (no DB access). */
  async loaded(): Promise<OfficeWorld[]> {
    const out: OfficeWorld[] = [];
    for (const w of this.worlds.values()) { try { out.push(await w); } catch { /* failed load, retried on next use */ } }
    return out;
  }

  private async tickAll(): Promise<void> {
    if (!this.emitter) return;
    const t0 = performance.now();
    const now = Date.now();
    for (const w of await this.loaded()) {
      if (w.avatars.size === 0) continue;
      const r = w.tick(this.emitter, now);
      this.stats.messages += r.messages;
      this.stats.entries += r.entries;
    }
    this.stats.ticks += 1;
    this.stats.maxTickMs = Math.max(this.stats.maxTickMs, performance.now() - t0);
  }
}
