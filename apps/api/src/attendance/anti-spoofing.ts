/**
 * Anti-spoofing heuristics and the network policy (FR-ATT-017, FR-ATT-018; ADR 019).
 *
 * Pure functions. Each returns reasons for HUMAN REVIEW only: no check here ever changes recorded
 * time, blocks a heartbeat or penalises anyone (SRS: "never penalised automatically").
 */
import { isIP } from 'node:net';
import { COUNTRY_REFERENCE } from './country-reference.ts';

// ------------------------------------------------------------------ IP ranges

type Parsed = { family: 4 | 6; value: bigint };

function parseIp(raw: string): Parsed | null {
  let ip = raw.trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1]!;
  const kind = isIP(ip);
  if (kind === 4) {
    const parts = ip.split('.').map(Number);
    return { family: 4, value: parts.reduce((acc, p) => (acc << 8n) + BigInt(p), 0n) };
  }
  if (kind === 6) {
    const [head, tail] = ip.split('::') as [string, string | undefined];
    const h = head ? head.split(':') : [];
    const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
    const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
    if (groups.length !== 8) return null;
    return { family: 6, value: groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g || '0', 16)), 0n) };
  }
  return null;
}

/** `10.0.0.0/8`, `2001:db8::/32`, or a single address. null when malformed. */
export function parseCidr(cidr: string): { family: 4 | 6; base: bigint; bits: number } | null {
  const [addr, len] = cidr.trim().split('/') as [string, string | undefined];
  const ip = parseIp(addr);
  if (!ip) return null;
  const max = ip.family === 4 ? 32 : 128;
  const bits = len === undefined ? max : /^\d{1,3}$/.test(len) ? Number(len) : NaN;
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null;
  const shift = BigInt(max - bits);
  return { family: ip.family, base: (ip.value >> shift) << shift, bits };
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const a = parseIp(ip);
  const c = parseCidr(cidr);
  if (!a || !c || a.family !== c.family) return false;
  const shift = BigInt((a.family === 4 ? 32 : 128) - c.bits);
  return (a.value >> shift) << shift === c.base;
}

/** An empty list allows every address. */
export function ipAllowed(ip: string, cidrs: readonly string[]): boolean {
  return cidrs.length === 0 || cidrs.some((c) => ipInCidr(ip, c));
}

// ------------------------------------------------------------------ network policy (FR-ATT-018)

export type NetworkReason = 'IP_NOT_ALLOWED' | 'COUNTRY_NOT_ALLOWED' | 'ANONYMIZER';
export interface NetworkPolicy { allowedCidrs: readonly string[]; allowedCountries: readonly string[] }

/** Cloudflare marks Tor exits as T1; an unknown country (null, XX) is no evidence either way. */
export function networkViolations(where: { ip: string; country: string | null }, policy: NetworkPolicy): NetworkReason[] {
  const out: NetworkReason[] = [];
  if (where.country === 'T1') out.push('ANONYMIZER');
  if (!ipAllowed(where.ip, policy.allowedCidrs)) out.push('IP_NOT_ALLOWED');
  const known = where.country && /^[A-Z]{2}$/.test(where.country) && where.country !== 'XX' && where.country !== 'T1';
  if (policy.allowedCountries.length && known && !policy.allowedCountries.includes(where.country!)) out.push('COUNTRY_NOT_ALLOWED');
  return out;
}

// ------------------------------------------------------------------ impossible travel

const toRad = (d: number) => (d * Math.PI) / 180;
function haversineKm(a: readonly [number, number], b: readonly [number, number]): number {
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Distance between two countries' reference points, null when either is unknown. */
export function countryKm(a: string, b: string): number | null {
  if (a === b) return 0;
  const ra = COUNTRY_REFERENCE[a];
  const rb = COUNTRY_REFERENCE[b];
  if (!ra || !rb) return null;
  return Math.round(haversineKm([ra[0], ra[1]], [rb[0], rb[1]]));
}

const radiusKm = (code: string) => Math.sqrt(((COUNTRY_REFERENCE[code]?.[2] ?? 0) * 1000) / Math.PI);

export interface Sighting { country: string | null; at: Date }

/**
 * Flags two sightings that would need faster than `maxKmh` travel. The distance allows for the
 * size of both countries (minus each radius) and anything under `minKm` is ignored, so large
 * neighbours, VPN exits and roaming do not flag.
 */
export function impossibleTravel(prev: Sighting, next: Sighting, maxKmh = 1000, minKm = 500): { km: number; kmh: number; from: string; to: string } | null {
  if (!prev.country || !next.country || prev.country === next.country) return null;
  const centre = countryKm(prev.country, next.country);
  if (centre === null) return null;
  const km = Math.round(Math.max(0, centre - radiusKm(prev.country) - radiusKm(next.country)));
  if (km < minKm) return null;
  const hours = Math.max(Math.abs(next.at.getTime() - prev.at.getTime()) / 3600_000, 1 / 60);
  const kmh = Math.round(km / hours);
  return kmh > maxKmh ? { km, kmh, from: prev.country, to: next.country } : null;
}

// ------------------------------------------------------------------ mechanical input

export interface IntervalSample { activeSeconds: number; idleSeconds: number; tabVisible: boolean; windowFocused: boolean; source: 'WEB' | 'AGENT' }
export type PatternReason = 'UNBROKEN_FULL_ACTIVITY' | 'PERIODIC_ACTIVITY' | 'ACTIVITY_WITHOUT_FOCUS';

export interface PatternConfig {
  /** Consecutive intervals with input in every second (360 × 30 s = 3 h). */
  unbrokenIntervals: number;
  /** Minimum identical, evenly spaced bursts in an otherwise idle stretch. */
  periodicBursts: number;
  /** Browser intervals with input while neither focused nor visible. */
  blindIntervals: number;
}
export const DEFAULT_PATTERN_CONFIG: PatternConfig = { unbrokenIntervals: 360, periodicBursts: 12, blindIntervals: 10 };

/** Heuristics over the counters only (no input content exists to inspect). Oldest sample first. */
export function mechanicalPatterns(samples: readonly IntervalSample[], cfg: PatternConfig = DEFAULT_PATTERN_CONFIG): PatternReason[] {
  const out: PatternReason[] = [];

  let run = 0;
  let longest = 0;
  for (const s of samples) {
    run = s.activeSeconds >= 30 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  if (longest >= cfg.unbrokenIntervals) out.push('UNBROKEN_FULL_ACTIVITY');

  // Jiggler: short bursts of the same size at exactly the same spacing, nothing in between.
  const bursts = samples.flatMap((s, i) => (s.activeSeconds > 0 ? [{ i, a: s.activeSeconds }] : []));
  if (bursts.length >= cfg.periodicBursts && bursts.every((b) => b.a < 30)) {
    const gaps = bursts.slice(1).map((b, k) => b.i - bursts[k]!.i);
    const same = gaps.every((g) => g === gaps[0]) && bursts.every((b) => b.a === bursts[0]!.a);
    if (same && gaps[0]! >= 2) out.push('PERIODIC_ACTIVITY');
  }

  const blind = samples.filter((s) => s.source === 'WEB' && s.activeSeconds > 0 && !s.windowFocused && !s.tabVisible).length;
  if (blind >= cfg.blindIntervals) out.push('ACTIVITY_WITHOUT_FOCUS');
  return out;
}
