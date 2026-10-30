/**
 * Staging Compose security policy (ADR 047, scripts/staging-compose-policy.ts): the rendered
 * project must keep every container unprivileged and let only the API reach the EC2 instance
 * metadata service. The fixture mirrors `docker compose config --format json` of
 * docker-compose.staging.yml (SSH mode plus the proxy), without secrets.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkStagingCompose, type Json } from '../../../scripts/staging-compose-policy.ts';

const hardened = { security_opt: ['no-new-privileges:true'], cap_drop: ['ALL'] };
const rootCaps = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'];

function rendered() {
  return {
    name: 'hrvo-staging',
    networks: {
      api_egress: {
        name: 'hrvo-staging_api_egress',
        driver_opts: { 'com.docker.network.bridge.name': 'hrvo-api' },
        ipam: { config: [{ subnet: '172.30.1.0/29' }] },
      } as Record<string, Json>,
      edge: { name: 'hrvo-staging_edge', ipam: { config: [{ subnet: '172.30.0.0/24' }] } } as Record<string, Json>,
      data: { name: 'hrvo-staging_data', internal: true } as Record<string, Json>,
    },
    services: {
      proxy: { ...hardened, cap_add: ['NET_BIND_SERVICE'], networks: { edge: null }, ports: [{ target: 443, published: '443' }] },
      web: { ...hardened, networks: { edge: null }, ports: [{ host_ip: '127.0.0.1', target: 3000, published: '3000' }] },
      api: {
        ...hardened,
        environment: { NODE_ENV: 'production', PGPASSWORD: 'value-that-must-not-leak', DOCUMENT_KMS_PROVIDER: 'aws' },
        networks: { api_egress: { gw_priority: 100 }, edge: null, data: null },
        ports: [{ host_ip: '127.0.0.1', target: 3001, published: '3001' }],
        volumes: [{ type: 'bind', source: '/opt/virtual-hr/secrets/db-tls/ca.crt', target: '/run/db-tls/ca.crt', read_only: true }],
      },
      migrate: { ...hardened, networks: { data: null } },
      postgres: { ...hardened, cap_add: rootCaps, networks: { data: null } },
      redis: { ...hardened, user: 'redis', networks: { data: null } },
      storage: { ...hardened, user: 'seaweed', networks: { edge: null, data: null } },
      clamav: { ...hardened, cap_add: rootCaps, networks: { edge: null, data: null } },
    } as Record<string, Record<string, Json>>,
  };
}

function problemsAfter(change: (c: ReturnType<typeof rendered>) => void): string[] {
  const config = rendered();
  change(config);
  return checkStagingCompose(config as unknown as Json, { apiSubnet: '172.30.1.0/29' });
}

function assertFlags(problems: string[], pattern: RegExp): void {
  assert.ok(problems.some((p) => pattern.test(p)), `expected a problem matching ${pattern}, got ${JSON.stringify(problems)}`);
}

describe('staging compose policy (ADR 047)', () => {
  it('accepts the hardened staging project', () => {
    assert.deepEqual(problemsAfter(() => {}), []);
  });

  it('accepts networks in list form', () => {
    assert.deepEqual(problemsAfter((c) => { c.services.web.networks = ['edge']; }), []);
  });

  it('refuses privileged containers and host namespaces', () => {
    assertFlags(problemsAfter((c) => { c.services.web.privileged = true; }), /service web: privileged/);
    assertFlags(problemsAfter((c) => { c.services.web.network_mode = 'host'; }), /service web: network_mode host/);
    assertFlags(problemsAfter((c) => { c.services.clamav.network_mode = 'service:api'; }), /service clamav: network_mode service:api/);
    assertFlags(problemsAfter((c) => { c.services.storage.pid = 'host'; }), /service storage: pid is host/);
    assertFlags(problemsAfter((c) => { c.services.storage.ipc = 'host'; }), /service storage: ipc is host/);
    assertFlags(problemsAfter((c) => { c.services.web.userns_mode = 'host'; }), /service web: userns_mode is host/);
    assertFlags(problemsAfter((c) => { c.services.web.devices = ['/dev/fuse']; }), /service web: has devices/);
  });

  it('requires dropping all capabilities and no-new-privileges on every service', () => {
    assertFlags(problemsAfter((c) => { delete c.services.redis.cap_drop; }), /service redis: cap_drop must include ALL/);
    assertFlags(problemsAfter((c) => { c.services.redis.cap_drop = ['NET_RAW']; }), /service redis: cap_drop must include ALL/);
    assertFlags(problemsAfter((c) => { delete c.services.web.security_opt; }), /service web: security_opt must include no-new-privileges/);
    assertFlags(problemsAfter((c) => { c.services.web.security_opt = ['no-new-privileges:true', 'seccomp=unconfined']; }), /service web: seccomp or AppArmor is unconfined/);
  });

  it('refuses capabilities that allow forging addresses or changing the network', () => {
    for (const cap of ['NET_RAW', 'NET_ADMIN', 'SYS_ADMIN', 'ALL', 'cap_net_raw']) {
      assertFlags(problemsAfter((c) => { c.services.storage.cap_add = [cap]; }), /service storage: cap_add (NET_RAW|NET_ADMIN|SYS_ADMIN|ALL) is not allowed/);
    }
  });

  it('refuses the Docker socket and host system paths', () => {
    for (const source of ['/var/run/docker.sock', '/run/docker.sock', '/', '/proc', '/etc/shadow']) {
      assertFlags(problemsAfter((c) => {
        c.services.web.volumes = [{ type: 'bind', source, target: '/x' }];
      }), /service web: mounts host path/);
    }
  });

  it('lets no service but the API join the metadata-service network', () => {
    assertFlags(problemsAfter((c) => { c.services.web.networks = { edge: null, api_egress: null }; }), /service web: joins api_egress/);
    assertFlags(problemsAfter((c) => { c.services.clamav.networks = ['edge', 'api_egress']; }), /service clamav: joins api_egress/);
  });

  it("requires the API's default route through its own network", () => {
    assertFlags(problemsAfter((c) => { c.services.api.networks = { api_egress: null, edge: null, data: null }; }), /gw_priority of api_egress must be higher than edge/);
    assertFlags(problemsAfter((c) => { c.services.api.networks = { api_egress: { gw_priority: 100 }, edge: { gw_priority: 100 }, data: null }; }), /higher than edge/);
    assertFlags(problemsAfter((c) => { c.services.api.networks = { edge: null, data: null }; }), /service api: must join api_egress/);
  });

  it('requires exactly one network on the guarded bridge, with egress and the configured subnet', () => {
    assertFlags(problemsAfter((c) => { delete c.networks.api_egress.driver_opts; }), /exactly one network must use bridge hrvo-api \(found 0\)/);
    assertFlags(problemsAfter((c) => { c.networks.edge.driver_opts = { 'com.docker.network.bridge.name': 'hrvo-api' }; }), /found 2/);
    assertFlags(problemsAfter((c) => { c.networks.api_egress.internal = true; }), /network api_egress: must not be internal/);
    assertFlags(problemsAfter((c) => { c.networks.api_egress.ipam = { config: [{ subnet: '172.30.9.0/29' }] }; }), /subnet does not match API_SUBNET/);
  });

  it('keeps the databases on internal networks and IPv6 off', () => {
    assertFlags(problemsAfter((c) => { c.services.postgres.networks = { data: null, edge: null }; }), /service postgres: joins edge, which is not internal/);
    assertFlags(problemsAfter((c) => { c.services.redis.networks = ['data', 'api_egress']; }), /service redis: joins api_egress/);
    assertFlags(problemsAfter((c) => { c.networks.edge.enable_ipv6 = true; }), /network edge: enable_ipv6/);
  });

  it('lets only the proxy publish on a non-loopback address', () => {
    assertFlags(problemsAfter((c) => { c.services.web.ports = [{ target: 3000, published: '3000' }]; }), /service web: publishes a port on all addresses/);
    assertFlags(problemsAfter((c) => { c.services.api.ports = [{ host_ip: '0.0.0.0', target: 3001, published: '3001' }]; }), /service api: publishes a port on 0.0.0.0/);
    assert.deepEqual(problemsAfter((c) => { c.services.web.ports = [{ host_ip: '::1', target: 3000, published: '3000' }]; }), []);
  });

  it('refuses static AWS keys (the API uses the instance role)', () => {
    assertFlags(problemsAfter((c) => { (c.services.api.environment as Record<string, Json>).AWS_ACCESS_KEY_ID = 'x'; }), /service api: sets AWS_ACCESS_KEY_ID/);
    assertFlags(problemsAfter((c) => { c.services.web.environment = ['AWS_SECRET_ACCESS_KEY=x']; }), /service web: sets AWS_SECRET_ACCESS_KEY/);
  });

  it('never repeats a configuration value in a problem', () => {
    const problems = problemsAfter((c) => {
      c.services.api.privileged = true;
      (c.services.api.environment as Record<string, Json>).AWS_ACCESS_KEY_ID = 'AKIA-value-that-must-not-leak';
    });
    assert.ok(problems.length >= 2);
    assert.ok(problems.every((p) => !p.includes('value-that-must-not-leak')));
  });

  it('refuses an empty configuration', () => {
    assert.deepEqual(checkStagingCompose({}), ['no services in the rendered configuration']);
  });
});
