/**
 * Checks the rendered self-hosted LiveKit Compose project against scripts/livekit-compose-policy.ts
 * (ADR 067). Reads `docker compose config --format json` from stdin and prints only service and
 * setting names, never values (the rendered config contains secrets). On the host, which has no
 * Node.js, run it in the API image like the staging check:
 *
 *   cd /opt/hrvo-livekit && sudo -n docker compose config --format json | sudo -n docker run --rm -i \
 *     --network none -v "$PWD/scripts:/s:ro" --entrypoint node hrvo-api:staging \
 *     --experimental-strip-types --no-warnings=ExperimentalWarning /s/livekit-compose-check.ts --gid 64900
 */
import { checkLiveKitCompose, type Json } from './livekit-compose-policy.ts';

const gidFlag = process.argv.indexOf('--gid');
const gid = gidFlag > 0 ? process.argv[gidFlag + 1] : undefined;
if (!gid || !/^\d+$/.test(gid)) {
  console.error('livekit compose check: pass --gid <LIVEKIT_GID>');
  process.exit(2);
}
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
let config: Json;
try {
  config = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json;
} catch {
  console.error('livekit compose check: stdin is not JSON (pipe `docker compose config --format json`)');
  process.exit(2);
}
const problems = checkLiveKitCompose(config, { gid });
if (problems.length > 0) {
  for (const p of problems) console.error(`FAIL ${p}`);
  process.exit(1);
}
console.log('livekit compose check: ok (caddy, livekit, redis)');
