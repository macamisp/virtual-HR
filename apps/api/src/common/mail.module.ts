import { Module } from '@nestjs/common';
import { MAIL_TRANSPORT, createMailTransport } from './mailer.ts';

/** One mail transport per application (auth reset links, notification emails). */
@Module({
  providers: [{ provide: MAIL_TRANSPORT, useFactory: createMailTransport }],
  exports: [MAIL_TRANSPORT],
})
export class MailModule {}
