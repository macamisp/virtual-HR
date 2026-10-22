/**
 * Runs the fake Google (fake-google.ts) as a process for the Playwright suite:
 *   node --experimental-strip-types apps/api/test/support/fake-google-server.ts
 * Port FAKE_GOOGLE_PORT (3102), client id/secret FAKE_GOOGLE_CLIENT_ID/_SECRET. Test only.
 */
import './refuse-in-production.ts';
import { FakeGoogle } from './fake-google.ts';

const port = Number(process.env.FAKE_GOOGLE_PORT || 3102);
const fake = new FakeGoogle(port, process.env.FAKE_GOOGLE_CLIENT_ID || 'fake-google-client', process.env.FAKE_GOOGLE_CLIENT_SECRET || 'fake-google-secret');
await fake.start();
console.log(`Fake Google OIDC provider listening on ${fake.issuer} (test only)`);
const stop = () => { void fake.stop().then(() => process.exit(0)); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
