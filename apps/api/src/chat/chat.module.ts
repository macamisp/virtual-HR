import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.ts';
import { NotificationsModule } from '../notifications/notifications.module.ts';
import { ChatController } from './chat.controller.ts';
import { ChatService } from './chat.service.ts';

@Module({
  imports: [AttendanceModule, NotificationsModule],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
