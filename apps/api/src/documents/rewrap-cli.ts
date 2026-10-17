/**
 * Operator entry point for the local-to-KMS re-wrap (ADR 021). Needs DOCUMENT_KMS_PROVIDER=aws
 * with the KMS key ids AND the old local keys (the migration provider); never in production,
 * where local keys are refused (run it in staging/dev data before the switch).
 *   node dist/apps/api/src/documents/rewrap-cli.js --operator "Jane Doe"
 */
import 'reflect-metadata';
import { PrismaService } from '../common/prisma.service.ts';
import { keyProviderFromEnv } from './crypto.ts';
import { CompositeKeyProvider } from './kms-key-provider.ts';
import { rewrapDocumentKeys } from './rewrap-keys.ts';

const i = process.argv.indexOf('--operator');
const operator = i > 0 ? process.argv[i + 1] : undefined;
if (!operator) { console.error('Usage: rewrap-cli --operator "<your name>"'); process.exit(2); }
const keys = keyProviderFromEnv();
if (!(keys instanceof CompositeKeyProvider)) { console.error('Set DOCUMENT_KMS_PROVIDER=aws and keep the local keys for this run.'); process.exit(2); }
const prisma = new PrismaService();
await prisma.onModuleInit();
try {
  const r = await rewrapDocumentKeys(prisma, keys, { operator });
  console.log(JSON.stringify(r));
  process.exitCode = r.failed ? 1 : 0;
} finally {
  await prisma.onModuleDestroy();
}
