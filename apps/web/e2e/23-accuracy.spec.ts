import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import pg from 'pg';
import { ORG_ID, PASSWORD, USERS, adminPool } from './fixtures';
import { passNoticeGate, signIn, signOut, traceSockets } from './helpers';

/**
 * SRS 6.5 accuracy proofs, run against the real app, API and Postgres with the server's own clock
 * (ADR 026). Every measurement is printed, so CI output carries the numbers.
 *
 *  NFR-ACC-001  clock-in within 5 s of the first real activity in at least 99% of 100 runs
 *  NFR-ACC-002  clock-out within 30 s of the real last activity: logout, tab close, network loss
 *  NFR-ACC-003  two devices at once: counted time never exceeds the wall-clock union
 *
 * The e2e organisation uses the shortest windows SRS 6.4 allows (grace 30 s, silence 60 s) and
 * the API runs its reconciler every 5 s (ATTENDANCE_RECONCILE_INLINE_MS), so the slow paths fit
 * the time budget. The heartbeat interval is the real 30 s, which bounds the clock-out error.
 */
interface Row { id: string; status: string; clock_in_at: Date; clock_out_at: Date | null; clock_out_source: string | null; last_heartbeat_at: Date; net_seconds: number; active_seconds: number; flags: string[] }

const CLOCK_IN_RUNS = 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const latest = async (pool: pg.Pool): Promise<Row | null> =>
  (await pool.query<Row>(`SELECT id, status, clock_in_at, clock_out_at, clock_out_source, last_heartbeat_at, net_seconds, active_seconds, flags FROM attendance_sessions WHERE org_id = $1 AND user_id = $2 ORDER BY clock_in_at DESC LIMIT 1`, [ORG_ID, USERS.worker.id])).rows[0] ?? null;
async function untilClosed(pool: pg.Pool, sessionId: string, budgetMs: number): Promise<Row> {
  const t0 = Date.now();
  for (;;) {
    const r = (await pool.query<Row>(`SELECT id, status, clock_in_at, clock_out_at, clock_out_source, last_heartbeat_at, net_seconds, active_seconds, flags FROM attendance_sessions WHERE id = $1`, [sessionId])).rows[0];
    if (r?.status === 'CLOSED') return r;
    if (Date.now() - t0 > budgetMs) throw new Error(`session ${sessionId} still ${r?.status} after ${budgetMs} ms`);
    await sleep(500);
  }
}
/** Real input every 2 s until stopped; returns the time of the last injected input. */
function keepActive(page: Page): { stop: () => number } {
  let last = Date.now();
  let on = true;
  void (async () => {
    let x = 100;
    while (on) {
      try { await page.mouse.move(x, 200); last = Date.now(); } catch { break; }
      x = x === 100 ? 300 : 100;
      await sleep(2000);
    }
  })();
  return { stop: () => { on = false; return last; } };
}
async function freshWorker(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, USERS.worker.email);
  await passNoticeGate(page);
  await expect(page.getByTestId('tracking-badge')).toHaveText(/Tracking: Active since/);
  return { ctx, page };
}
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)]!;

test.describe.serial('Accuracy proofs (SRS 6.5, NFR-ACC-001..003)', () => {
  let pool: pg.Pool;
  test.beforeAll(async () => {
    pool = adminPool();
    // Start from no live logins: a login an earlier spec abandoned without signing out counts as
    // live for the missed-heartbeat window (ADR 025) and would keep the person clocked in.
    await pool.query(`DELETE FROM session_secrets WHERE org_id = $1 AND session_id IN (SELECT id::text FROM auth_sessions WHERE user_id = $2)`, [ORG_ID, USERS.worker.id]);
    await pool.query(`UPDATE auth_sessions SET is_revoked = true, revoked_reason = 'LOGOUT', updated_at = now() WHERE org_id = $1 AND user_id = $2 AND NOT is_revoked`, [ORG_ID, USERS.worker.id]);
    await pool.query(`UPDATE attendance_sessions SET status = 'CLOSED', clock_out_at = last_heartbeat_at, clock_out_source = 'TIMEOUT' WHERE org_id = $1 AND user_id = $2 AND status = 'OPEN'`, [ORG_ID, USERS.worker.id]);
  });
  test.afterAll(async () => { await pool.end(); });

  test('NFR-ACC-001: clock-in within 5 s of the first activity, 100 sign-ins', async ({ page }) => {
    test.setTimeout(900_000);
    traceSockets(page);
    if (process.env.E2E_TRACE) {
      page.on('response', (r) => { if (r.url().includes('/attendance/me/today')) void r.text().then((b) => console.log(`today ${r.status()} ${b.slice(0, 80)}`)).catch(() => undefined); });
    }
    const deltas: number[] = [];
    for (let i = 0; i < CLOCK_IN_RUNS; i += 1) {
      await page.goto('/login');
      await page.getByLabel('Email').fill(USERS.worker.email);
      await page.getByLabel('Password').fill(PASSWORD);
      // The sign-in click is the first real activity of this run (the heartbeat hook counts it).
      let t0 = Date.now();
      await page.getByRole('button', { name: 'Sign in' }).click();
      const accept = page.getByRole('button', { name: 'I have read and accept this notice' });
      const badge = page.getByTestId('tracking-badge');
      await expect(accept.or(badge)).toBeVisible();
      if (await accept.isVisible()) { t0 = Date.now(); await accept.click(); }
      await expect(badge).toHaveText(/Tracking: Active since/, { timeout: 15_000 });
      let row: Row | null = null;
      await expect.poll(async () => { row = await latest(pool); return row?.status; }).toBe('OPEN');
      const delta = new Date(row!.clock_in_at).getTime() - t0;
      deltas.push(delta);
      console.log(`NFR-ACC-001 run ${i + 1}/${CLOCK_IN_RUNS}: ${delta} ms`);
      expect(delta).toBeGreaterThanOrEqual(0);
      await signOut(page);
      await untilClosed(pool, row!.id, 5_000); // ADR 025: logout closes at once
      // A person does not sign in again within the same second; pacing also keeps the per-user
      // request rate human, so the measurement is of the clock-in, not of a rate limiter.
      await sleep(2_500);
    }
    const within = deltas.filter((d) => d <= 5_000).length;
    console.log(`NFR-ACC-001 clock-in after first activity (ms): ${deltas.join(' ')} | p50 ${pct(deltas, 50)} | p99 ${pct(deltas, 99)} | max ${Math.max(...deltas)} | ${within}/${deltas.length} within 5 s`);
    expect(within / deltas.length).toBeGreaterThanOrEqual(0.99);
  });

  test('NFR-ACC-002: clock-out within 30 s of the last activity for logout, tab close and network loss', async ({ browser }) => {
    test.setTimeout(420_000);
    const results: Array<{ scenario: string; source: string | null; errorS: number; detectS: number }> = [];

    // Logout: closes at once, at the last heartbeat (ADR 025).
    {
      const { ctx, page } = await freshWorker(browser);
      const open = (await latest(pool))!;
      const active = keepActive(page);
      await sleep(35_000);
      const lastActivity = active.stop();
      const t0 = Date.now();
      await signOut(page);
      const row = await untilClosed(pool, open.id, 10_000);
      results.push({ scenario: 'logout', source: row.clock_out_source, errorS: (lastActivity - new Date(row.clock_out_at!).getTime()) / 1000, detectS: (Date.now() - t0) / 1000 });
      await ctx.close();
    }
    // Tab close: socket disconnect, grace window (30 s here), reconciler closes at the last heartbeat.
    {
      const { ctx, page } = await freshWorker(browser);
      const open = (await latest(pool))!;
      const active = keepActive(page);
      await sleep(35_000);
      const lastActivity = active.stop();
      const t0 = Date.now();
      await ctx.close();
      const row = await untilClosed(pool, open.id, 90_000);
      results.push({ scenario: 'tab close', source: row.clock_out_source, errorS: (lastActivity - new Date(row.clock_out_at!).getTime()) / 1000, detectS: (Date.now() - t0) / 1000 });
    }
    // Network loss: the browser stays open but nothing reaches the server; silence (60 s here) or
    // the detected disconnect plus grace ends the session at the last heartbeat.
    {
      const { ctx, page } = await freshWorker(browser);
      const open = (await latest(pool))!;
      const active = keepActive(page);
      await sleep(35_000);
      const lastActivity = active.stop();
      const t0 = Date.now();
      await ctx.setOffline(true);
      const row = await untilClosed(pool, open.id, 150_000);
      results.push({ scenario: 'network loss', source: row.clock_out_source, errorS: (lastActivity - new Date(row.clock_out_at!).getTime()) / 1000, detectS: (Date.now() - t0) / 1000 });
      await ctx.close();
    }
    for (const r of results) console.log(`NFR-ACC-002 ${r.scenario}: clock_out_at is ${r.errorS.toFixed(1)} s before the last activity (source ${r.source}); session closed ${r.detectS.toFixed(1)} s after the event`);
    for (const r of results) {
      expect(Math.abs(r.errorS)).toBeLessThanOrEqual(30);

    }
    expect(results[0]!.detectS).toBeLessThan(1);
    expect(results[1]!.source).toBe('DISCONNECT');
    expect(['DISCONNECT', 'TIMEOUT']).toContain(results[2]!.source);
  });

  test('NFR-ACC-003: two devices at once never count more than the wall clock', async ({ browser }) => {
    test.setTimeout(240_000);
    const a = await freshWorker(browser);
    const b = await freshWorker(browser);
    const activeA = keepActive(a.page);
    const activeB = keepActive(b.page);
    await sleep(70_000);
    activeA.stop();
    activeB.stop();
    const row = (await latest(pool))!;
    const spanS = (new Date(row.last_heartbeat_at).getTime() - new Date(row.clock_in_at).getTime()) / 1000;
    console.log(`NFR-ACC-003 two devices: wall-clock span ${spanS.toFixed(0)} s | counted net ${row.net_seconds} s | raw active counters from both devices ${row.active_seconds} s | flags ${row.flags.join(',')}`);
    expect(row.flags).toContain('MULTI_DEVICE');
    const sessions = await pool.query(`SELECT count(*)::int AS n FROM attendance_sessions WHERE org_id = $1 AND user_id = $2 AND status = 'OPEN'`, [ORG_ID, USERS.worker.id]);
    expect(sessions.rows[0].n).toBe(1);
    const segments = (await pool.query<{ started_at: Date; ended_at: Date | null }>(`SELECT started_at, ended_at FROM attendance_segments WHERE org_id = $1 AND session_id = $2 AND state IN ('ACTIVE', 'IN_MEETING') ORDER BY started_at`, [ORG_ID, row.id])).rows;
    let unionMs = 0;
    let until = 0;
    for (const segment of segments) {
      const start = segment.started_at.getTime();
      const end = segment.ended_at?.getTime() ?? row.last_heartbeat_at.getTime();
      unionMs += Math.max(0, end - Math.max(start, until));
      until = Math.max(until, end);
    }
    const unionSeconds = Math.round(unionMs / 1000);
    console.log(`NFR-ACC-003 segment union ${unionSeconds} s = net ${row.net_seconds} s; difference ${row.net_seconds - unionSeconds} s`);
    expect(row.net_seconds).toBe(unionSeconds);
    // Both logins sign out: a login that merely vanished counts as live for the missed-heartbeat
    // window (ADR 025) and would keep the person clocked in for the next spec.
    await signOut(a.page);
    await signOut(b.page);
    await a.ctx.close();
    await b.ctx.close();
  });
});
