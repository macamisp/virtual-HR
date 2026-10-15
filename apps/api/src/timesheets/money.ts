/**
 * FR-TS-009 payable amount. Money never touches a JS number: amounts are bigint minor units
 * (cents), multipliers bigint hundredths, and intermediate results exact fractions that are
 * rounded half-up to cents once per line. The total is the sum of the rounded lines, so a
 * breakdown always adds up to the amount shown.
 *
 * Rules agreed with the product owner (ADR 008):
 *  - HOURLY: minutes x rate / 60. Per ISO week, minutes above the weekly cap (profile cap,
 *    else schedule capacity, else 40 h) are overtime x multiplier. Overtime falls on the
 *    chronologically last minutes of the week; the whole week counts towards the cap even
 *    when it straddles two periods, but only this period's minutes are paid here.
 *  - DAILY: each day with time pays the day rate (weighted by minutes when projects have
 *    different rates); minutes beyond 8 h that day are overtime at rate / 8 x multiplier.
 *  - FIXED: the rate per period; no overtime, no project overrides.
 */
import { addDaysIso, weekStartOf } from '../planning/planning-rules.ts';

export type RateType = 'HOURLY' | 'DAILY' | 'FIXED';

export interface PayableEntry {
  id: string;
  workDate: string;
  minutes: number;
  projectId: string | null;
  startedAt: Date | null;
}

export interface PayableInput {
  rateType: RateType;
  rate: string;
  overtimeMultiplier: string;
  weeklyCapMinutes: number;
  projectRates: ReadonlyMap<string, string>;
  periodStart: string;
  periodEnd: string;
  /** Entries of every ISO week touching the period (earlier days count towards the cap). */
  entries: readonly PayableEntry[];
}

export interface PayableLine {
  projectId: string | null;
  rate: string;
  regularMinutes: number;
  overtimeMinutes: number;
  amount: string;
}

export interface PayableResult {
  amount: string;
  regularMinutes: number;
  overtimeMinutes: number;
  days: number;
  lines: PayableLine[];
}

const MONEY = /^(0|[1-9]\d{0,9})(\.\d{1,2})?$/; // numeric(12,2)
const MULTIPLIER = /^[1-9](\.\d{1,2})?$/; // 1.00 .. 9.99
/** numeric(14,2): below 10^12 major units. */
const MAX_AMOUNT_CENTS = 10n ** 14n;
const DEFAULT_CAP_MINUTES = 40 * 60;
const DAY_MINUTES = 8 * 60;

function parseScaled(value: string, pattern: RegExp, what: string): bigint {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Invalid ${what}: ${JSON.stringify(value)}`);
  const [whole, frac = ''] = value.split('.');
  return BigInt(whole!) * 100n + BigInt(frac.padEnd(2, '0'));
}

/** "25.5" -> 2550n. Non-negative, at most 10 integer digits and 2 decimals. */
export function parseMoney(value: string): bigint {
  return parseScaled(value, MONEY, 'amount');
}

/** "1.5" -> 150n. Between 1.00 and 9.99. */
export function parseMultiplier(value: string): bigint {
  return parseScaled(value, MULTIPLIER, 'overtime multiplier');
}

export function formatMoney(cents: bigint): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  return `${neg ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

// ---- exact fractions

interface Frac {
  n: bigint;
  d: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a < 0n ? -a : a;
}

function frac(n: bigint, d: bigint): Frac {
  const g = gcd(n, d) || 1n;
  return { n: n / g, d: d / g };
}

function add(a: Frac, b: Frac): Frac {
  return frac(a.n * b.d + b.n * a.d, a.d * b.d);
}

/** Half-up rounding of a non-negative fraction to an integer. */
function roundHalfUp(f: Frac): bigint {
  return (2n * f.n + f.d) / (2n * f.d);
}

// ---- payable

interface Acc {
  projectId: string | null;
  rate: bigint;
  regular: number;
  overtime: number;
  value: Frac;
}

/** Chronological order: day, then start time (untimed manual entries last), then id. */
function chronological(a: PayableEntry, b: PayableEntry): number {
  if (a.workDate !== b.workDate) return a.workDate < b.workDate ? -1 : 1;
  const ta = a.startedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const tb = b.startedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function computePayable(input: PayableInput): PayableResult {
  const baseRate = parseMoney(input.rate);
  const multiplier = parseMultiplier(input.overtimeMultiplier);
  const rates = new Map<string, bigint>();
  for (const [projectId, r] of input.projectRates) rates.set(projectId, parseMoney(r));
  const rateFor = (projectId: string | null): bigint => (projectId !== null ? rates.get(projectId) : undefined) ?? baseRate;
  const inPeriod = (date: string): boolean => date >= input.periodStart && date <= input.periodEnd;

  const lines = new Map<string, Acc>();
  const line = (projectId: string | null, rate: bigint): Acc => {
    const key = projectId ?? '';
    let acc = lines.get(key);
    if (!acc) {
      acc = { projectId, rate, regular: 0, overtime: 0, value: { n: 0n, d: 1n } };
      lines.set(key, acc);
    }
    return acc;
  };

  const sorted = [...input.entries].filter((x) => x.minutes > 0).sort(chronological);
  let days = 0;

  if (input.rateType === 'FIXED') {
    const acc = line(null, baseRate);
    for (const x of sorted) if (inPeriod(x.workDate)) acc.regular += x.minutes;
    acc.value = { n: baseRate, d: 1n };
    days = new Set(sorted.filter((x) => inPeriod(x.workDate)).map((x) => x.workDate)).size;
  } else if (input.rateType === 'HOURLY') {
    const cap = input.weeklyCapMinutes > 0 ? input.weeklyCapMinutes : DEFAULT_CAP_MINUTES;
    const used = new Map<string, number>();
    for (const x of sorted) {
      const week = weekStartOf(x.workDate);
      const before = used.get(week) ?? 0;
      used.set(week, before + x.minutes);
      if (!inPeriod(x.workDate)) continue;
      const regular = Math.min(x.minutes, Math.max(0, cap - before));
      const overtime = x.minutes - regular;
      const rate = rateFor(x.projectId);
      const acc = line(x.projectId, rate);
      acc.regular += regular;
      acc.overtime += overtime;
      // cents = rate * (regular * 100 + overtime * multiplier) / (60 * 100)
      acc.value = add(acc.value, frac(rate * (BigInt(regular) * 100n + BigInt(overtime) * multiplier), 6000n));
    }
    days = new Set(sorted.filter((x) => inPeriod(x.workDate)).map((x) => x.workDate)).size;
  } else {
    const byDay = new Map<string, PayableEntry[]>();
    for (const x of sorted) {
      if (!inPeriod(x.workDate)) continue;
      const list = byDay.get(x.workDate) ?? [];
      list.push(x);
      byDay.set(x.workDate, list);
    }
    for (const list of byDay.values()) {
      days += 1;
      const total = BigInt(list.reduce((s, x) => s + x.minutes, 0));
      let used = 0;
      for (const x of list) {
        const rate = rateFor(x.projectId);
        const regular = Math.min(x.minutes, Math.max(0, DAY_MINUTES - used));
        const overtime = x.minutes - regular;
        used += x.minutes;
        const acc = line(x.projectId, rate);
        acc.regular += regular;
        acc.overtime += overtime;
        // Share of the day rate: rate * minutes / day total.
        acc.value = add(acc.value, frac(rate * BigInt(x.minutes), total));
        // Overtime: rate / 8 per hour x multiplier -> rate * overtime * multiplier / (8 * 60 * 100).
        if (overtime > 0) acc.value = add(acc.value, frac(rate * BigInt(overtime) * multiplier, 48000n));
      }
    }
  }

  let total = 0n;
  const out: PayableLine[] = [];
  for (const acc of lines.values()) {
    const cents = roundHalfUp(acc.value);
    total += cents;
    out.push({ projectId: acc.projectId, rate: formatMoney(acc.rate), regularMinutes: acc.regular, overtimeMinutes: acc.overtime, amount: formatMoney(cents) });
  }
  if (total >= MAX_AMOUNT_CENTS) throw new Error('Payable amount too large for a timesheet');
  out.sort((a, b) => (a.projectId ?? '').localeCompare(b.projectId ?? ''));
  return {
    amount: formatMoney(total),
    regularMinutes: out.reduce((s, l) => s + l.regularMinutes, 0),
    overtimeMinutes: out.reduce((s, l) => s + l.overtimeMinutes, 0),
    days,
    lines: out,
  };
}

/** Every ISO week touching [start, end]: the range of entries the payable rule needs. */
export function payableEntryRange(periodStart: string, periodEnd: string): { from: string; to: string } {
  return { from: weekStartOf(periodStart), to: addDaysIso(weekStartOf(periodEnd), 6) };
}
