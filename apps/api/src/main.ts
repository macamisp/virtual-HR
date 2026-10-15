import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.ts';

export async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(cookieParser());
  app.enableCors({
    origin: true,
    credentials: true,
  });

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
