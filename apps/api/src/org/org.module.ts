import { Module } from '@nestjs/common';
import { OrgController } from './org.controller.ts';
import { OrgService } from './org.service.ts';

/** FR-ORG-006 (ADR 031): teams and the manager hierarchy. */
@Module({
  controllers: [OrgController],
  providers: [OrgService],
})
export class OrgModule {}
