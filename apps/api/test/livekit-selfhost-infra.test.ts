/**
 * Self-hosted LiveKit on the application's EC2 host: safety regressions (ADR 067).
 *  P1  every LiveKit container runs with the group the host guard cuts off from instance metadata;
 *      ADR 047's guard keeps working (functional namespace tests, skipped where unavailable).
 *  P2  every production compose command keeps the Supabase overlay (prod-compose.sh, runbook).
 *  P3  the host guard keeps plain TURN (5349), signalling and Redis off the Internet, in its own
 *      nftables table, never flushing others.
 *  P8  Let's Encrypt staging or production, chosen explicitly, with a required account e-mail.
 *  P9  memory/CPU/PID limits for a 2-vCPU host; no Egress.
 *  P10 images pinned by digest; Docker Compose validates the project (when installed).
 *  P11 the rollback to LiveKit Cloud keeps verifying webhooks from rooms still on the self-hosted server.
 * No container is started and no secret is printed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLiveKitCompose, sizeBytes, type Json } from '../../../scripts/livekit-compose-policy.ts';
import { liveKitConfig, signWebhook, webhookSigner } from '../src/media/livekit.ts';

function findRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'apps', 'api', 'src', 'main.ts'))) {
    const up = dirname(dir);
    assert.notEqual(up, dir, 'repository root not found');
    dir = up;
  }
  return dir;
}
const ROOT = findRoot();
const BUNDLE = join(ROOT, 'infra', 'livekit-selfhost');
const GID = '64900';
const LE_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';
const LE_PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory';

const run = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): SpawnSyncReturns<string> =>
  spawnSync(cmd, args, { encoding: 'utf8', cwd: opts.cwd, env: { ...process.env, ...opts.env }, timeout: 120_000 });

const hasPyYaml = run('python3', ['-I', '-c', 'import yaml']).status === 0;
function yamlFile(path: string): Json {
  const r = run('python3', ['-I', '-c', 'import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', path]);
  assert.equal(r.status, 0, 'YAML parses');
  return JSON.parse(r.stdout) as Json;
}

/** Compose-style interpolation: $$, ${VAR}, ${VAR:-default}, ${VAR:?error}. */
function interpolate(v: Json, env: Record<string, string>): Json {
  if (typeof v === 'string') {
    return v.replace(/\$\$|\$\{([A-Z0-9_]+)(?::([-?])([^}]*))?\}/g, (whole, name?: string, op?: string, arg?: string) => {
      if (whole === '$$') return '$';
      const val = env[name!];
      if (val !== undefined && val !== '') return val;
      if (op === '-') return arg ?? '';
      if (op === '?') throw new Error(`required variable ${name} is missing: ${arg}`);
      return '';
    });
  }
  if (Array.isArray(v)) return v.map((x) => interpolate(x, env));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, interpolate(x, env)]));
  return v;
}

const COMPOSE_ENV = { LIVEKIT_GID: GID, LIVEKIT_PORT: '7880', REDIS_PORT: '6389', CADDY_TLS_PORT: '443' };
const SETTINGS = {
  LIVEKIT_DOMAIN: 'livekit.example.test', TURN_DOMAIN: 'turn.example.test',
  WEBHOOK_URL: 'https://api.example.test/media/livekit/webhook',
  TLS_ISSUER: 'acme', ACME_EMAIL: 'ops@example.test', ACME_CA: 'staging', NODE_IP: '203.0.113.10', LIVEKIT_GID: GID,
};

/** A throw-away copy of the bundle with the given livekit.env. */
function bundle(settings: Record<string, string | undefined>): string {
  const dir = mkdtempSync(join(tmpdir(), 'hrvo-lk-'));
  cpSync(BUNDLE, dir, { recursive: true });
  // Quoted as an operator would write them, so values reach configure.sh's own validation.
  const quote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  writeFileSync(join(dir, 'livekit.env'), Object.entries(settings).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${quote(v!)}`).join('\n') + '\n');
  return dir;
}
const configure = (dir: string, ...args: string[]) => run('sh', [join(dir, 'configure.sh'), ...args], { cwd: dir });
const envValue = (file: string, name: string): string => (new RegExp(`^${name}=(.*)$`, 'm').exec(readFileSync(file, 'utf8')) ?? [])[1] ?? '';
const mode = (file: string) => (statSync(file).mode & 0o777).toString(8);

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ------------------------------------------------------------------------------------------------
describe('LiveKit compose project: isolation, limits, digests (P1, P9, P10; ADR 067)', () => {
  const hardened = { network_mode: 'host', cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], oom_score_adj: 500, restart: 'unless-stopped' };
  const digest = `@sha256:${'a'.repeat(64)}`;
  function rendered(): Record<string, Json> {
    return {
      name: 'hrvo-livekit',
      services: {
        caddy: { ...hardened, image: `livekit/caddyl4:v2.11.3${digest}`, user: `0:${GID}`, cap_add: ['NET_BIND_SERVICE'], mem_limit: '134217728', memswap_limit: '134217728', cpus: 0.5, pids_limit: 128,
          volumes: [{ type: 'bind', source: '/opt/hrvo-livekit/generated/caddy.yaml', target: '/etc/caddy.yaml', read_only: true }, { type: 'volume', source: 'caddy_data', target: '/data' }] },
        livekit: { ...hardened, image: `livekit/livekit-server:v1.13.11${digest}`, user: `0:${GID}`, mem_limit: '1073741824', memswap_limit: '1073741824', cpus: 1, pids_limit: 512,
          env_file: ['/opt/hrvo-livekit/secrets.env'], environment: { LIVEKIT_KEYS: 'x', REDIS_PASSWORD: 'x' },
          volumes: [{ type: 'bind', source: '/opt/hrvo-livekit/generated/livekit.yaml', target: '/etc/livekit.yaml', read_only: true }] },
        redis: { ...hardened, image: `redis:7.4.6-alpine${digest}`, user: `redis:${GID}`, mem_limit: '67108864', memswap_limit: '67108864', cpus: 0.25, pids_limit: 64,
          env_file: ['/opt/hrvo-livekit/redis.env'], environment: { REDIS_PASSWORD: 'x' } },
      },
    };
  }
  type Mutate = (c: { services: Record<string, Record<string, Json>> }) => void;
  const svc = (c: Record<string, Json>) => c as unknown as { services: Record<string, Record<string, Json>> };

  it('accepts the expected rendering', () => {
    assert.deepEqual(checkLiveKitCompose(rendered(), { gid: GID }), []);
  });

  const cases: Array<[string, Mutate, RegExp]> = [
    ['an Egress service', (c) => { c.services.egress = { ...hardened, image: 'livekit/egress:v1.15.0' }; }, /egress: unexpected service/],
    ['a bridge network instead of host networking', (c) => { c.services.livekit!.network_mode = 'bridge'; }, /livekit: network_mode must be host/],
    ['a container without the LiveKit group', (c) => { c.services.redis!.user = 'redis'; }, /redis: user must be/],
    ['a container in another group', (c) => { c.services.caddy!.user = '0:0'; }, /caddy: user group must be LIVEKIT_GID/],
    ['capabilities kept (group could be changed)', (c) => { c.services.livekit!.cap_drop = []; }, /livekit: cap_drop must include ALL/],
    ['no no-new-privileges', (c) => { c.services.livekit!.security_opt = []; }, /livekit: security_opt must include no-new-privileges/],
    ['NET_ADMIN or SETGID added', (c) => { c.services.livekit!.cap_add = ['NET_ADMIN', 'SETGID']; }, /livekit: cap_add NET_ADMIN is not allowed/],
    ['a privileged container', (c) => { c.services.redis!.privileged = true; }, /redis: must not be privileged/],
    ['the Docker socket mounted', (c) => { c.services.caddy!.volumes = [{ type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' }]; }, /caddy: binds a host path/],
    ['a writable config mount', (c) => { c.services.livekit!.volumes = [{ type: 'bind', source: '/x/generated/livekit.yaml', target: '/etc/livekit.yaml' }]; }, /livekit: config file must be mounted read-only/],
    ['an image without a digest', (c) => { c.services.livekit!.image = 'livekit/livekit-server:v1.13.11'; }, /livekit: image must be pinned by digest/],
    ['LiveKit above 1 GiB', (c) => { c.services.livekit!.mem_limit = '2g'; c.services.livekit!.memswap_limit = '2g'; }, /livekit: mem_limit above 1024 MiB/],
    ['swap allowed', (c) => { c.services.livekit!.memswap_limit = '2147483648'; }, /livekit: memswap_limit must equal mem_limit/],
    ['LiveKit above one CPU', (c) => { c.services.livekit!.cpus = 2; }, /livekit: cpus above 1/],
    ['no CPU limit', (c) => { delete c.services.caddy!.cpus; }, /caddy: cpus must be set/],
    ['no PID limit', (c) => { delete c.services.redis!.pids_limit; }, /redis: pids_limit must be set/],
    ['preferred over the application by the OOM killer reversed', (c) => { c.services.livekit!.oom_score_adj = -500; }, /livekit: oom_score_adj must be >= 0/],
    ['the LiveKit key pair given to Redis', (c) => { c.services.redis!.environment = { REDIS_PASSWORD: 'x', LIVEKIT_KEYS: 'x' }; }, /redis: must not receive LIVEKIT_KEYS/],
    ['secrets given to Caddy', (c) => { c.services.caddy!.env_file = ['/opt/hrvo-livekit/secrets.env']; }, /caddy: env_file secrets.env is not allowed/],
    ['static AWS keys', (c) => { c.services.livekit!.environment = { LIVEKIT_KEYS: 'x', AWS_ACCESS_KEY_ID: 'x' }; }, /livekit: must not receive AWS_ACCESS_KEY_ID/],
    ['published ports', (c) => { c.services.caddy!.ports = [{ target: 443, published: '443' }]; }, /caddy: must not publish ports/],
  ];
  for (const [name, mutate, problem] of cases) {
    it(`refuses ${name}`, () => {
      const c = rendered();
      mutate(svc(c));
      const problems = checkLiveKitCompose(c, { gid: GID });
      assert.ok(problems.some((p) => problem.test(p)), `${problem} in ${JSON.stringify(problems)}`);
    });
  }

  it('reads Compose sizes', () => {
    assert.equal(sizeBytes('1g'), 1024 ** 3);
    assert.equal(sizeBytes('128m'), 128 * 1024 ** 2);
    assert.equal(sizeBytes('1073741824'), 1024 ** 3);
    assert.equal(sizeBytes(67108864), 64 * 1024 ** 2);
    assert.ok(Number.isNaN(sizeBytes('lots')!));
  });

  it('the shipped docker-compose.yml passes the policy (parsed and interpolated as Compose does)', { skip: hasPyYaml ? false : 'python3 with PyYAML is not installed' }, () => {
    const config = interpolate(yamlFile(join(BUNDLE, 'docker-compose.yml')), COMPOSE_ENV);
    assert.deepEqual(checkLiveKitCompose(config, { gid: GID }), []);
  });

  it('IMDS: every service of the shipped file runs with LIVEKIT_GID and cannot change its group; Compose refuses to run without it', { skip: hasPyYaml ? false : 'python3 with PyYAML is not installed' }, () => {
    const raw = yamlFile(join(BUNDLE, 'docker-compose.yml')) as { services: Record<string, Record<string, Json>> };
    const config = interpolate(raw as unknown as Json, COMPOSE_ENV) as { services: Record<string, Record<string, Json>> };
    assert.deepEqual(Object.keys(config.services).sort(), ['caddy', 'livekit', 'redis']);
    for (const [name, s] of Object.entries(config.services)) {
      assert.match(String(s.user), new RegExp(`:${GID}$`), `${name} group`);
      assert.equal(s.network_mode, 'host', `${name} host networking (so the host output rule applies)`);
      assert.ok((s.cap_drop as string[]).includes('ALL'), `${name} cap_drop ALL`);
      assert.ok(!((s.cap_add as string[] | undefined) ?? []).some((c) => ['SETGID', 'SETUID', 'NET_ADMIN', 'SYS_ADMIN', 'NET_RAW'].includes(c)), `${name} cannot change its group or the firewall`);
    }
    assert.throws(() => interpolate(raw as unknown as Json, { ...COMPOSE_ENV, LIVEKIT_GID: '' }), /LIVEKIT_GID is missing/);
  });

  it('images are pinned to their multi-arch index digests', () => {
    const text = readFileSync(join(BUNDLE, 'docker-compose.yml'), 'utf8');
    const images = [...text.matchAll(/^\s+image:\s*(\S+)/gm)].map((m) => m[1]);
    assert.deepEqual(images, [
      'livekit/caddyl4:v2.11.3@sha256:9dd090159a6042a907dbff0ce9dda27a21d2a559dc7b03b60a8e6b1b60b8348e',
      'livekit/livekit-server:v1.13.11@sha256:25cd902de7cacbd5f1f779f6a6ac1eae20ba8f56b0935934ce6b0ab80d1e3d20',
      'redis:7.4.6-alpine@sha256:3b73847e72874be07e6657b129a94761662b79bc0f679273757d4218573b2a98',
    ]);
    assert.doesNotMatch(text, /livekit\/egress/);
  });

  // `docker compose config` validates without a Docker daemon. Set DOCKER_COMPOSE to a compose
  // binary (or "docker compose") where Docker is not installed.
  const composeCmd = (process.env.DOCKER_COMPOSE ?? 'docker compose').split(' ').filter(Boolean);
  const composeAvailable = run(composeCmd[0]!, [...composeCmd.slice(1), 'version']).status === 0;
  it('Docker Compose validates the rendered project, and its JSON passes the policy', { skip: composeAvailable ? false : 'Docker Compose is not installed (set DOCKER_COMPOSE)' }, () => {
    const dir = bundle(SETTINGS);
    try {
      assert.equal(configure(dir, 'init-secrets').status, 0);
      assert.equal(configure(dir, 'render').status, 0);
      const q = run(composeCmd[0]!, [...composeCmd.slice(1), 'config', '-q'], { cwd: dir });
      assert.equal(q.status, 0, 'docker compose config -q');
      const j = run(composeCmd[0]!, [...composeCmd.slice(1), 'config', '--format', 'json'], { cwd: dir });
      assert.equal(j.status, 0, 'docker compose config --format json');
      assert.deepEqual(checkLiveKitCompose(JSON.parse(j.stdout) as Json, { gid: GID }), []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ------------------------------------------------------------------------------------------------
describe("Let's Encrypt issuer and secrets (P8; ADR 067)", () => {
  function issuers(dir: string): Json {
    const caddy = yamlFile(join(dir, 'generated', 'caddy.yaml')) as { apps: { tls: { automation: { policies: Array<{ subjects: string[]; issuers: Json }> } } } };
    return caddy.apps.tls.automation.policies[0]!.issuers;
  }
  function rendersWith(settings: Record<string, string | undefined>): { dir: string; r: SpawnSyncReturns<string> } {
    const dir = bundle(settings);
    assert.equal(configure(dir, 'init-secrets').status, 0);
    return { dir, r: configure(dir, 'render') };
  }

  it("ACME_CA=staging renders Let's Encrypt's staging directory with the account e-mail", { skip: hasPyYaml ? false : 'python3 with PyYAML is not installed' }, () => {
    const { dir, r } = rendersWith(SETTINGS);
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Let's Encrypt staging/);
      assert.deepEqual(issuers(dir), [{ module: 'acme', ca: LE_STAGING, email: 'ops@example.test' }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('ACME_CA=production renders the production directory', { skip: hasPyYaml ? false : 'python3 with PyYAML is not installed' }, () => {
    const { dir, r } = rendersWith({ ...SETTINGS, ACME_CA: 'production' });
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(issuers(dir), [{ module: 'acme', ca: LE_PRODUCTION, email: 'ops@example.test' }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  for (const [what, settings, message] of [
    ['no ACME_CA (no silent default)', { ...SETTINGS, ACME_CA: undefined }, /ACME_CA=staging/],
    ['an unknown ACME_CA', { ...SETTINGS, ACME_CA: 'prod' }, /ACME_CA=staging/],
    ['no ACME_EMAIL', { ...SETTINGS, ACME_EMAIL: undefined }, /ACME_EMAIL/],
    ['an ACME_EMAIL that is not an address', { ...SETTINGS, ACME_EMAIL: 'ops' }, /ACME_EMAIL/],
    ['an ACME_EMAIL that would break out of the YAML string', { ...SETTINGS, ACME_EMAIL: 'o"ps@example.test' }, /ACME_EMAIL/],
    ['a LIVEKIT_GID in the system range', { ...SETTINGS, LIVEKIT_GID: '0' }, /LIVEKIT_GID/],
  ] as Array<[string, Record<string, string | undefined>, RegExp]>) {
    it(`refuses to render with ${what}`, () => {
      const dir = bundle(settings);
      try {
        writeFileSync(join(dir, 'secrets.env'), 'LIVEKIT_KEYS=APIx: ' + 's'.repeat(48) + '\nREDIS_PASSWORD=r\n', { mode: 0o600 });
        writeFileSync(join(dir, 'redis.env'), 'REDIS_PASSWORD=r\n', { mode: 0o600 });
        const r = configure(dir, 'render');
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, message);
        assert.equal(existsSync(join(dir, 'generated', 'caddy.yaml')), false, 'nothing rendered');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }

  it('only livekit.env counts: same-named variables in the shell do not change the rendering', () => {
    const dir = bundle(SETTINGS);
    try {
      assert.equal(configure(dir, 'init-secrets').status, 0);
      const r = run('sh', [join(dir, 'configure.sh'), 'render'], { cwd: dir, env: { REDIS_PORT: '6380', LIVEKIT_PORT: '9999', LIVEKIT_GID: '1234', ACME_CA: 'production', NODE_IP: '192.0.2.1' } });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(envValue(join(dir, '.env'), 'REDIS_PORT'), '6389');
      assert.equal(envValue(join(dir, '.env'), 'LIVEKIT_PORT'), '7880');
      assert.equal(envValue(join(dir, '.env'), 'LIVEKIT_GID'), GID);
      assert.equal(envValue(join(dir, 'generated', 'hrvo-livekit-guard.default'), 'LIVEKIT_PRIVATE_TCP_PORTS'), '"5349 7880 6389"');
      const yaml = readFileSync(join(dir, 'generated', 'caddy.yaml'), 'utf8');
      assert.ok(yaml.includes(LE_STAGING) && !yaml.includes(LE_PRODUCTION), 'the CA of livekit.env');
      assert.match(readFileSync(join(dir, 'generated', 'livekit.yaml'), 'utf8'), /node_ip: 203\.0\.113\.10/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('the internal CA (local rehearsals) needs no e-mail', { skip: hasPyYaml ? false : 'python3 with PyYAML is not installed' }, () => {
    const { dir, r } = rendersWith({ ...SETTINGS, TLS_ISSUER: 'internal', ACME_EMAIL: undefined, ACME_CA: undefined });
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(issuers(dir), [{ module: 'internal' }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // Semantic check with Caddy itself, when a caddy binary is at hand (e.g. extracted from the pinned image).
  const caddy = process.env.CADDY_BIN;
  it('Caddy accepts the staging configuration', { skip: caddy ? false : 'set CADDY_BIN to a caddy binary with the layer4 module' }, () => {
    const { dir } = rendersWith(SETTINGS);
    try {
      const r = run(caddy!, ['validate', '--config', join(dir, 'generated', 'caddy.yaml'), '--adapter', 'yaml']);
      assert.equal(r.status, 0, r.stderr.slice(-500));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('secrets: two mode-600 files, Redis gets only its password, nothing printed or rendered', () => {
    const { dir, r } = rendersWith(SETTINGS);
    try {
      assert.equal(r.status, 0, r.stderr);
      const secrets = join(dir, 'secrets.env');
      const redis = join(dir, 'redis.env');
      assert.equal(mode(secrets), '600');
      assert.equal(mode(redis), '600');
      const keys = envValue(secrets, 'LIVEKIT_KEYS');
      const secret = keys.split(': ')[1] ?? '';
      const redisPassword = envValue(redis, 'REDIS_PASSWORD');
      assert.ok(secret.length >= 32 && redisPassword.length >= 32);
      assert.equal(envValue(secrets, 'REDIS_PASSWORD'), redisPassword);
      assert.doesNotMatch(readFileSync(redis, 'utf8'), /LIVEKIT_KEYS/);
      assert.doesNotMatch(readFileSync(secrets, 'utf8'), /EGRESS/);
      for (const f of ['generated/livekit.yaml', 'generated/caddy.yaml', 'generated/hrvo-livekit-guard.default', '.env']) {
        const text = readFileSync(join(dir, f), 'utf8');
        assert.ok(!text.includes(secret) && !text.includes(redisPassword), `${f} holds no secret`);
      }
      assert.ok(!r.stdout.includes(secret) && !r.stdout.includes(redisPassword), 'render prints no secret');
      assert.equal(configure(dir, 'init-secrets').status, 1, 'init-secrets refuses to overwrite');
      // The host guard and Compose get the same group.
      assert.equal(envValue(join(dir, '.env'), 'LIVEKIT_GID'), GID);
      assert.equal(envValue(join(dir, 'generated', 'hrvo-livekit-guard.default'), 'LIVEKIT_GID'), GID);
      assert.equal(envValue(join(dir, 'generated', 'hrvo-livekit-guard.default'), 'LIVEKIT_PRIVATE_TCP_PORTS'), '"5349 7880 6389"');
      // A Redis password that differs between the files is refused.
      writeFileSync(redis, 'REDIS_PASSWORD=other\n', { mode: 0o600 });
      const bad = configure(dir, 'check');
      assert.notEqual(bad.status, 0);
      assert.match(bad.stderr, /differs/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ------------------------------------------------------------------------------------------------
describe('host guard: metadata, inbound ports, mandatory settings (P1, P3, Finding 2; ADR 067, ADR 047)', () => {
  const guard = join(BUNDLE, 'livekit-guard.sh');
  /** A settings file + matching Compose .env in a temp dir; returns the env for the guard. */
  function guardFiles(opts: { gid?: string; composeGid?: string; ports?: string; settings?: string; mode?: number } = {}): { dir: string; env: Record<string, string> } {
    const dir = mkdtempSync(join(tmpdir(), 'hrvo-guard-'));
    const composeEnv = join(dir, 'compose.env');
    writeFileSync(composeEnv, `LIVEKIT_PORT=7880\nREDIS_PORT=6389\nCADDY_TLS_PORT=443\nTURN_TLS_PORT=5349\nLIVEKIT_GID=${opts.composeGid ?? GID}\n`);
    const settings = join(dir, 'settings');
    writeFileSync(settings, opts.settings ?? `LIVEKIT_GID=${opts.gid ?? GID}\nLIVEKIT_PRIVATE_TCP_PORTS="${opts.ports ?? '5349 7880 6389'}"\nLIVEKIT_COMPOSE_ENV=${composeEnv}\n`);
    chmodSync(settings, opts.mode ?? 0o644);
    return { dir, env: { HRVO_LIVEKIT_GUARD_SETTINGS: settings, HRVO_LIVEKIT_GUARD_DROPIN: join(dir, 'dropin.conf'), HRVO_LIVEKIT_GUARD_DOCKER: join(dir, 'no-docker') } };
  }
  const guardRun = (cmd: string, env: Record<string, string>) => run('bash', [guard, cmd], { env });

  it('renders one table of its own: metadata dropped for the LiveKit group, 5349/7880/6389 loopback only', () => {
    const g = guardFiles();
    try {
      const r = guardRun('render', g.env);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual([...r.stdout.matchAll(/^table (.+) \{$/gm)].map((m) => m[1]), ['inet hrvo_livekit']);
      assert.match(r.stdout, new RegExp(`meta skgid ${GID} ip daddr 169\\.254\\.169\\.254 counter drop`));
      assert.match(r.stdout, new RegExp(`meta skgid ${GID} ip6 daddr fd00:ec2::254 counter drop`));
      assert.match(r.stdout, /iifname != "lo" tcp dport \{ 5349, 6389, 7880 \} counter drop/);
      assert.doesNotMatch(r.stdout, /flush|hrvo_imds/);
    } finally { rmSync(g.dir, { recursive: true, force: true }); }
  });

  it('never flushes, and deletes no table but its own', () => {
    const code = readFileSync(guard, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.doesNotMatch(code, /flush\s+(ruleset|table|chain)/);
    for (const m of code.matchAll(/delete table ([^"\s;]+(?: [^"\s;]+)?)/g)) assert.equal(m[1], '$TABLE');
    assert.match(code, /TABLE='inet hrvo_livekit'/);
  });

  it('ignores environment variables of the setting names: only the settings file counts', () => {
    const g = guardFiles();
    try {
      const r = guardRun('render', { ...g.env, LIVEKIT_GID: '1234', LIVEKIT_PRIVATE_TCP_PORTS: '22' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`skgid ${GID} `));
      assert.doesNotMatch(r.stdout, /1234|dport \{ 22 \}/);
    } finally { rmSync(g.dir, { recursive: true, force: true }); }
  });

  for (const [what, opts, message] of [
    ['a missing settings file', { settings: '' }, /is missing/],
    ['an unknown setting', { settings: `LIVEKIT_GID=${GID}\nLIVEKIT_PRIVATE_TCP_PORTS="5349 7880 6389"\nLIVEKIT_COMPOSE_ENV=/x/.env\nFOO=1\n` }, /not an allowed setting line/],
    ['shell code in the group', { settings: `LIVEKIT_GID=${GID}; flush ruleset\nLIVEKIT_PRIVATE_TCP_PORTS="5349 7880 6389"\nLIVEKIT_COMPOSE_ENV=/x/.env\n` }, /not an allowed setting line/],
    ['nft syntax in the ports', { ports: '5349 } accept; {' }, /not an allowed setting line/],
    ['group 0', { gid: '0', composeGid: '0' }, /from 1000 to 65533/],
    ['a group set twice', { settings: `LIVEKIT_GID=${GID}\nLIVEKIT_GID=65000\n` }, /set twice/],
    ['no Compose project named', { settings: `LIVEKIT_GID=${GID}\nLIVEKIT_PRIVATE_TCP_PORTS="5349 7880 6389"\n` }, /LIVEKIT_COMPOSE_ENV is missing/],
    ['a settings file writable by others', { mode: 0o666 }, /writable by group or others/],
    ['a Compose project rendered with another group (changed LIVEKIT_GID)', { composeGid: '65000' }, /LIVEKIT_GID differs: .* has 64900, the Compose project .* has 65000/],
    ['private ports that differ from the Compose project', { ports: '5349 7880 6390' }, /private ports differ/],
  ] as Array<[string, Parameters<typeof guardFiles>[0], RegExp]>) {
    it(`fails closed on ${what}`, () => {
      const g = guardFiles(opts);
      try {
        if (opts?.settings === '') rmSync(g.env.HRVO_LIVEKIT_GUARD_SETTINGS!);
        for (const cmd of ['render', 'check', 'apply']) {
          const r = guardRun(cmd, g.env);
          assert.notEqual(r.status, 0, `${cmd} must fail`);
          assert.match(r.stderr, message, `${cmd}: ${r.stderr}`);
        }
      } finally { rmSync(g.dir, { recursive: true, force: true }); }
    });
  }

  it('the systemd unit and the Docker drop-in use the same mandatory settings file (no optional EnvironmentFile)', () => {
    const unit = readFileSync(join(BUNDLE, 'hrvo-livekit-guard.service'), 'utf8');
    const dropin = readFileSync(join(BUNDLE, 'docker-hrvo-livekit-guard.conf'), 'utf8');
    for (const [name, text] of [['unit', unit], ['drop-in', dropin]] as const) {
      assert.doesNotMatch(text, /^EnvironmentFile=/m, `${name}: no optional EnvironmentFile`);
      assert.match(text, /^Environment=HRVO_LIVEKIT_GUARD_SETTINGS=\/etc\/default\/hrvo-livekit-guard$/m, `${name}: the settings file`);
    }
    assert.match(unit, /^ExecStart=\/usr\/local\/sbin\/hrvo-livekit-guard apply$/m);
    assert.match(unit, /^Before=.*docker\.service/m);
    assert.match(dropin, /^ExecStartPre=\/usr\/local\/sbin\/hrvo-livekit-guard check$/m, 'Docker refuses to start unless check passes');
    assert.match(dropin, /^After=hrvo-livekit-guard\.service$/m);
    // check/apply never call Docker (they run while docker.service starts).
    const code = readFileSync(guard, 'utf8');
    const branch = (c: string) => (new RegExp(`^  ${c}\\)([\\s\\S]*?);;`, 'm').exec(code) ?? [])[1] ?? '';
    for (const c of ['check', 'apply']) assert.doesNotMatch(branch(c), /verify_containers|docker_up|DOCKER/, `${c} must not call Docker`);
    assert.match(branch('verify'), /verify_containers/);
  });

  it('remove refuses while a LiveKit container runs, or while the Docker drop-in is installed', () => {
    const g = guardFiles();
    try {
      const stub = join(g.dir, 'docker');
      writeFileSync(stub, '#!/bin/sh\ncase "$1" in info) exit 0;; ps) echo hrvo-livekit-livekit-1;; esac\n', { mode: 0o755 });
      const running = guardRun('remove', { ...g.env, HRVO_LIVEKIT_GUARD_DOCKER: stub });
      assert.notEqual(running.status, 0);
      assert.match(running.stderr, /LiveKit containers are running \(hrvo-livekit-livekit-1\)/);
      writeFileSync(stub, '#!/bin/sh\ncase "$1" in info) exit 0;; ps) exit 1;; esac\n', { mode: 0o755 });
      const unknown = guardRun('remove', { ...g.env, HRVO_LIVEKIT_GUARD_DOCKER: stub });
      assert.notEqual(unknown.status, 0, 'cannot list containers: refused');
      assert.match(unknown.stderr, /cannot list the running LiveKit containers/);
      writeFileSync(g.env.HRVO_LIVEKIT_GUARD_DROPIN!, '[Service]\n');
      const dropin = guardRun('remove', g.env);
      assert.notEqual(dropin.status, 0);
      assert.match(dropin.stderr, /drop-in .* is still installed/);
    } finally { rmSync(g.dir, { recursive: true, force: true }); }
  });

  it('the settings rendered by configure.sh are accepted and match the Compose group', () => {
    const dir = bundle(SETTINGS);
    try {
      assert.equal(configure(dir, 'init-secrets').status, 0);
      assert.equal(configure(dir, 'render').status, 0);
      const settings = join(dir, 'generated', 'hrvo-livekit-guard.default');
      assert.equal(envValue(settings, 'LIVEKIT_COMPOSE_ENV'), join(realpathSync(dir), '.env'));
      assert.equal(envValue(join(dir, '.env'), 'TURN_TLS_PORT'), '5349');
      const r = guardRun('render', { HRVO_LIVEKIT_GUARD_SETTINGS: settings });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`meta skgid ${envValue(join(dir, '.env'), 'LIVEKIT_GID')} ip daddr`));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // Functional: a user + network namespace plays the EC2 host (needs unshare with subordinate IDs).
  for (const [name, script, want] of [
    ['LiveKit guard: metadata unreachable for every LiveKit identity; 5349 closed from outside; settings mandatory and matched; verify/remove refusals; other tables untouched', 'infra/livekit-selfhost/test/livekit-guard-netns.sh', 'livekit-guard: all checks passed'],
    ['ADR 047 guard still effective', 'infra/staging-ec2/test/imds-guard-netns.sh', 'imds-guard: all checks passed'],
  ] as const) {
    it(`functional: ${name}`, { timeout: 180_000 }, (t) => {
      const r = run('bash', [join(ROOT, script)]);
      if (/^SKIP/m.test(r.stdout)) { t.skip(r.stdout.trim()); return; }
      assert.equal(r.status, 0, r.stdout.split('\n').filter((l) => l.startsWith('FAIL')).join('\n'));
      assert.match(r.stdout, new RegExp(want));
    });
  }
});

// ------------------------------------------------------------------------------------------------
describe('production compose wrapper: Supabase overlay always, allow-list only (P2, Finding 1; ADR 052, ADR 067)', () => {
  const wrapper = join(BUNDLE, 'prod-compose.sh');
  const FILES = ['docker-compose.staging.yml', 'docker-compose.staging.ssh.yml', 'docker-compose.staging.https.yml', 'docker-compose.staging.supabase.yml'];
  const ENVS = ['.env.staging', '.env.staging.db', '.env.staging.supabase'];
  const PREFIX = [
    'compose',
    '-f', 'docker-compose.staging.yml', '-f', 'docker-compose.staging.ssh.yml',
    '-f', 'docker-compose.staging.https.yml', '-f', 'docker-compose.staging.supabase.yml',
    '--env-file', '.env.staging', '--env-file', '.env.staging.db', '--env-file', '.env.staging.supabase',
  ];

  function app(opts: { omit?: string; noHost?: boolean; overlayWithoutSupabase?: boolean; loose?: string } = {}): { dir: string; stub: string; log: string } {
    const dir = mkdtempSync(join(tmpdir(), 'hrvo-app-'));
    for (const f of FILES) if (f !== opts.omit) writeFileSync(join(dir, f), f.endsWith('supabase.yml') && !opts.overlayWithoutSupabase ? 'services:\n  api:\n    environment:\n      PGHOST: ${SUPABASE_PGHOST:?x}\n' : 'services: {}\n');
    for (const e of ENVS) if (e !== opts.omit) writeFileSync(join(dir, e), e === '.env.staging.supabase' && !opts.noHost ? 'SUPABASE_PGHOST=db.secret-host.test\n' : 'X=1\n', { mode: 0o600 });
    if (opts.loose) chmodSync(join(dir, opts.loose), 0o644);
    const log = join(dir, 'docker-args');
    const stub = join(dir, 'docker-stub');
    // Records the working directory, the Compose environment it was given, and every argument.
    writeFileSync(stub, `#!/bin/sh\n{ pwd; echo "env:\${COMPOSE_PROJECT_NAME-}|\${COMPOSE_PROFILES-}|\${COMPOSE_FILE-}|\${DOCKER_HOST-}"; printf '%s\\n' "$@"; } > '${log}'\n`, { mode: 0o755 });
    return { dir, stub, log };
  }
  const wrap = (a: { dir: string; stub: string }, args: string[], env: Record<string, string> = {}) =>
    run('sh', [wrapper, ...args], { env: { APP_DIR: a.dir, DOCKER_CMD: a.stub, ...env } });

  // Allowed: exactly what the runbook needs, passed through unchanged after the fixed prefix.
  for (const args of [
    ['up', '-d', '--no-deps', 'api'], ['up', '--no-deps', '-d', 'web', 'api'], ['up', '--detach', '--no-deps', '--no-build', '--wait', 'api'],
    ['build', 'api', 'web'], ['build', '--pull', '--no-cache', 'api'],
    ['ps'], ['ps', '-a'], ['ps', '--services'], ['images'], ['version'],
    ['logs', 'api'], ['logs', '--tail', '100', '--since', '1h', 'api', 'web'], ['logs', '--tail=50', '-t', '--no-color', 'proxy'],
    ['config', '-q'], ['config', '--quiet'],
  ]) {
    it(`allows: ${args.join(' ')}`, () => {
      const a = app();
      try {
        const r = wrap(a, args);
        assert.equal(r.status, 0, r.stderr);
        const [cwd, env, ...got] = readFileSync(a.log, 'utf8').trim().split('\n');
        assert.equal(cwd, a.dir);
        assert.equal(env, 'env:|||');
        assert.deepEqual(got, [...PREFIX, ...args]);
      } finally { rmSync(a.dir, { recursive: true, force: true }); }
    });
  }

  // Refused: every bypass from the review and equivalent arrangements. Nothing reaches Docker.
  for (const [args, why] of [
    [['config'], /only 'config -q'/],
    [['config', '--format', 'json'], /only 'config -q'/],
    [['config', '-q', '--format', 'json'], /only 'config -q'/],
    [['config', '--environment'], /only 'config -q'/],
    [['config', '--variables'], /only 'config -q'/],
    [['config', '-q', '-q'], /only 'config -q'/],
    [['convert'], /alias of config/],
    [['convert', '-q'], /alias of config/],
    [['--profile', 'tools', 'config'], /options before the subcommand/],
    [['--profile=tools', 'config'], /options before the subcommand/],
    [['--profile', 'tools', 'config', '--format', 'json'], /options before the subcommand/],
    [['-p', 'x', 'config'], /options before the subcommand/],
    [['-px', 'config'], /options before the subcommand/],
    [['--project-name=x', 'up', '-d', '--no-deps', 'api'], /options before the subcommand/],
    [['--ansi', 'never', 'down'], /options before the subcommand/],
    [['--ansi=never', 'down'], /options before the subcommand/],
    [['--dry-run', 'down'], /options before the subcommand/],
    [['-f', 'docker-compose.staging.yml', 'up', '-d', '--no-deps', 'api'], /options before the subcommand/],
    [['--env-file', '.env.staging', 'up', '-d', '--no-deps', 'api'], /options before the subcommand/],
    [['--project-directory', '/tmp', 'ps'], /options before the subcommand/],
    [['--', 'config'], /options before the subcommand/],
    [['down'], /not allowed through this wrapper/],
    [['down', '-v'], /not allowed through this wrapper/],
    [['stop', 'api'], /not allowed/], [['kill', 'api'], /not allowed/], [['rm', '-sf', 'api'], /not allowed/],
    [['restart', 'api'], /not allowed/], [['exec', 'api', 'env'], /not allowed/], [['run', '--rm', 'migrate'], /not allowed/],
    [['cp', 'api:/run/x', '.'], /not allowed/], [['create', 'api'], /not allowed/], [['start', 'api'], /not allowed/],
    [['pause', 'api'], /not allowed/], [['scale', 'api=0'], /not allowed/], [['watch'], /not allowed/], [['pull'], /not allowed/],
    [['Config', '-q'], /unknown compose command/], [['frobnicate'], /unknown compose command/], [[''], /unknown compose command/],
    [['up'], /-d is required/],
    [['up', '--no-deps', 'api'], /-d is required/],
    [['up', '-d', 'api'], /--no-deps is required/],
    [['up', '-d', '--no-deps'], /name the services/],
    [['up', '-d', '--no-deps', 'postgres'], /only api web may be recreated/],
    [['up', '-d', '--no-deps', 'api', 'redis'], /only api web may be recreated/],
    [['up', '-d', '--no-deps', 'api;down'], /only api web may be recreated/],
    [['up', '-d', '--no-deps', '--force-recreate', 'api'], /'--force-recreate' is not allowed/],
    [['up', '-d', '--no-deps', '--remove-orphans', 'api'], /'--remove-orphans' is not allowed/],
    [['up', '-d', '--no-deps', '-V', 'api'], /'-V' is not allowed/],
    [['up', '-d', '--no-deps', '--profile', 'tools', 'api'], /'--profile' is not allowed/],
    [['up', '-d', '--no-deps', '--no-deps=false', 'api'], /'--no-deps=false' is not allowed/],
    [['up', '-d', '--no-deps', 'api', '--', 'x'], /'--' is not allowed/],
    [['build', 'postgres'], /only api web may be built/],
    [['build'], /name the services/],
    [['build', '--build-arg', 'X=1', 'api'], /'--build-arg' is not allowed/],
    [['logs', '--tail', '50;down', 'api'], /not a valid value/],
    [['logs', '--tail'], /needs a value/],
    [['logs', '--tail=$(id)', 'api'], /invalid value/],
    [['logs', 'unknown'], /unknown service/],
    [['logs', '--follow', '--', 'api'], /'--' is not allowed/],
    [['ps', '--format', 'json'], /'--format' is not allowed/],
    [['version', '--short'], /takes no arguments/],
  ] as Array<[string[], RegExp]>) {
    it(`refuses: ${JSON.stringify(args)}`, () => {
      const a = app();
      try {
        const r = wrap(a, args);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, why);
        assert.equal(existsSync(a.log), false, 'docker was not run');
      } finally { rmSync(a.dir, { recursive: true, force: true }); }
    });
  }

  it('clears COMPOSE_* and DOCKER_HOST/DOCKER_CONTEXT from the environment', () => {
    const a = app();
    try {
      const r = wrap(a, ['ps'], { COMPOSE_PROJECT_NAME: 'evil', COMPOSE_PROFILES: 'tools', COMPOSE_FILE: '/tmp/x.yml', DOCKER_HOST: 'tcp://203.0.113.1:2375' });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(readFileSync(a.log, 'utf8').split('\n')[1], 'env:|||');
    } finally { rmSync(a.dir, { recursive: true, force: true }); }
  });

  for (const [what, opts, message] of [
    ['the Supabase overlay is missing', { omit: 'docker-compose.staging.supabase.yml' }, /docker-compose\.staging\.supabase\.yml is missing/],
    ['the Supabase env file is missing', { omit: '.env.staging.supabase' }, /\.env\.staging\.supabase is missing/],
    ['the HTTPS overlay is missing', { omit: 'docker-compose.staging.https.yml' }, /https\.yml is missing/],
    ['the Supabase env file names no host', { noHost: true }, /no SUPABASE_PGHOST/],
    ['the overlay no longer points the API at Supabase', { overlayWithoutSupabase: true }, /no longer sets PGHOST/],
    ['an env file is readable by others', { loose: '.env.staging' }, /readable by group or others/],
  ] as Array<[string, Parameters<typeof app>[0], RegExp]>) {
    it(`refuses to run (no fallback to local PostgreSQL) when ${what}`, () => {
      const a = app(opts);
      try {
        const r = wrap(a, ['up', '-d', '--no-deps', 'api']);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, message);
        assert.equal(existsSync(a.log), false, 'docker was not run');
      } finally { rmSync(a.dir, { recursive: true, force: true }); }
    });
  }

  it('--print shows file names only and runs nothing', () => {
    const a = app();
    try {
      const p = wrap(a, ['--print', 'up', '-d', '--no-deps', 'api']);
      assert.equal(p.status, 0);
      assert.match(p.stdout, /-f docker-compose\.staging\.supabase\.yml --env-file \.env\.staging --env-file \.env\.staging\.db --env-file \.env\.staging\.supabase up -d --no-deps api/);
      assert.doesNotMatch(p.stdout, /secret-host/);
      assert.equal(existsSync(a.log), false);
      assert.notEqual(wrap(a, ['--print', 'down']).status, 0, '--print does not bypass the allow-list');
    } finally { rmSync(a.dir, { recursive: true, force: true }); }
  });

  it('the runbook, ADR and switch script recreate the API only through prod-compose.sh', () => {
    for (const f of ['docs/runbooks/livekit-selfhost.md', 'docs/adr/067-self-hosted-livekit.md', 'infra/livekit-selfhost/switch-api-env.py']) {
      const lines = readFileSync(join(ROOT, f), 'utf8').split('\n');
      for (const [i, line] of lines.entries()) {
        assert.doesNotMatch(line, /\$C\b|\$NEW\b|\$OLD\b/, `${f}:${i + 1} uses a hand-built compose variable`);
        assert.doesNotMatch(line, /docker compose[^`]*-f docker-compose\.staging/, `${f}:${i + 1} builds the production compose command by hand`);
        assert.doesNotMatch(line, /HRVO_ALLOW_DOWN/, `${f}:${i + 1} mentions the removed down override`);
        if (/--no-deps/.test(line)) assert.match(line, /prod-compose\.sh/, `${f}:${i + 1} recreates an app container without prod-compose.sh`);
      }
    }
    assert.match(readFileSync(join(ROOT, 'docs/runbooks/staging-ec2.md'), 'utf8'), /prod-compose\.sh/, 'the staging runbook warns about the Supabase overlay');
  });
});

// ------------------------------------------------------------------------------------------------
describe('switching LiveKit servers: backups outside the checkout, rollback keeps webhooks verifying (P11, Finding 3; ADR 067)', () => {
  const script = join(BUNDLE, 'switch-api-env.py');
  const cloud = { url: 'wss://proj.livekit.cloud', key: 'APIcloudpair', secret: 'c'.repeat(44) };
  const self = { url: 'wss://livekit.example.test', key: 'APIselfpair', secret: 's'.repeat(48) };

  function setup(): { app: string; env: string; secrets: string; backups: string; cleanup: () => void } {
    const app = mkdtempSync(join(tmpdir(), 'hrvo-switch-app-'));
    const priv = mkdtempSync(join(tmpdir(), 'hrvo-switch-backups-'));
    const env = join(app, '.env.staging');
    writeFileSync(env, `WEB_URL=https://app.example.test\nLIVEKIT_URL=${cloud.url}\nLIVEKIT_HTTP_URL=https://proj.livekit.cloud\nLIVEKIT_API_KEY=${cloud.key}\n# kept\nLIVEKIT_API_SECRET=${cloud.secret}\nREDIS_PASSWORD=keep\n`, { mode: 0o600 });
    const secrets = join(priv, 'secrets.env');
    writeFileSync(secrets, `LIVEKIT_KEYS=${self.key}: ${self.secret}\nREDIS_PASSWORD=r\n`, { mode: 0o600 });
    // Not created yet: the script creates it (mode 700).
    const backups = join(priv, 'env-backups');
    return { app, env, secrets, backups, cleanup: () => { rmSync(app, { recursive: true, force: true }); rmSync(priv, { recursive: true, force: true }); } };
  }
  const sw = (s: { env: string; backups: string }, ...args: string[]) => run('python3', ['-I', script, '--env', s.env, '--backup-dir', s.backups, ...args]);
  const read = (env: string) => Object.fromEntries(readFileSync(env, 'utf8').split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const noSecrets = (out: string) => { for (const sec of [cloud.secret, self.secret]) assert.ok(!out.includes(sec), 'no secret printed'); };
  const backupsOf = (dir: string) => readdirSync(dir).filter((n) => n.startsWith('.env.staging.')).sort();
  function verdicts(env: string): { fromSelf: string | null; fromCloud: string | null; forged: string | null } {
    const v = read(env);
    const body = JSON.stringify({ event: 'participant_left', room: { name: 'meet-x' } });
    return withEnv({
      NODE_ENV: 'production', LIVEKIT_URL: v.LIVEKIT_URL, LIVEKIT_HTTP_URL: v.LIVEKIT_HTTP_URL, LIVEKIT_API_KEY: v.LIVEKIT_API_KEY, LIVEKIT_API_SECRET: v.LIVEKIT_API_SECRET,
      LIVEKIT_PREVIOUS_API_KEY: v.LIVEKIT_PREVIOUS_API_KEY, LIVEKIT_PREVIOUS_API_SECRET: v.LIVEKIT_PREVIOUS_API_SECRET,
    }, () => {
      const cfg = liveKitConfig();
      return {
        fromSelf: webhookSigner(cfg, signWebhook({ apiKey: self.key, apiSecret: self.secret }, body), Buffer.from(body)),
        fromCloud: webhookSigner(cfg, signWebhook({ apiKey: cloud.key, apiSecret: cloud.secret }, body), Buffer.from(body)),
        forged: webhookSigner(cfg, signWebhook({ apiKey: self.key, apiSecret: 'f'.repeat(48) }, body), Buffer.from(body)),
      };
    });
  }

  it('to-selfhost then to-cloud: Cloud current again, self-hosted rooms still verify; backups outside the checkout', () => {
    const s = setup();
    try {
      const a = sw(s, 'to-selfhost', '--secrets', s.secrets, '--url', self.url);
      assert.equal(a.status, 0, a.stderr);
      noSecrets(a.stdout + a.stderr);
      assert.deepEqual(verdicts(s.env), { fromSelf: 'current', fromCloud: 'previous', forged: null });

      const b = sw(s, 'to-cloud');
      assert.equal(b.status, 0, b.stderr);
      noSecrets(b.stdout + b.stderr);
      const v = read(s.env);
      assert.equal(v.LIVEKIT_URL, cloud.url);
      assert.equal(v.LIVEKIT_PREVIOUS_API_KEY, self.key, 'the self-hosted key stays until drained');
      assert.equal(v.LIVEKIT_EXTRA_URLS, self.url);
      assert.equal(v.LIVEKIT_HTTP_URL, undefined);
      assert.equal(v.REDIS_PASSWORD, 'keep');
      assert.deepEqual(verdicts(s.env), { fromSelf: 'previous', fromCloud: 'current', forged: null });

      // Backups: in the private directory (700), each 600, named by time and command; none in the checkout.
      assert.equal(mode(s.backups), '700');
      const names = backupsOf(s.backups);
      assert.equal(names.length, 2);
      assert.match(names[0]!, /^\.env\.staging\.\d{8}T\d{6}\.\d{6}Z\.before-to-selfhost\.bak$/);
      assert.match(names[1]!, /\.before-to-cloud\.bak$/);
      for (const n of names) assert.equal(mode(join(s.backups, n)), '600');
      assert.deepEqual(readdirSync(s.app).filter((n) => n !== '.env.staging'), [], 'nothing else written into the app directory');
      assert.match(readFileSync(join(s.backups, names[0]!), 'utf8'), new RegExp(`^LIVEKIT_URL=${cloud.url.replace(/[.]/g, '\\.')}$`, 'm'));
    } finally { s.cleanup(); }
  });

  it('a second to-cloud is refused (it would otherwise switch to the self-hosted pair kept as previous)', () => {
    const s = setup();
    try {
      assert.equal(sw(s, 'to-selfhost', '--secrets', s.secrets, '--url', self.url).status, 0);
      assert.equal(sw(s, 'to-cloud').status, 0);
      const again = sw(s, 'to-cloud');
      assert.notEqual(again.status, 0);
      assert.match(again.stderr, /already LiveKit Cloud/);
      assert.match(sw(s, 'to-selfhost', '--secrets', s.secrets, '--url', cloud.url).stderr, /not a LiveKit Cloud one/);
    } finally { s.cleanup(); }
  });

  it('after the previous pair is gone, to-cloud finds the newest before-to-selfhost backup by itself; backups are never overwritten', () => {
    const s = setup();
    try {
      assert.equal(sw(s, 'to-selfhost', '--secrets', s.secrets, '--url', self.url).status, 0);
      const before = Object.fromEntries(backupsOf(s.backups).map((n) => [n, readFileSync(join(s.backups, n), 'utf8')]));
      // As after a drained drop-previous (done here by hand: no test talks to LiveKit Cloud).
      writeFileSync(s.env, readFileSync(s.env, 'utf8').split('\n').filter((l) => !/^LIVEKIT_PREVIOUS_API_(KEY|SECRET)=/.test(l)).join('\n'), { mode: 0o600 });
      const r = sw(s, 'to-cloud');
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /before-to-selfhost\.bak/, 'says which backup it used');
      noSecrets(r.stdout + r.stderr);
      assert.deepEqual(verdicts(s.env), { fromSelf: 'previous', fromCloud: 'current', forged: null });
      for (const [n, text] of Object.entries(before)) assert.equal(readFileSync(join(s.backups, n), 'utf8'), text, `${n} unchanged`);
      const names = backupsOf(s.backups);
      assert.equal(names.length, 2);
      assert.equal(new Set(names).size, 2);
      const list = sw(s, 'list-backups');
      assert.equal(list.status, 0);
      noSecrets(list.stdout);
      assert.match(list.stdout, /before-to-selfhost[\s\S]*before-to-cloud/);
    } finally { s.cleanup(); }
  });

  it('rapid successive changes get distinct backups; earlier ones stay byte-identical', () => {
    const s = setup();
    try {
      const seen: Record<string, string> = {};
      for (let i = 0; i < 3; i++) {
        assert.equal(sw(s, 'to-selfhost', '--secrets', s.secrets, '--url', self.url).status, 0);
        assert.equal(sw(s, 'to-cloud').status, 0);
        for (const n of backupsOf(s.backups)) {
          const text = readFileSync(join(s.backups, n), 'utf8');
          if (seen[n] !== undefined) assert.equal(text, seen[n], `${n} never rewritten`);
          seen[n] = text;
        }
      }
      assert.equal(backupsOf(s.backups).length, 6);
      assert.deepEqual(readdirSync(s.backups).filter((n) => n.endsWith('.tmp')), [], 'no temp files left');
    } finally { s.cleanup(); }
  });

  it('refuses backup directories that are shared, linked, or inside the checkout or a git repository', () => {
    const s = setup();
    try {
      mkdirSync(s.backups, { mode: 0o755 });
      chmodSync(s.backups, 0o755);
      assert.match(sw(s, 'list-backups').stderr, /must not be accessible by group or others/);
      rmSync(s.backups, { recursive: true });
      const real = mkdtempSync(join(tmpdir(), 'hrvo-real-'));
      chmodSync(real, 0o700);
      symlinkSync(real, s.backups);
      assert.match(sw(s, 'list-backups').stderr, /must be a real directory/);
      rmSync(s.backups);
      rmSync(real, { recursive: true, force: true });
      const inApp = join(s.app, 'backups');
      assert.match(run('python3', ['-I', script, '--env', s.env, '--backup-dir', inApp, 'list-backups']).stderr, /inside the application directory or a git checkout/);
      const repo = mkdtempSync(join(tmpdir(), 'hrvo-repo-'));
      mkdirSync(join(repo, '.git'));
      assert.match(run('python3', ['-I', script, '--env', s.env, '--backup-dir', join(repo, 'b'), 'list-backups']).stderr, /inside the application directory or a git checkout/);
      rmSync(repo, { recursive: true, force: true });
    } finally { s.cleanup(); }
  });

  it('restore and --cloud-from accept only backups of this file from the private directory', () => {
    const s = setup();
    try {
      assert.equal(sw(s, 'to-selfhost', '--secrets', s.secrets, '--url', self.url).status, 0);
      const outside = join(s.app, '.env.staging.20261117T000000.000000Z.before-to-selfhost.bak');
      writeFileSync(outside, `LIVEKIT_URL=${cloud.url}\n`, { mode: 0o600 });
      assert.match(sw(s, 'restore', outside).stderr, /is not a backup of \.env\.staging in/);
      assert.match(sw(s, 'to-cloud', '--cloud-from', outside).stderr, /is not a backup of \.env\.staging in/);
      const [first] = backupsOf(s.backups);
      const r = sw(s, 'restore', join(s.backups, first!));
      assert.equal(r.status, 0, r.stderr);
      assert.equal(read(s.env).LIVEKIT_URL, cloud.url);
    } finally { s.cleanup(); }
  });

  describe('drop-previous waits until the previous server has drained', () => {
    /** A stand-in LiveKit RoomService in another process: answers ListRooms with `rooms` rooms when the
     *  bearer token is signed by the given pair, 401 otherwise. Resolves with its port. */
    function fakeLiveKit(rooms: number, key: string, secret: string): Promise<{ port: number; stop: () => void }> {
      const code = String.raw`
import base64, hashlib, hmac, http.server, json, sys
rooms, key, secret = int(sys.argv[1]), sys.argv[2], sys.argv[3].encode()
def b64(s): return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        ok = False
        try:
            h, p, sig = self.headers['Authorization'].split(' ', 1)[1].split('.')
            ok = hmac.compare_digest(b64(sig), hmac.new(secret, f'{h}.{p}'.encode(), hashlib.sha256).digest()) and json.loads(b64(p))['iss'] == key
        except Exception: pass
        body = json.dumps({'rooms': [{'name': f'r{i}'} for i in range(rooms)]}).encode() if ok else b'{}'
        self.send_response(200 if ok and self.path.endswith('/ListRooms') else 401)
        self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
s = http.server.HTTPServer(('127.0.0.1', 0), H)
print(s.server_address[1], flush=True)
s.serve_forever()`;
      const child = spawn('python3', ['-I', '-c', code, String(rooms), key, secret], { stdio: ['ignore', 'pipe', 'inherit'] });
      return new Promise((resolve, reject) => {
        child.stdout.once('data', (d: Buffer) => resolve({ port: Number(String(d).trim()), stop: () => child.kill() }));
        child.once('error', reject);
      });
    }
    function onSelfWithPrevious(s: { env: string }, previousUrl: string): void {
      writeFileSync(s.env, `LIVEKIT_URL=${self.url}\nLIVEKIT_API_KEY=${self.key}\nLIVEKIT_API_SECRET=${self.secret}\nLIVEKIT_PREVIOUS_API_KEY=${cloud.key}\nLIVEKIT_PREVIOUS_API_SECRET=${cloud.secret}\nLIVEKIT_EXTRA_URLS=${previousUrl}\n`, { mode: 0o600 });
    }

    it('refuses while the previous server reports active rooms, and keeps the pair', async () => {
      const lk = await fakeLiveKit(2, cloud.key, cloud.secret);
      const s = setup();
      try {
        onSelfWithPrevious(s, `ws://127.0.0.1:${lk.port}`);
        const r = sw(s, 'drop-previous');
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /still has 2 active room/);
        assert.equal(read(s.env).LIVEKIT_PREVIOUS_API_KEY, cloud.key);
        assert.equal(existsSync(s.backups) ? backupsOf(s.backups).length : 0, 0, 'no backup for a refused change');
      } finally { lk.stop(); s.cleanup(); }
    });

    it('drops the pair once the previous server reports no rooms', async () => {
      const lk = await fakeLiveKit(0, cloud.key, cloud.secret);
      const s = setup();
      try {
        onSelfWithPrevious(s, `ws://127.0.0.1:${lk.port}`);
        const r = sw(s, 'drop-previous');
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /no active rooms/);
        assert.equal(read(s.env).LIVEKIT_PREVIOUS_API_KEY, undefined);
        noSecrets(r.stdout + r.stderr);
      } finally { lk.stop(); s.cleanup(); }
    });

    it('refuses when the previous server cannot be asked (wrong key, unreachable) unless the operator confirms', async () => {
      const lk = await fakeLiveKit(0, 'APIother', 'o'.repeat(44));
      const s = setup();
      try {
        onSelfWithPrevious(s, `ws://127.0.0.1:${lk.port}`);
        assert.match(sw(s, 'drop-previous').stderr, /cannot ask the previous server/);
        onSelfWithPrevious(s, 'ws://127.0.0.1:9');
        assert.match(sw(s, 'drop-previous').stderr, /cannot ask the previous server/);
        assert.equal(read(s.env).LIVEKIT_PREVIOUS_API_KEY, cloud.key);
        const r = sw(s, 'drop-previous', '--confirm-no-rooms');
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /confirmed by the operator/);
      } finally { lk.stop(); s.cleanup(); }
    });
  });
});
