import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.ts';
import { configureApp } from './common/configure-app.ts';
import { mfaEnforced } from './common/config.ts';

export async function bootstrap() {
  // Throws in production; a loud reminder anywhere else.
  if (!mfaEnforced()) console.warn('WARNING: AUTH_MFA_ENFORCEMENT=off - roles that require 2FA can sign in without it. Local demo only.');
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  // ECS stops tasks with SIGTERM: close sockets, stop the office tick and jobs, release Redis.
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);

  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`HRVO API Server running on port ${port}`);
  return app;
}

if (process.env.NODE_ENV !== 'test' && !process.env.JEST_WORKER_ID) {
  bootstrap().catch((err) => {
    console.error('Failed to bootstrap HRVO API server:', err);
    process.exit(1);
  });
}
