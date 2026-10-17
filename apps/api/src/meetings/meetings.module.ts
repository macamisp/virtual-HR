import { Module } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.ts';
import { MailModule } from '../common/mail.module.ts';
import { AttendanceModule } from '../attendance/attendance.module.ts';
import { TasksModule } from '../tasks/tasks.module.ts';
import { OfficeModule } from '../office/office.module.ts';
import { MediaService } from '../media/media.service.ts';
import { LiveKitWebhookController, MediaController } from '../media/media.controller.ts';
import { MeetingsController } from './meetings.controller.ts';
import { MeetingsService } from './meetings.service.ts';
import { RecordingsService } from './recordings.service.ts';
import { RecordingsController } from './recordings.controller.ts';
import { RECORDING_DISPATCHER } from './recording-dispatcher.ts';
import { NotificationsModule } from '../notifications/notifications.module.ts';
import { JobsService } from '../notifications/jobs.service.ts';
import { KEY_PROVIDER, keyProviderFromEnv } from '../documents/crypto.ts';
import { OBJECT_STORE, objectStoreFromEnv } from '../documents/object-store.ts';

/** Media (LiveKit tokens, webhooks), meetings and their recordings live together: a meeting token is a media token (ADR 016, 024). */
@Module({
  imports: [MailModule, AttendanceModule, TasksModule, OfficeModule, NotificationsModule],
  controllers: [MeetingsController, MediaController, LiveKitWebhookController, RecordingsController],
  providers: [
    PrismaService, MediaService, MeetingsService, RecordingsService,
    // FR-MEET-007: recordings are encrypted like documents (same key provider and bucket, ADR 024).
    { provide: KEY_PROVIDER, useFactory: () => keyProviderFromEnv() },
    { provide: OBJECT_STORE, useFactory: () => objectStoreFromEnv() },
    { provide: RECORDING_DISPATCHER, useExisting: JobsService },
  ],
  exports: [MeetingsService, MediaService, RecordingsService],
})
export class MeetingsModule {}
