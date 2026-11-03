/**
 * Checks the rendered staging Compose project against scripts/staging-compose-policy.ts (ADR 047).
 * Reads `docker compose config --format json` from stdin and prints only service, network and
 * setting names, never values (the rendered config contains secrets). On the EC2 host, which has no
 * Node.js, it runs in the API image (docs/runbooks/staging-ec2.md, section 3):
 *
 *   $C --profile tools config --format json | docker run --rm -i --network none \
 *     -v "$PWD/scripts:/s:ro" --entrypoint node hrvo-api:staging \
 *     --experimental-strip-types --no-warnings=ExperimentalWarning /s/staging-compose-check.ts --api-subnet 172.30.1.0/29
 */
import { checkStagingCompose, serviceNames, type Json } from './staging-compose-policy.ts';

const subnetFlag = process.argv.indexOf('--api-subnet');
const apiSubnet = subnetFlag > 0 ? process.argv[subnetFlag + 1] : undefined;

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
let config: Json;
try {
  config = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json;
} catch {
  console.error('staging compose check: stdin is not JSON (pipe `docker compose ... config --format json`)');
  process.exit(2);
}
const problems = checkStagingCompose(config, { apiSubnet });
if (problems.length > 0) {
  for (const p of problems) console.error(`FAIL ${p}`);
  process.exit(1);
}
console.log(`staging compose check: ok (${serviceNames(config).length} services)`);
