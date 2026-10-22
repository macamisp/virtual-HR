import { AttendanceModule } from '../attendance/attendance.module.ts';
import { Module } from '@nestjs/common';
import { AuthService } from './auth.service.ts';
import { CAPTCHA_VERIFIER, createCaptchaVerifier, WorkspaceService } from './workspace.service.ts';
import { AuthController } from './auth.controller.ts';
import { BREACHED_PASSWORD_CHECKER, createBreachedPasswordChecker } from './breached-password.ts';
import { MailModule } from '../common/mail.module.ts';

@Module({
  imports: [MailModule, AttendanceModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    WorkspaceService,
    { provide: BREACHED_PASSWORD_CHECKER, useFactory: createBreachedPasswordChecker },
    { provide: CAPTCHA_VERIFIER, useFactory: createCaptchaVerifier },
  ],
  exports: [AuthService, WorkspaceService],
})
export class AuthModule {}
