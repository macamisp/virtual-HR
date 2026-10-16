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

/** Media (LiveKit tokens, webhooks) and meetings live together: a meeting token is a media token (ADR 016). */
@Module({
  imports: [MailModule, AttendanceModule, TasksModule, OfficeModule],
  controllers: [MeetingsController, MediaController, LiveKitWebhookController],
  providers: [PrismaService, MediaService, MeetingsService],
  exports: [MeetingsService, MediaService],
})
export class MeetingsModule {}
