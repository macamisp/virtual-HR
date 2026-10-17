import { AttendanceModule } from '../attendance/attendance.module.ts';
import { Module } from '@nestjs/common';
import { AuthService } from './auth.service.ts';
import { AuthController } from './auth.controller.ts';
import { BREACHED_PASSWORD_CHECKER, createBreachedPasswordChecker } from './breached-password.ts';
import { MailModule } from '../common/mail.module.ts';

@Module({
  imports: [MailModule, AttendanceModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    { provide: BREACHED_PASSWORD_CHECKER, useFactory: createBreachedPasswordChecker },
  ],
  exports: [AuthService],
})
export class AuthModule {}
