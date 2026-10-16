/**
 * k6 load test: N users heartbeating over Socket.IO for the test duration (SRS 6, NFR-ACC).
 *
 *   podman run --rm --network host --user 0 -v ./load:/scripts:Z grafana/k6 run \
 *     -e API=http://localhost:3102 -e USERS=200 -e PHONES=20 -e DURATION=15m /scripts/heartbeat.js
 *
 * Each VU signs in as its own seeded user (apps/api/test/seed-load.ts), opens a raw WebSocket to
 * the Socket.IO endpoint, authenticates with its access token in the CONNECT packet, and sends a
 * signed heartbeat every 30 s with an ack id so the server round trip can be measured. VUs above
 * USERS are "phones": a second device of users 1..PHONES, for the double-counting check.
 *
 * Metrics: heartbeat_ack (p95 latency), heartbeat_errors (rate), clockin_latency (first ack,
 * which creates the session: NFR-ACC-001), connect_time, login_time.
 */
import http from 'k6/http';
import ws from 'k6/ws';
import { check, fail, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import crypto from 'k6/crypto';

const API = __ENV.API || 'http://localhost:3102';
const USERS = Number(__ENV.USERS || 200);
const PHONES = Number(__ENV.PHONES || 20);
const DURATION = __ENV.DURATION || '15m';
const INTERVAL_MS = Number(__ENV.INTERVAL_MS || 30000);
const PASSWORD = __ENV.PASSWORD || 'LoadTestPassword123!';
const ORG = 'add00000-0000-4000-8000-000000000001';

const ackLatency = new Trend('heartbeat_ack', true);
const clockinLatency = new Trend('clockin_latency', true);
const connectTime = new Trend('connect_time', true);
const loginTime = new Trend('login_time', true);
const errors = new Rate('heartbeat_errors');
const sent = new Counter('heartbeats_sent');
const acked = new Counter('heartbeats_acked');
const unackedAtClose = new Counter('heartbeats_unacked_at_close');

function durationMs(d) {
  const m = /^(\d+)(s|m|h)$/.exec(d);
  if (!m) fail(`bad DURATION ${d}`);
  return Number(m[1]) * { s: 1000, m: 60000, h: 3600000 }[m[2]];
}

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    heartbeats: {
      executor: 'per-vu-iterations',
      vus: USERS + PHONES,
      iterations: 1,
      // Three minutes of slack beyond DURATION for sign-in, the connection ramp and the last acks.
      maxDuration: `${Math.ceil(durationMs(DURATION) / 60000) + 3}m`,
    },
  },
  thresholds: {
    heartbeat_ack: ['p(95)<500'],
    heartbeat_errors: ['rate<0.01'],
    clockin_latency: ['p(99)<5000'],
  },
};


function login(email) {
  const t0 = Date.now();
  const res = http.post(`${API}/auth/login`, JSON.stringify({ email, password: PASSWORD }), { headers: { 'Content-Type': 'application/json' }, tags: { name: 'login' } });
  loginTime.add(Date.now() - t0);
  if (res.status !== 201 && res.status !== 200) fail(`login ${email}: ${res.status} ${res.body}`);
  const body = res.json();
  if (!body.accessToken || !body.sessionId || !body.sessionSecret) fail(`login ${email}: no session material`);
  return body;
}

function sign(hb, secret) {
  const canonical = [hb.orgId, hb.userId, hb.deviceId, hb.sessionId, hb.sequenceNumber, hb.nonce, hb.activeSeconds, hb.idleSeconds,
    hb.tabVisible ? '1' : '0', hb.windowFocused ? '1' : '0', hb.inCall ? '1' : '0', hb.meetingId || ''].join(':');
  return crypto.hmac('sha256', secret, canonical, 'hex');
}

export default function () {
  const vu = __VU; // 1-based
  const isPhone = vu > USERS;
  const userIndex = isPhone ? vu - USERS : vu;
  const email = `load${String(userIndex).padStart(3, '0')}@load.test`;
  const deviceId = isPhone ? `phone-${userIndex}` : `laptop-${userIndex}`;
  // Spread connections over the first 20 s so the server is not hit by one burst.
  sleep(Math.random() * 20);
  const session = login(email);
  const userId = session.user && session.user.id;
  if (!userId) fail(`login ${email}: no user id`);

  const wsUrl = `${API.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket`;
  const endAt = Date.now() + durationMs(DURATION);
  // Sequence numbers must only ever grow per device (the server keeps the last one it saw), so a
  // rerun with the same device ids starts above any previous run: seconds since epoch, like the web worker.
  let seq = Math.floor(Date.now() / 1000);
  let connectedAt = 0;
  let firstAckPending = true;
  let loggedError = false;
  const pending = new Map(); // ack id -> sent at
  let ackId = 0;
  const openedAt = Date.now();

  const res = ws.connect(wsUrl, { tags: { name: 'socket' } }, (socket) => {
    const sendHeartbeat = () => {
      seq += 1;
      const unsigned = {
        orgId: ORG, userId, deviceId, sessionId: session.sessionId, sequenceNumber: seq, nonce: `${deviceId}-${seq}-${Date.now()}`,
        // The real client reports the activity of the interval just ended; the first heartbeat follows the
        // activity that woke it, so it carries 1 s (heartbeat.worker.ts rounds up to at least 1 s).
        activeSeconds: seq === 1 ? 1 : 30, idleSeconds: 0, tabVisible: true, windowFocused: true, inCall: false,
      };
      const payload = Object.assign({}, unsigned, { signature: sign(unsigned, session.sessionSecret) });
      ackId += 1;
      pending.set(ackId, Date.now());
      socket.send(`42${ackId}${JSON.stringify(['presence:heartbeat', payload])}`);
      sent.add(1);
    };

    socket.on('message', (msg) => {
      if (msg === '2') { socket.send('3'); return; } // engine.io ping -> pong
      if (msg.startsWith('0')) { // engine.io OPEN: authenticate the Socket.IO namespace
        socket.send(`40${JSON.stringify({ token: session.accessToken })}`);
        return;
      }
      if (msg.startsWith('40')) { // connected
        connectedAt = Date.now();
        connectTime.add(connectedAt - openedAt);
        sendHeartbeat();
        socket.setInterval(() => {
          if (Date.now() >= endAt) { socket.close(); return; }
          sendHeartbeat();
        }, INTERVAL_MS);
        return;
      }
      if (msg.startsWith('44')) { errors.add(1); fail(`connect_error ${email}: ${msg.slice(2, 200)}`); }
      if (msg.startsWith('43')) { // ack: 43<id>[{...}]
        const m = /^43(\d+)(\[.*\])$/.exec(msg);
        if (!m) return;
        const id = Number(m[1]);
        const startedAt = pending.get(id);
        pending.delete(id);
        let body = null;
        try { body = JSON.parse(m[2])[0]; } catch (_) { /* ignore */ }
        const ok = !!body && body.success === true;
        errors.add(!ok);
        if (!ok && !loggedError) { loggedError = true; console.log(JSON.stringify({ rejected: true, userId, deviceId, error: body && body.error })); }
        if (ok) {
          acked.add(1);
          const latency = Date.now() - (startedAt || Date.now());
          ackLatency.add(latency);
          if (firstAckPending) { firstAckPending = false; clockinLatency.add(latency); }
        }
        check(body, { 'heartbeat accepted': (b) => !!b && b.success === true });
        return;
      }
    });
    socket.on('error', () => errors.add(1));
    // The instant this device went away, for NFR-ACC-002 (the grace window starts here, not at the last heartbeat).
    socket.on('close', () => console.log(JSON.stringify({ closeEvent: true, userId, deviceId, closedAt: new Date().toISOString() })));
    socket.setTimeout(() => socket.close(), durationMs(DURATION) + 60000);
  });
  check(res, { 'websocket handshake 101': (r) => r && r.status === 101 });
  if (pending.size > 0) unackedAtClose.add(pending.size);
}

export function handleSummary(data) {
  const m = data.metrics;
  const pick = (name, stat) => (m[name] && m[name].values && m[name].values[stat] !== undefined ? Math.round(m[name].values[stat] * 100) / 100 : null);
  const summary = {
    users: USERS, phones: PHONES, duration: DURATION, intervalMs: INTERVAL_MS,
    heartbeatsSent: pick('heartbeats_sent', 'count'), heartbeatsAcked: pick('heartbeats_acked', 'count'), unackedAtClose: pick('heartbeats_unacked_at_close', 'count'),
    ackLatencyMs: { p50: pick('heartbeat_ack', 'med'), p95: pick('heartbeat_ack', 'p(95)'), p99: pick('heartbeat_ack', 'p(99)'), max: pick('heartbeat_ack', 'max') },
    clockinLatencyMs: { p50: pick('clockin_latency', 'med'), p99: pick('clockin_latency', 'p(99)'), max: pick('clockin_latency', 'max') },
    errorRate: pick('heartbeat_errors', 'rate'),
    loginMs: { p95: pick('login_time', 'p(95)') }, connectMs: { p95: pick('connect_time', 'p(95)') },
    thresholds: Object.fromEntries(Object.entries(m).filter(([, v]) => v.thresholds).map(([k, v]) => [k, Object.values(v.thresholds).every((t) => t.ok)])),
  };
  return { [`/scripts/out/${__ENV.SUMMARY || 'summary.json'}`]: JSON.stringify(summary, null, 2), stdout: JSON.stringify(summary, null, 2) + '\n' };
}
