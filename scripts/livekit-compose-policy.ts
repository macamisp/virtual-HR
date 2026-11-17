/**
 * Security and capacity policy for the self-hosted LiveKit Compose project (ADR 067), co-located on
 * the application's 2-vCPU EC2 host. Checked against `docker compose config --format json` of
 * infra/livekit-selfhost (or the parsed file after interpolation):
 *  - exactly caddy, livekit and redis: no Egress (recording needs >= 4 CPUs, more than the host has);
 *  - host networking (LiveKit's VM guidance), no published ports, no other networks;
 *  - every container runs with the LiveKit group (LIVEKIT_GID), whose packets to the EC2 instance
 *    metadata service the host table `inet hrvo_livekit` drops (livekit-guard.sh). With cap_drop ALL
 *    and no-new-privileges nothing inside can change that group, and only Caddy may add a
 *    capability (NET_BIND_SERVICE, for 80/443);
 *  - never privileged, never the host's PID/IPC/user namespace, no devices, no host paths except the
 *    rendered config files (read-only) and Caddy's named data volume;
 *  - images pinned by digest;
 *  - memory, swap, CPU and PID limits within this host's budget, and the kernel's OOM killer prefers
 *    these containers over the application's (oom_score_adj >= 0);
 *  - the LiveKit key pair reaches only livekit, the Redis password only livekit and redis, no AWS keys.
 * Problems name services and settings only, never a value (the rendered config contains secrets).
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

export const LIVEKIT_SERVICES = ['caddy', 'livekit', 'redis'] as const;
const MIB = 1024 * 1024;
/** Upper bounds per service on the co-located host (2 vCPU, ~7.6 GB, application first). */
export const LIVEKIT_LIMITS: Record<(typeof LIVEKIT_SERVICES)[number], { memory: number; cpus: number; caps: string[]; envFiles: string[] }> = {
  caddy: { memory: 256 * MIB, cpus: 0.5, caps: ['NET_BIND_SERVICE'], envFiles: [] },
  livekit: { memory: 1024 * MIB, cpus: 1, caps: [], envFiles: ['secrets.env'] },
  redis: { memory: 128 * MIB, cpus: 0.25, caps: [], envFiles: ['redis.env'] },
};
const CONFIG_MOUNTS: Record<string, string[]> = { caddy: ['generated/caddy.yaml'], livekit: ['generated/livekit.yaml'], redis: [] };
const NAMED_VOLUMES: Record<string, string[]> = { caddy: ['caddy_data'], livekit: [], redis: [] };
const SECRET_VARS: Record<string, string[]> = { caddy: ['LIVEKIT_KEYS', 'REDIS_PASSWORD'], livekit: [], redis: ['LIVEKIT_KEYS'] };
const STATIC_AWS_KEYS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];
const DIGEST = /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/;

function isObj(v: Json | undefined): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const obj = (v: Json | undefined): Obj => (isObj(v) ? v : {});
const list = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
const strings = (v: Json | undefined): string[] => list(v).filter((x): x is string => typeof x === 'string');
const str = (v: Json | undefined): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined);

/** Bytes from a Compose size: a number, "1073741824", "1g", "128m", "64MiB"... (undefined if unset). */
export function sizeBytes(v: Json | undefined): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?)(?:i?b)?$/i.exec(v.trim());
  if (!m) return Number.NaN;
  const unit = { '': 1, k: 1024, m: MIB, g: 1024 * MIB, t: 1024 * 1024 * MIB }[m[2]!.toLowerCase() as '' | 'k' | 'm' | 'g' | 't'];
  return Math.round(Number(m[1]) * unit);
}

function number(v: Json | undefined): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}

/** Bind mounts and named volumes, from either "src:dst[:opts]" strings or Compose's JSON objects. */
function mounts(service: Obj): Array<{ type: 'bind' | 'volume'; source: string; readOnly: boolean }> {
  return list(service.volumes).map((v) => {
    if (typeof v === 'string') {
      const [source = '', , opts = ''] = v.split(':');
      const bind = source.startsWith('.') || source.startsWith('/') || source.startsWith('~');
      return { type: bind ? 'bind' : 'volume', source, readOnly: opts.split(',').includes('ro') };
    }
    const o = obj(v);
    return { type: str(o.type) === 'bind' ? 'bind' : 'volume', source: str(o.source) ?? '', readOnly: o.read_only === true };
  });
}

function envFileNames(service: Obj): string[] {
  const raw = service.env_file;
  const items = typeof raw === 'string' ? [raw] : list(raw);
  return items.map((e) => (typeof e === 'string' ? e : str(obj(e).path) ?? '')).map((p) => p.split('/').pop() ?? p);
}

function environmentNames(service: Obj): string[] {
  const env = service.environment;
  if (Array.isArray(env)) return strings(env).map((e) => e.split('=')[0]!);
  return Object.keys(obj(env));
}

export interface LiveKitPolicyOptions {
  /** LIVEKIT_GID of livekit.env / the host guard's settings. */
  gid: string;
}

export function checkLiveKitCompose(config: Json, { gid }: LiveKitPolicyOptions): string[] {
  const problems: string[] = [];
  const services = obj(obj(config).services);
  const name = str(obj(config).name);
  if (name !== undefined && name !== 'hrvo-livekit') problems.push('project name must be hrvo-livekit (separate from the application project)');

  for (const s of Object.keys(services)) {
    if (!(LIVEKIT_SERVICES as readonly string[]).includes(s)) problems.push(`${s}: unexpected service (only ${LIVEKIT_SERVICES.join(', ')}; no Egress on this host)`);
  }
  for (const s of LIVEKIT_SERVICES) {
    if (!isObj(services[s])) { problems.push(`${s}: missing`); continue; }
    const svc = services[s];
    const limits = LIVEKIT_LIMITS[s];
    const p = (msg: string) => problems.push(`${s}: ${msg}`);

    if (str(svc.network_mode) !== 'host') p('network_mode must be host');
    if (list(svc.ports).length > 0) p('must not publish ports (host networking)');
    if (Object.keys(obj(svc.networks)).length > 0 || list(svc.networks).length > 0) p('must not join networks');
    if (!DIGEST.test(str(svc.image) ?? '')) p('image must be pinned by digest (name[:tag]@sha256:...)');

    // P1: the group the host guard blocks, and no way to change it.
    const user = str(svc.user) ?? '';
    const m = /^([A-Za-z0-9_-]+):(\d+)$/.exec(user);
    if (!m) p('user must be "<user>:<LIVEKIT_GID>" (the group the host guard blocks from instance metadata)');
    else if (m[2] !== gid) p(`user group must be LIVEKIT_GID (${gid})`);
    if (!strings(svc.cap_drop).includes('ALL')) p('cap_drop must include ALL');
    if (!strings(svc.security_opt).some((o) => /^no-new-privileges(:true|=true)?$/.test(o))) p('security_opt must include no-new-privileges:true');
    const added = strings(svc.cap_add);
    for (const c of added) if (!limits.caps.includes(c)) p(`cap_add ${c} is not allowed`);
    if (svc.privileged === true) p('must not be privileged');
    for (const k of ['pid', 'ipc', 'userns_mode'] as const) if (str(svc[k]) === 'host') p(`${k} must not be host`);
    if (list(svc.devices).length > 0) p('must not get devices');

    for (const mnt of mounts(svc)) {
      if (mnt.type === 'bind') {
        if (!CONFIG_MOUNTS[s]!.some((f) => mnt.source.endsWith(f))) p('binds a host path other than its rendered config file');
        else if (!mnt.readOnly) p('config file must be mounted read-only');
      } else if (!NAMED_VOLUMES[s]!.some((v) => mnt.source === v || mnt.source.endsWith(`_${v}`))) {
        p('mounts an unexpected volume');
      }
    }

    // P9: this host's budget.
    const mem = sizeBytes(svc.mem_limit);
    const swap = sizeBytes(svc.memswap_limit);
    if (mem === undefined || Number.isNaN(mem)) p('mem_limit must be set');
    else if (mem > limits.memory) p(`mem_limit above ${limits.memory / MIB} MiB`);
    if (mem !== undefined && swap !== mem) p('memswap_limit must equal mem_limit (no swap)');
    const cpus = number(svc.cpus);
    if (cpus === undefined || cpus <= 0) p('cpus must be set');
    else if (cpus > limits.cpus) p(`cpus above ${limits.cpus}`);
    const pids = number(svc.pids_limit);
    if (pids === undefined || pids <= 0) p('pids_limit must be set');
    const oom = number(svc.oom_score_adj);
    if (oom === undefined || oom < 0) p('oom_score_adj must be >= 0 (the application is protected first)');
    if (str(svc.restart) !== 'unless-stopped' && str(svc.restart) !== 'always') p('restart must be unless-stopped');

    // Secrets reach only the service that needs them.
    const files = envFileNames(svc);
    for (const f of files) if (!limits.envFiles.includes(f)) p(`env_file ${f} is not allowed`);
    const env = environmentNames(svc);
    for (const v of SECRET_VARS[s]!) if (env.includes(v)) p(`must not receive ${v}`);
    for (const v of STATIC_AWS_KEYS) if (env.includes(v)) p(`must not receive ${v}`);
  }
  return problems;
}
