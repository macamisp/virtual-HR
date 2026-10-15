import { Module } from '@nestjs/common';
import { AuthService } from './auth.service.ts';
import { AuthController } from './auth.controller.ts';
import { PrismaService } from '../common/prisma.service.ts';
import { BREACHED_PASSWORD_CHECKER, createBreachedPasswordChecker } from './breached-password.ts';
import { MAIL_TRANSPORT, createMailTransport } from '../common/mailer.ts';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    PrismaService,
    { provide: BREACHED_PASSWORD_CHECKER, useFactory: createBreachedPasswordChecker },
    { provide: MAIL_TRANSPORT, useFactory: createMailTransport },
  ],
  exports: [AuthService],
})
export class AuthModule {}
