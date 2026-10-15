import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.ts';
import { configureApp } from './common/configure-app.ts';

export async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);

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
