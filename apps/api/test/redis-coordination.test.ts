/**
 * Multi-instance coordination on Redis (ADR 020), written before the implementation: the
 * distributed lock that serialises attendance updates for one person across API tasks, and the
 * shared rate-limit store. Runs against the real Redis used by the test suite (its own DB number).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Redis } from 'ioredis';
import { RedisLock, LockTimeoutError } from '../src/common/redis-lock.ts';
import { RedisThrottlerStorage } from '../src/common/redis-throttler-storage.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const connect = () => new Redis({ host: process.env.REDIS_HOST || 'localhost', port: Number(process.env.REDIS_PORT || 6379), db: 7, maxRetriesPerRequest: 2 });

describe('RedisLock', () => {
  let a: Redis;
  let b: Redis;
  before(async () => { a = connect(); b = connect(); await a.flushdb(); });
  after(async () => { await a.flushdb(); a.disconnect(); b.disconnect(); });

  it('two instances never run the critical section at the same time', async () => {
    const lockA = new RedisLock(a, { ttlMs: 2000, waitMs: 5000 });
    const lockB = new RedisLock(b, { ttlMs: 2000, waitMs: 5000 });
    let inside = 0;
    let maxInside = 0;
    const order: string[] = [];
    const work = (name: string, lock: RedisLock) => lock.run('session:org:user', async () => {
      inside += 1; maxInside = Math.max(maxInside, inside); order.push(`${name}+`);
      await wait(60);
      inside -= 1; order.push(`${name}-`);
    });
    await Promise.all([work('a1', lockA), work('b1', lockB), work('a2', lockA), work('b2', lockB)]);
    assert.equal(maxInside, 1, order.join(' '));
    assert.equal(order.length, 8);
  });

  it('returns the function result and releases on error', async () => {
    const lock = new RedisLock(a, { ttlMs: 2000, waitMs: 1000 });
    assert.equal(await lock.run('k1', async () => 42), 42);
    await assert.rejects(lock.run('k1', async () => { throw new Error('boom'); }), /boom/);
    assert.equal(await a.exists('lock:k1'), 0, 'released after the error');
  });

  it('only the holder can release: an expired holder does not delete the next owner\'s lock', async () => {
    const slow = new RedisLock(a, { ttlMs: 150, waitMs: 2000, renew: false });
    const fast = new RedisLock(b, { ttlMs: 2000, waitMs: 2000 });
    let secondSaw = 0;
    const first = slow.run('k2', async () => { await wait(400); });
    await wait(200); // the first lock has expired (no renewal)
    await fast.run('k2', async () => {
      await wait(300); // the first finishes and "releases" meanwhile
      secondSaw = await b.exists('lock:k2');
    });
    await first;
    assert.equal(secondSaw, 1, 'the second owner\'s lock survived the first owner\'s release');
  });

  it('a long critical section keeps its lock by renewal', async () => {
    // Renewal runs every ttl/3. A 2-CPU CI runner with four test files in parallel can stall the event
    // loop for more than the 133 ms margin a 200 ms TTL leaves, so the TTL is 1 s here (margin 667 ms).
    const holder = new RedisLock(a, { ttlMs: 1000, waitMs: 2000 });
    const other = new RedisLock(b, { ttlMs: 1000, waitMs: 100 });
    const long = holder.run('k3', () => wait(3000));
    await wait(2200); // well past two TTLs
    await assert.rejects(other.run('k3', async () => undefined), LockTimeoutError);
    await long;
  });

  it('gives up after waitMs with LockTimeoutError; a crashed holder frees the lock at its TTL', async () => {
    await a.set('lock:k4', 'someone-else', 'PX', 300);
    const lock = new RedisLock(b, { ttlMs: 1000, waitMs: 100 });
    await assert.rejects(lock.run('k4', async () => undefined), LockTimeoutError);
    const patient = new RedisLock(b, { ttlMs: 1000, waitMs: 1000 });
    assert.equal(await patient.run('k4', async () => 'ok'), 'ok');
  });
});

describe('RedisThrottlerStorage', () => {
  let r: Redis;
  let r2: Redis;
  before(async () => { r = connect(); r2 = connect(); await r.flushdb(); });
  after(async () => { await r.flushdb(); r.disconnect(); r2.disconnect(); });

  it('counts across instances within the window and blocks past the limit', async () => {
    const s1 = new RedisThrottlerStorage(r);
    const s2 = new RedisThrottlerStorage(r2);
    const hits = [];
    for (let i = 0; i < 3; i += 1) hits.push(await (i % 2 ? s2 : s1).increment('ip-1', 60_000, 3, 60_000, 'login'));
    assert.deepEqual(hits.map((h) => [h.totalHits, h.isBlocked]), [[1, false], [2, false], [3, false]]);
    const fourth = await s2.increment('ip-1', 60_000, 3, 60_000, 'login');
    assert.equal(fourth.isBlocked, true);
    assert.ok(fourth.timeToBlockExpire > 0 && fourth.timeToBlockExpire <= 60);
    assert.ok(fourth.timeToExpire > 0 && fourth.timeToExpire <= 60, 'seconds, like the in-memory store');
    assert.equal((await s1.increment('ip-1', 60_000, 3, 60_000, 'login')).isBlocked, true, 'blocked for everyone');
  });

  it('buckets and keys are independent; the window resets after the TTL', async () => {
    const s = new RedisThrottlerStorage(r);
    assert.equal((await s.increment('ip-1', 60_000, 3, 60_000, 'refresh')).totalHits, 1, 'another bucket');
    assert.equal((await s.increment('ip-2', 60_000, 3, 60_000, 'login')).totalHits, 1, 'another key');
    await s.increment('ip-3', 150, 1, 150, 'login');
    assert.equal((await s.increment('ip-3', 150, 1, 150, 'login')).isBlocked, true);
    await wait(400);
    const later = await s.increment('ip-3', 150, 1, 150, 'login');
    assert.deepEqual([later.totalHits, later.isBlocked], [1, false]);
  });
});
