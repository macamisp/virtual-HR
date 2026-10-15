import { Module } from '@nestjs/common';
import { AuthService } from './auth.service.ts';
import { AuthController } from './auth.controller.ts';
import { PrismaService } from '../common/prisma.service.ts';

@Module({
  controllers: [AuthController],
  providers: [AuthService, PrismaService],
  exports: [AuthService],
})
export class AuthModule {}
