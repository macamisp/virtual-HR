import { Module } from '@nestjs/common';
import { KEY_PROVIDER, keyProviderFromEnv } from '../documents/crypto.ts';
import { CalendarController } from './calendar.controller.ts';
import { CalendarService } from './calendar.service.ts';

/** FR-MEET-006 (ADR 023). Tokens are sealed with the same key provider as documents. */
@Module({
  controllers: [CalendarController],
  providers: [CalendarService, { provide: KEY_PROVIDER, useFactory: () => keyProviderFromEnv() }],
  exports: [CalendarService],
})
export class CalendarModule {}
