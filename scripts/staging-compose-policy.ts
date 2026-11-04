/**
 * Security policy for the rendered staging Compose project (ADR 046, ADR 047), checked against the
 * output of `docker compose ... config --format json` before every deployment:
 *  - no container is privileged, shares the host's network, PID, IPC or user namespace, mounts the
 *    Docker socket or host system paths, or gets devices;
 *  - every container drops all capabilities and sets no-new-privileges; it may add back only a few
 *    file-ownership and user-switching capabilities (never NET_RAW, NET_ADMIN or SYS_ADMIN, which
 *    would let it forge addresses or change the network);
 *  - exactly one network uses the bridge the metadata guard allows (hrvo-api), only `api` joins it,
 *    and the API's default route goes through it (highest gw_priority);
 *  - PostgreSQL and Redis sit only on internal networks; no network enables IPv6;
 *  - only the proxy may publish a port on a non-loopback address;
 *  - no container receives static AWS keys (the API uses the instance role).
 * Problems name services, networks and setting names only, never a value (the rendered config
 * contains secrets).
 */

export const IMDS_BRIDGE = 'hrvo-api';
export const IMDS_SERVICE = 'api';
const BRIDGE_NAME_OPTION = 'com.docker.network.bridge.name';
const ALLOWED_CAPS = new Set(['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID', 'NET_BIND_SERVICE']);
const INTERNAL_ONLY = ['postgres', 'redis'];
const PUBLIC_SERVICE = 'proxy';
const LOOPBACK = new Set(['127.0.0.1', '::1']);
const HOST_PATHS = ['/var/run/docker.sock', '/run/docker.sock', '/run/containerd', '/proc', '/sys', '/dev', '/etc', '/boot', '/root'];
const STATIC_AWS_KEYS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

function isObj(v: Json | undefined): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function obj(v: Json | undefined): Obj {
  return isObj(v) ? v : {};
}
function list(v: Json | undefined): Json[] {
  return Array.isArray(v) ? v : [];
}
function strings(v: Json | undefined): string[] {
  return list(v).filter((x): x is string => typeof x === 'string');
}
function str(v: Json | undefined): string | undefined {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
}

export interface PolicyOptions {
  /** Expected subnet of the API network (API_SUBNET in /etc/default/hrvo-imds-guard). */
  apiSubnet?: string;
}

export function serviceNames(config: Json): string[] {
  return Object.keys(obj(obj(config).services));
}

export function checkStagingCompose(config: Json, options: PolicyOptions = {}): string[] {
  const problems: string[] = [];
  const services = obj(obj(config).services);
  const networks = obj(obj(config).networks);
  if (Object.keys(services).length === 0) return ['no services in the rendered configuration'];

  for (const [name, raw] of Object.entries(services)) {
    const svc = obj(raw);
    const at = `service ${name}`;
    if (svc.privileged === true) problems.push(`${at}: privileged`);
    const netMode = str(svc.network_mode);
    if (netMode !== undefined && netMode !== 'bridge' && netMode !== 'none') {
      problems.push(`${at}: network_mode ${netMode} (shares another network namespace)`);
    }
    for (const key of ['pid', 'ipc', 'userns_mode', 'uts', 'cgroup'] as const) {
      if (str(svc[key]) === 'host') problems.push(`${at}: ${key} is host`);
    }
    if (list(svc.devices).length > 0) problems.push(`${at}: has devices`);

    const capDrop = strings(svc.cap_drop).map((c) => c.toUpperCase());
    if (!capDrop.includes('ALL')) problems.push(`${at}: cap_drop must include ALL`);
    for (const cap of strings(svc.cap_add).map((c) => c.toUpperCase().replace(/^CAP_/, ''))) {
      if (!ALLOWED_CAPS.has(cap)) problems.push(`${at}: cap_add ${cap} is not allowed`);
    }
    const secOpt = strings(svc.security_opt).map((o) => o.replace(/\s/g, '').toLowerCase());
    if (!secOpt.some((o) => o === 'no-new-privileges:true' || o === 'no-new-privileges')) {
      problems.push(`${at}: security_opt must include no-new-privileges:true`);
    }
    if (secOpt.some((o) => o.endsWith('=unconfined') || o.endsWith(':unconfined'))) {
      problems.push(`${at}: seccomp or AppArmor is unconfined`);
    }

    for (const vol of list(svc.volumes)) {
      const v = obj(vol);
      const source = str(v.source) ?? '';
      if (str(v.type) === 'bind' && (source === '/' || HOST_PATHS.some((p) => source === p || source.startsWith(`${p}/`)))) {
        problems.push(`${at}: mounts host path ${source}`);
      }
    }

    for (const port of list(svc.ports)) {
      const hostIp = str(obj(port).host_ip);
      if (name !== PUBLIC_SERVICE && (hostIp === undefined || !LOOPBACK.has(hostIp))) {
        problems.push(`${at}: publishes a port on ${hostIp ?? 'all addresses'} (only ${PUBLIC_SERVICE} may; others bind 127.0.0.1)`);
      }
    }

    const env = svc.environment;
    const envKeys = isObj(env) ? Object.keys(env) : strings(env).map((e) => e.split('=')[0]);
    for (const key of STATIC_AWS_KEYS) {
      if (envKeys.includes(key)) problems.push(`${at}: sets ${key} (use the instance role, not static AWS keys)`);
    }
  }

  // Networks: which compose keys use the guarded bridge, and who joins what.
  const imdsNetworks = Object.entries(networks)
    .filter(([, n]) => str(obj(obj(n).driver_opts)[BRIDGE_NAME_OPTION]) === IMDS_BRIDGE)
    .map(([key]) => key);
  for (const [key, raw] of Object.entries(networks)) {
    if (obj(raw).enable_ipv6 === true) problems.push(`network ${key}: enable_ipv6 (the staging host is IPv4 only)`);
  }
  if (imdsNetworks.length !== 1) {
    problems.push(`exactly one network must use bridge ${IMDS_BRIDGE} (found ${imdsNetworks.length})`);
  }
  const attached = (svc: Obj): Obj => {
    const nets = svc.networks;
    if (Array.isArray(nets)) return Object.fromEntries(strings(nets).map((n) => [n, null]));
    return obj(nets);
  };
  for (const key of imdsNetworks) {
    const net = obj(networks[key]);
    if (net.internal === true) problems.push(`network ${key}: must not be internal (the API's egress)`);
    if (options.apiSubnet !== undefined) {
      const subnets = list(obj(net.ipam).config).map((c) => str(obj(c).subnet));
      if (!subnets.includes(options.apiSubnet)) problems.push(`network ${key}: subnet does not match API_SUBNET of the metadata guard`);
    }
    for (const [name, raw] of Object.entries(services)) {
      if (name !== IMDS_SERVICE && key in attached(obj(raw))) {
        problems.push(`service ${name}: joins ${key}, the only network allowed to reach the instance metadata service`);
      }
    }
    const api = obj(services[IMDS_SERVICE]);
    const apiNets = attached(api);
    if (!(key in apiNets)) {
      problems.push(`service ${IMDS_SERVICE}: must join ${key}`);
    } else {
      const prio = (n: Json | undefined): number => Number(str(obj(n).gw_priority) ?? 0);
      const own = prio(apiNets[key]);
      for (const [other, cfg] of Object.entries(apiNets)) {
        if (other !== key && prio(cfg) >= own) {
          problems.push(`service ${IMDS_SERVICE}: gw_priority of ${key} must be higher than ${other} (its default route)`);
        }
      }
    }
  }

  for (const name of INTERNAL_ONLY) {
    const svc = services[name];
    if (svc === undefined) continue;
    for (const key of Object.keys(attached(obj(svc)))) {
      if (obj(networks[key]).internal !== true) problems.push(`service ${name}: joins ${key}, which is not internal`);
    }
  }
  return problems;
}
