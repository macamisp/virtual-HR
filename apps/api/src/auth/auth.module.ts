import { Module } from '@nestjs/common';
import { AuthService } from './auth.service.ts';
import { AuthController } from './auth.controller.ts';
import { PrismaService } from '../common/prisma.service.ts';
import { BREACHED_PASSWORD_CHECKER, createBreachedPasswordChecker } from './breached-password.ts';
import { MailModule } from '../common/mail.module.ts';

@Module({
  imports: [MailModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    PrismaService,
    { provide: BREACHED_PASSWORD_CHECKER, useFactory: createBreachedPasswordChecker },
  ],
  exports: [AuthService],
})
export class AuthModule {}
