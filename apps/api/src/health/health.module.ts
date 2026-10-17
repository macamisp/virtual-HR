import { Module } from '@nestjs/common';
import { CoordinationShutdown } from '../common/coordination.ts';
import { HealthController } from './health.controller.ts';

@Module({ controllers: [HealthController], providers: [CoordinationShutdown] })
export class HealthModule {}
