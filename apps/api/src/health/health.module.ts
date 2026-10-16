import { Module } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.ts';
import { CoordinationShutdown } from '../common/coordination.ts';
import { HealthController } from './health.controller.ts';

@Module({ controllers: [HealthController], providers: [PrismaService, CoordinationShutdown] })
export class HealthModule {}
