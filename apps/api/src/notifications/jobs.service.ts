import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Queue, Worker } from 'bullmq';
import type { ConnectionOptions, Job } from 'bullmq';
import { NotificationEmailSender } from './notifications.service.ts';
import type { EmailDispatcher } from './notifications.service.ts';
import { ScheduledWorkService } from './scheduled-work.service.ts';
import { redisOptions } from '../common/coordination.ts';
import { DocumentScannerService } from '../documents/document-scanner.service.ts';
import { DocumentMaintenanceService } from '../documents/document-maintenance.service.ts';
import { CalendarService } from '../calendar/calendar.service.ts';
import type { ScanDispatcher } from '../documents/scan-dispatcher.ts';
import { RecordingsService } from '../meetings/recordings.service.ts';
import type { RecordingDispatcher } from '../meetings/recording-dispatcher.ts';

export const JOBS_QUEUE = 'hrvo-jobs';

type ScheduledJob = 'task-reminders' | 'carry-over' | 'weekly-summary' | 'attendance-reconcile' | 'attendance-daily-close' | 'presence-retention' | 'timesheet-reminders' | 'document-maintenance' | 'deferred-emails' | 'attendance-alerts' | 'calendar-sync' | 'recording-maintenance' | 'attendance-replay';

/** Repeatable jobs. BullMQ job schedulers are de-duplicated in Redis, so N API instances run each tick once. */
export const SCHEDULES: ReadonlyArray<{ name: ScheduledJob; everyMs?: number; pattern?: string }> = [
  // AC-02: a dropped client must be closed within 30 s of its grace window ending.
  { name: 'attendance-reconcile', everyMs: 15_000 },
  { name: 'task-reminders', everyMs: 5 * 60_000 },
  { name: 'carry-over', everyMs: 15 * 60_000 },
  { name: 'weekly-summary', everyMs: 15 * 60_000 },
  { name: 'attendance-daily-close', everyMs: 15 * 60_000 },
  { name: 'presence-retention', everyMs: 60 * 60_000 },
  { name: 'timesheet-reminders', everyMs: 15 * 60_000 },
  { name: 'document-maintenance', everyMs: 60 * 60_000 },
  { name: 'deferred-emails', everyMs: 60_000 },
  // ADR 019: no-clock-in reminders, manager alerts, mechanical-input scan.
  { name: 'attendance-alerts', everyMs: 5 * 60_000 },
  // ADR 023: Google/Outlook two-way sync.
  { name: 'calendar-sync', everyMs: 5 * 60_000 },
  // ADR 024: unanswered recording requests, stuck processing, retention shredding.
  { name: 'recording-maintenance', everyMs: 5 * 60_000 },
  // ADR 026 (NFR-ACC-004): yesterday's daily totals recomputed and compared, every night at 02:30 UTC.
  { name: 'attendance-replay', pattern: '30 2 * * *' },
];

export function jobsEnabled(): boolean {
  return process.env.JOBS_ENABLED !== 'false';
}

function redisConnection(): ConnectionOptions {
  return {
    // Host, port, password, db (separate databases keep a demo and the tests apart) and TLS.
    ...redisOptions(),
    // Required by BullMQ workers.
    maxRetriesPerRequest: null,
  };
}

/**
 * Scheduled jobs and email delivery on BullMQ/Redis (ADR 007). With JOBS_ENABLED=false
 * (tests, or a deployment that runs jobs elsewhere) nothing touches Redis and emails are
 * sent inline.
 */
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy, EmailDispatcher, ScanDispatcher, RecordingDispatcher {
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private inlineReconcile: NodeJS.Timeout | null = null;

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly sender: NotificationEmailSender,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!jobsEnabled()) {
      // Without Redis nothing would ever close a dropped session (FR-ATT-002). Opt-in for local
      // development and the browser tests: ATTENDANCE_RECONCILE_INLINE_MS runs the reconciler here.
      const everyMs = Number.parseInt(process.env.ATTENDANCE_RECONCILE_INLINE_MS ?? '', 10);
      if (everyMs > 0) {
        this.inlineReconcile = setInterval(() => {
          this.moduleRef.get(ScheduledWorkService, { strict: false }).attendanceReconcile(new Date())
            .catch((err: unknown) => console.error('Inline attendance reconcile failed:', err instanceof Error ? err.message : 'unknown error'));
        }, everyMs);
        this.inlineReconcile.unref();
      }
      return;
    }
    const connection = redisConnection();
    this.queue = new Queue(JOBS_QUEUE, {
      connection,
      defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000 },
    });
    for (const s of SCHEDULES) {
      await this.queue.upsertJobScheduler(s.name, s.pattern ? { pattern: s.pattern, tz: 'UTC' } : { every: s.everyMs! }, { name: s.name });
    }
    this.worker = new Worker(JOBS_QUEUE, (job) => this.process(job), { connection, concurrency: 4 });
    this.worker.on('failed', (job, err) => {
      console.error(`Job ${job?.name ?? '?'} failed (attempt ${job?.attemptsMade ?? 0}):`, err.message);
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.inlineReconcile) clearInterval(this.inlineReconcile);
    await this.worker?.close();
    await this.queue?.close();
  }

  /** Exposed for tests and operations. */
  getQueue(): Queue | null {
    return this.queue;
  }

  async process(job: Job): Promise<unknown> {
    // Resolved lazily: ScheduledWorkService depends on NotificationsService, which depends on this dispatcher.
    const work = this.moduleRef.get(ScheduledWorkService, { strict: false });
    const now = new Date();
    switch (job.name) {
      case 'task-reminders': return await work.taskReminders(now);
      case 'carry-over': return await work.carryOver(now);
      case 'weekly-summary': return await work.weeklySummary(now);
      case 'attendance-reconcile': return await work.attendanceReconcile(now);
      case 'attendance-daily-close': return await work.attendanceDailyClose(now);
      case 'presence-retention': return await work.presenceRetention(now);
      case 'timesheet-reminders': return await work.timesheetReminders(now);
      case 'deferred-emails': return await work.deferredEmails(now);
      case 'attendance-alerts': return await work.attendanceAlerts(now);
      case 'calendar-sync': return await this.moduleRef.get(CalendarService, { strict: false }).syncAll();
      case 'document-maintenance': return await this.moduleRef.get(DocumentMaintenanceService, { strict: false }).run(now);
      case 'attendance-replay': return await work.attendanceReplay(now);
      case 'recording-maintenance': return await this.moduleRef.get(RecordingsService, { strict: false }).maintenance(now);
      case 'recording-process': {
        const data = job.data as { orgId: string; recordingId: string };
        return await this.moduleRef.get(RecordingsService, { strict: false }).process(data.orgId, data.recordingId);
      }
      case 'document-scan': {
        const data = job.data as { orgId: string; versionId: string };
        return await this.moduleRef.get(DocumentScannerService, { strict: false }).process(data.orgId, data.versionId);
      }
      case 'notification-email': {
        const data = job.data as { orgId: string; notificationId: string };
        return await this.sender.send(data.orgId, data.notificationId);
      }
      default:
        throw new Error(`Unknown job ${job.name}`);
    }
  }

  async dispatch(orgId: string, notificationId: string): Promise<void> {
    if (!this.queue) {
      await this.sender.send(orgId, notificationId);
      return;
    }
    await this.queue.add(
      'notification-email',
      { orgId, notificationId },
      // One job per notification; retried with backoff if the mail server is down.
      { jobId: `email-${notificationId}`, attempts: 5, backoff: { type: 'exponential', delay: 30_000 } },
    );
  }

  /** FR-DOC-013: one scan job per version, retried while clamd or storage is unavailable; inline without Redis. */
  async dispatchScan(orgId: string, versionId: string): Promise<void> {
    if (!this.queue) {
      try {
        await this.moduleRef.get(DocumentScannerService, { strict: false }).process(orgId, versionId);
      } catch (err) {
        // Stays PENDING; the hourly document maintenance job retries it.
        console.error('Inline document scan failed:', err instanceof Error ? err.message : 'unknown error');
      }
      return;
    }
    await this.queue.add('document-scan', { orgId, versionId }, { jobId: `scan-${versionId}-${Date.now()}`, attempts: 6, backoff: { type: 'exponential', delay: 20_000 } });
  }

  /** ADR 024: encrypt a finished recording. Without Redis it runs in the background (not awaited). */
  async dispatchRecording(orgId: string, recordingId: string): Promise<void> {
    if (!this.queue) {
      void this.moduleRef.get(RecordingsService, { strict: false }).process(orgId, recordingId)
        .catch((err: unknown) => console.error('Recording processing failed:', err instanceof Error ? err.message : 'unknown error'));
      return;
    }
    await this.queue.add('recording-process', { orgId, recordingId }, { jobId: `recording-${recordingId}-${Date.now()}`, attempts: 6, backoff: { type: 'exponential', delay: 20_000 } });
  }
}
