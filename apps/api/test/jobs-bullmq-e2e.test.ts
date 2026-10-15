/**
 * BullMQ wiring on a real Redis (ADR 007): job schedulers are registered and notification
 * emails are delivered through the queue by the worker.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { Queue } from 'bullmq';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { MAIL_TRANSPORT, InMemoryMailTransport } from '../src/common/mailer.ts';
import { JOBS_QUEUE, JobsService, SCHEDULES } from '../src/notifications/jobs.service.ts';

const ORG = '11110000-0000-4000-8000-0000000000b1';
const PASSWORD = 'ComplexPassword123!';
const LEAD = { id: '11110000-0000-4000-8000-0000000000b2', email: 'lead@bull.test' };
const EMP = { id: '11110000-0000-4000-8000-0000000000b3', email: 'emp@bull.test' };
const connection = { host: process.env.REDIS_HOST || 'localhost', port: Number(process.env.REDIS_PORT || 6379), maxRetriesPerRequest: null };

describe('BullMQ jobs (scheduler + email delivery)', { concurrency: false }, () => {
  let app: INestApplication;
  let adminPool: pg.Pool;
  let previous: string | undefined;

  before(async () => {
    previous = process.env.JOBS_ENABLED;
    process.env.JOBS_ENABLED = 'true';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.RATE_LIMIT_LOGIN = '1000';
    // Start from a clean queue so earlier runs do not interfere.
    const q = new Queue(JOBS_QUEUE, { connection });
    await q.obliterate({ force: true });
    await q.close();

    adminPool = new pg.Pool({
      host: process.env.PGHOST || 'localhost',
      port: Number(process.env.PGPORT || 5433),
      database: process.env.PGDATABASE || 'hrvo_dev',
      user: process.env.PGADMIN_USER || 'postgres',
      password: process.env.PGADMIN_PASSWORD || 'postgres',
    });
    await adminPool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Bull Ltd', 'bull-e2e')`, [ORG]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    await adminPool.query(
      `INSERT INTO users (id, org_id, email, display_name, role, password_hash, status) VALUES
       ($1, $3, $4, 'Lead', 'TEAM_LEAD', $6, 'ACTIVE'), ($2, $3, $5, 'Emp', 'EMPLOYEE', $6, 'ACTIVE')`,
      [LEAD.id, EMP.id, ORG, LEAD.email, EMP.email, hash],
    );
    await adminPool.query(`UPDATE users SET manager_id = $1 WHERE id = $2`, [LEAD.id, EMP.id]);

    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(3091);
  });

  after(async () => {
    await app?.close();
    const q = new Queue(JOBS_QUEUE, { connection });
    await q.obliterate({ force: true });
    await q.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await adminPool.end();
    if (previous === undefined) delete process.env.JOBS_ENABLED;
    else process.env.JOBS_ENABLED = previous;
  });

  it('registers every repeatable job scheduler', async () => {
    const queue = app.get(JobsService).getQueue();
    assert.ok(queue, 'jobs are enabled');
    const schedulers = await queue.getJobSchedulers();
    assert.deepEqual(new Set(schedulers.map((s) => s.key ?? s.name)), new Set(SCHEDULES.map((s) => s.name)));
    for (const s of SCHEDULES) {
      const found = schedulers.find((x) => (x.key ?? x.name) === s.name);
      assert.equal(Number(found?.every), s.everyMs, s.name);
    }
  });

  it('delivers notification emails through the queue worker', async () => {
    const login = await fetch('http://localhost:3091/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: LEAD.email, password: PASSWORD }),
    });
    const { accessToken } = (await login.json()) as { accessToken: string };
    const res = await fetch('http://localhost:3091/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ title: 'Queue me', assigneeId: EMP.id }),
    });
    assert.equal(res.status, 201);
    const outbox = app.get<InMemoryMailTransport>(MAIL_TRANSPORT, { strict: false });

    const deadline = Date.now() + 15_000;
    let emailedAt: Date | null = null;
    let notificationId = '';
    while (Date.now() < deadline) {
      const row = await adminPool.query(`SELECT id, emailed_at FROM notifications WHERE user_id = $1 AND type = 'TASK_ASSIGNED'`, [EMP.id]);
      notificationId = row.rows[0]?.id ?? '';
      emailedAt = row.rows[0]?.emailed_at ?? null;
      if (emailedAt) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(emailedAt, 'the worker sent the email');
    assert.ok(outbox.outbox.some((m) => m.to === EMP.email && m.subject.includes('New task: Queue me')));
    const job = await app.get(JobsService).getQueue()!.getJob(`email-${notificationId}`);
    assert.ok(job, 'sent as a queue job with a per-notification job id');
  });
});
