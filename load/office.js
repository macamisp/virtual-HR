/**
 * k6 load test for the virtual office (FR-VO-002, FR-VO-013, NFR-PERF-003): N avatars in one
 * office, all on the same floor and close together (the worst case for interest management),
 * walking along the reception–lounge corridor at the client's 10 Hz send rate.
 *
 *   podman run --rm --network host --user 0 -v ./load:/scripts:Z grafana/k6 run \
 *     -e API=http://localhost:3102 -e USERS=200 -e DURATION=5m /scripts/office.js
 *
 * Latency: every move carries the sender's clock (`ct`); the server echoes it in the position
 * entry it batches to observers; latency = observer receive time − ct. k6 VUs share one machine
 * clock, so this is the true end-to-end delay including the up-to-100 ms batching wait.
 * Each VU walks for a few seconds, then stands still for a few (like real people).
 */
import http from 'k6/http';
import ws from 'k6/ws';
import { check, fail, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const API = __ENV.API || 'http://localhost:3102';
const USERS = Number(__ENV.USERS || 200);
const DURATION = __ENV.DURATION || '5m';
const PASSWORD = __ENV.PASSWORD || 'LoadTestPassword123!';
const T = 32;
const ROW_Y = 34 * T + T / 2; // free corridor through the reception, the doorway and the lounge
const MIN_X = 2 * T + T / 2;
const MAX_X = 57 * T + T / 2;
const STEP = 18; // px per 100 ms: 180 px/s, under the server's 200 px/s

function durationMs(d) {
  const m = /^(\d+)(s|m|h)$/.exec(d);
  if (!m) fail(`bad DURATION ${d}`);
  return Number(m[1]) * { s: 1000, m: 60000, h: 3600000 }[m[2]];
}

const latency = new Trend('position_latency', true);
const moveAck = new Trend('move_ack', true);
const rejected = new Rate('move_rejected');
const rejectedBy = new Counter('move_rejected_by_reason');
const entries = new Counter('position_entries');
const messages = new Counter('position_messages');
const bytes = new Counter('position_bytes');
const visible = new Trend('visible_avatars');

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: { office: { executor: 'per-vu-iterations', vus: USERS, iterations: 1, maxDuration: `${Math.ceil(durationMs(DURATION) / 60000) + 3}m` } },
  thresholds: { position_latency: ['p(95)<200'], move_rejected: ['rate<0.01'] },
};

export default function () {
  const email = `load${String(__VU).padStart(3, '0')}@load.test`;
  sleep(Math.random() * 20);
  const res = http.post(`${API}/auth/login`, JSON.stringify({ email, password: PASSWORD }), { headers: { 'Content-Type': 'application/json' } });
  if (res.status !== 201 && res.status !== 200) fail(`login ${email}: ${res.status}`);
  const token = res.json().accessToken;
  const endAt = Date.now() + durationMs(DURATION);
  let ackId = 0;
  const pending = new Map(); // ack id -> { kind, at }
  let x = 0;
  let dirSign = Math.random() < 0.5 ? 1 : -1;
  let walkingUntil = 0;
  let pauseUntil = 0;
  let joined = false;
  const loggedReject = {};
  const seen = new Set();

  ws.connect(`${API.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket`, {}, (socket) => {
    const emit = (event, payload, kind) => {
      ackId += 1;
      pending.set(ackId, { kind, at: Date.now() });
      socket.send(`42${ackId}${JSON.stringify([event, payload])}`);
    };
    const tick = () => {
      if (Date.now() >= endAt) { socket.close(); return; }
      if (!joined) return;
      const now = Date.now();
      if (now > walkingUntil && now < pauseUntil) return; // standing still
      if (now >= pauseUntil) { walkingUntil = now + 2000 + Math.random() * 4000; pauseUntil = walkingUntil + 1000 + Math.random() * 3000; }
      let nx = x + dirSign * STEP;
      if (nx > MAX_X || nx < MIN_X) { dirSign = -dirSign; nx = x + dirSign * STEP; }
      x = nx;
      emit('office:move', { x: Math.round(x), y: ROW_Y, dir: dirSign > 0 ? 0 : 4, ct: Date.now() }, 'move');
    };
    socket.on('message', (msg) => {
      if (msg === '2') { socket.send('3'); return; }
      if (msg.startsWith('0')) { socket.send(`40${JSON.stringify({ token, purpose: 'office' })}`); return; }
      if (msg.startsWith('40')) { emit('office:join', { positions: true }, 'join'); socket.setInterval(tick, 100); return; }
      if (msg.startsWith('44')) fail(`connect_error ${email}: ${msg.slice(2, 200)}`);
      if (msg.startsWith('43')) {
        const m = /^43(\d+)(\[.*\])$/.exec(msg);
        if (!m) return;
        const p = pending.get(Number(m[1]));
        pending.delete(Number(m[1]));
        let body = null;
        try { body = JSON.parse(m[2])[0]; } catch (_) { /* ignore */ }
        if (p && p.kind === 'join') {
          if (!body || !body.ok) fail(`join ${email}: ${msg.slice(0, 200)}`);
          x = body.self.x;
          // First step: from the spawn onto the corridor row.
          // The first step happens on the next tick, like a person who starts walking after arriving.
          joined = true;
        } else if (p && p.kind === 'move') {
          moveAck.add(Date.now() - p.at);
          const ok = !!body && body.ok === true;
          rejected.add(!ok);
          if (!ok) rejectedBy.add(1, { reason: String(body && body.reason) });
          if (!ok && !loggedReject[body && body.reason]) { loggedReject[body && body.reason] = true; console.log(JSON.stringify({ rejectedMove: true, email, reason: body && body.reason, at: [body && body.x, body && body.y], tried: Math.round(x) })); }
          if (!ok && body && body.reason !== 'RATE_LIMITED') x = body.x;
        }
        return;
      }
      if (msg.startsWith('42["office:positions"')) {
        const now = Date.now();
        bytes.add(msg.length);
        messages.add(1);
        const payload = JSON.parse(msg.slice(2))[1];
        for (const e of payload.u) {
          entries.add(1);
          seen.add(e[0]);
          if (e[6]) latency.add(now - e[6]);
        }
        for (const g of payload.gone) seen.delete(g);
        visible.add(seen.size);
      }
    });
    socket.setTimeout(() => socket.close(), durationMs(DURATION) + 60000);
  });
  check(null, { joined: () => joined });
}

export function handleSummary(data) {
  const m = data.metrics;
  const v = (name, stat) => (m[name] && m[name].values && m[name].values[stat] !== undefined ? Math.round(m[name].values[stat] * 100) / 100 : null);
  const s = {
    users: USERS, duration: DURATION,
    positionLatencyMs: { p50: v('position_latency', 'med'), p95: v('position_latency', 'p(95)'), p99: v('position_latency', 'p(99)'), max: v('position_latency', 'max') },
    moveAckMs: { p50: v('move_ack', 'med'), p95: v('move_ack', 'p(95)') },
    moveRejectedRate: v('move_rejected', 'rate'),
    positionMessages: v('position_messages', 'count'), positionEntries: v('position_entries', 'count'), positionMB: v('position_bytes', 'count') && Math.round(v('position_bytes', 'count') / 1e4) / 100,
    visibleAvatars: { avg: v('visible_avatars', 'avg'), max: v('visible_avatars', 'max') },
    thresholds: Object.fromEntries(Object.entries(m).filter(([, x]) => x.thresholds).map(([k, x]) => [k, Object.values(x.thresholds).every((t) => t.ok)])),
  };
  return { [`/scripts/out/${__ENV.SUMMARY || 'office-summary.json'}`]: JSON.stringify(s, null, 2), stdout: JSON.stringify(s, null, 2) + '\n' };
}
