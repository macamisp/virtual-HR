import { Module } from '@nestjs/common';
import { UsersService } from './users.service.ts';
import { UsersController } from './users.controller.ts';
import { PrismaService } from '../common/prisma.service.ts';

@Module({
  controllers: [UsersController],
  providers: [UsersService, PrismaService],
  exports: [UsersService],
})
export class UsersModule {}
