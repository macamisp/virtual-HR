import { Module } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.ts';
import { AttendanceModule } from '../attendance/attendance.module.ts';
import { NotificationsModule } from '../notifications/notifications.module.ts';
import { ChatController } from './chat.controller.ts';
import { ChatService } from './chat.service.ts';

@Module({
  imports: [AttendanceModule, NotificationsModule],
  controllers: [ChatController],
  providers: [PrismaService, ChatService],
})
export class ChatModule {}
