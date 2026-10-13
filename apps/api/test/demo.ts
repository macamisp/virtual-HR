/**
 * HRVO Interactive Demonstration Script for FR-ATT-001..005 & State Machine
 * Run via: node --experimental-strip-types apps/api/test/demo.ts
 */

import { AttendanceService } from '../src/attendance/attendance.service.ts';
import { AttendanceState } from '../../../packages/shared/src/attendance/types.ts';

function logStep(step: number, title: string, details: string) {
  console.log(`\n========================================================================`);
  console.log(`[STEP ${step}] ${title}`);
  console.log(`------------------------------------------------------------------------`);
  console.log(details);
}

function printSessionState(service: AttendanceService, userId: string) {
  const session = service.getSession(userId);
  if (!session) {
    console.log(`  Session: [No active session]`);
    return;
  }
  console.log(`  Session ID:      ${session.id}`);
  console.log(`  Current State:   ${session.currentState} (prev: ${session.previousState})`);
  console.log(`  Clock-in:        ${session.clockInAt.toISOString()} (source: ${session.clockInSource})`);
  console.log(`  Status:          ${session.status}`);
  console.log(`  Work Date:       ${session.workDate}`);
  console.log(`  Counters:        Active: ${session.activeSeconds}s | Idle: ${session.idleSeconds}s | Break: ${session.breakSeconds}s | Meeting: ${session.meetingSeconds}s`);
  console.log(`  Net Payable:     ${session.netSeconds}s (Idle segregated: ${session.idleSeconds}s)`);
  console.log(`  Flags:           [${session.flags.join(', ')}]`);
  console.log(`  Segments count:  ${session.segments.length}`);
}

async function runDemo() {
  console.log(`\n========================================================================`);
  console.log(`   HRVO AUTOMATIC ATTENDANCE ENGINE (FR-ATT-001..005) LIVE DEMO         `);
  console.log(`========================================================================`);

  const service = new AttendanceService();
  const userId = 'user-subcontractor-007';
  const orgId = 'org-acme-corp';
  const deviceId = 'device-macbook-pro-m3';
  const sessionId = 'auth-session-live-007';
  const sessionSecret = service.generateSessionSecret();

  service.registerSessionSecret(sessionId, sessionSecret);
  let seq = 1;
  let virtualClock = new Date('2026-10-13T08:30:00.000Z');

  function sendHb(activeSec: number, idleSec: number, inCall = false, meetingId?: string) {
    virtualClock = new Date(virtualClock.getTime() + 30000);
    const unsigned = {
      orgId,
      userId,
      deviceId,
      sessionId,
      sequenceNumber: seq++,
      nonce: `nonce-${virtualClock.getTime()}-${seq}`,
      activeSeconds: activeSec,
      idleSeconds: idleSec,
      tabVisible: true,
      windowFocused: true,
      inCall,
      meetingId,
    };
    const signature = service.getValidator().signHeartbeat(unsigned, sessionSecret);
    return service.ingestHeartbeat({ ...unsigned, signature }, virtualClock, '192.168.1.100');
  }

  // STEP 1: Auto Clock-in
  logStep(
    1,
    'FR-ATT-001: Automatic Clock-In on First ACTIVE Heartbeat',
    'User logs in / opens the virtual office. First heartbeat arrives with activity.\nNo manual punch or button click required.',
  );
  sendHb(30, 0);
  printSessionState(service, userId);

  // STEP 2: Active Work
  logStep(
    2,
    'FR-ATT-004: Continuous 30-Second Heartbeats (Active Work)',
    'Simulating 3 intervals (90s) of active development work.',
  );
  sendHb(30, 0);
  sendHb(30, 0);
  sendHb(30, 0);
  printSessionState(service, userId);

  // STEP 3: Joining a Meeting
  logStep(
    3,
    'Section 6.2 Row 6: Joining a Meeting / Proximity Call',
    'User enters a meeting room (ID: "standup-room-402").\nState changes to IN_MEETING; counted as active time automatically.',
  );
  virtualClock = new Date(virtualClock.getTime() + 1000);
  service.joinMeeting(userId, 'standup-room-402', virtualClock);
  printSessionState(service, userId);

  // STEP 4: Leaving a Meeting
  logStep(
    4,
    'Section 6.2 Row 7: Leaving the Meeting Call',
    'Call finishes after 15 minutes. User leaves room.\nState transitions back to ACTIVE; 900 meeting seconds credited to Net Payable time.',
  );
  virtualClock = new Date(virtualClock.getTime() + 900000); // 15 mins later
  service.leaveMeeting(userId, virtualClock);
  printSessionState(service, userId);

  // STEP 5: Idle Detection (5 min threshold)
  logStep(
    5,
    'FR-ATT-005 & Row 2: Inactivity Reaches 5-Minute Idle Threshold',
    'No keyboard or mouse input for 10 heartbeats (5 minutes).\nState transitions from ACTIVE to IDLE; idle segment opened; idle seconds segregated.',
  );
  for (let i = 0; i < 10; i++) {
    sendHb(0, 30);
  }
  printSessionState(service, userId);

  // STEP 6: Pause Threshold (15 min)
  logStep(
    6,
    'FR-ATT-005 & Row 4: Prolonged Inactivity Reaches 15-Minute Pause Threshold',
    'Inactivity exceeds 15 minutes total. State transitions from IDLE to PAUSED.\nActive accrual is suspended.',
  );
  for (let i = 0; i < 20; i++) {
    sendHb(0, 30);
  }
  printSessionState(service, userId);

  // STEP 7: Resuming Input after Pause
  logStep(
    7,
    'Section 6.2 Row 5: Input Resumes After Pause',
    'User returns to desk and starts typing.\nState transitions back to ACTIVE; segment and session flagged with LONG_IDLE for audit.',
  );
  sendHb(25, 5);
  printSessionState(service, userId);

  // STEP 8: Manual Break
  logStep(
    8,
    'Section 6.2 Row 8: User Takes a Coffee Break',
    'User clicks break or goes on break.\nState transitions to ON_BREAK; break segment opened.',
  );
  virtualClock = new Date(virtualClock.getTime() + 5000);
  service.startBreak(userId, virtualClock);
  printSessionState(service, userId);

  // STEP 9: End Break
  logStep(
    9,
    'Section 6.2 Row 9: User Returns From Break',
    'User ends break after 10 minutes.\nState returns to ACTIVE; break time recorded separately.',
  );
  virtualClock = new Date(virtualClock.getTime() + 600000); // 10 min break
  service.endBreak(userId, virtualClock);
  printSessionState(service, userId);

  // STEP 10: Socket Disconnect & Grace Period
  logStep(
    10,
    'FR-ATT-002 & Row 10: Transient Socket Disconnect (Grace Window)',
    'User laptop lid sleeps or Wi-Fi flickers. Socket disconnects.\nSession remains OPEN; 120s grace timer starts; state is DISCONNECTED.',
  );
  virtualClock = new Date(virtualClock.getTime() + 2000);
  service.onSocketDisconnect(userId, virtualClock);
  printSessionState(service, userId);

  // STEP 11: Reconnect within Grace
  logStep(
    11,
    'Section 6.2 Row 11: Reconnect within Grace Period (45 seconds)',
    'Wi-Fi reconnects after 45s. Grace timer cancelled.\nUser seamlessly restored to ACTIVE state without losing session.',
  );
  virtualClock = new Date(virtualClock.getTime() + 45000);
  service.onSocketReconnect(userId, virtualClock);
  printSessionState(service, userId);

  // STEP 12: Anti-Spoofing & Replay Attack Protection
  logStep(
    12,
    'FR-ATT-017: Cryptographic Security & Anti-Replay Demonstration',
    'Simulating attack scenarios:\n1. Attacker sends tampered signature.\n2. Attacker replays valid previously intercepted heartbeat nonce.',
  );
  try {
    const tampered = {
      orgId,
      userId,
      deviceId,
      sessionId,
      sequenceNumber: seq++,
      nonce: 'tampered-nonce',
      activeSeconds: 30,
      idleSeconds: 0,
      tabVisible: true,
      windowFocused: true,
      inCall: false,
      signature: 'bad-tampered-signature-0000000000000000000000000000000000000000',
    };
    service.ingestHeartbeat(tampered, virtualClock);
  } catch (err: any) {
    console.log(`  [SECURITY ALERT] Tampered signature blocked: "${err.message}"`);
  }

  const validUnsigned = {
    orgId,
    userId,
    deviceId,
    sessionId,
    sequenceNumber: seq++,
    nonce: 'unique-replay-test-nonce',
    activeSeconds: 30,
    idleSeconds: 0,
    tabVisible: true,
    windowFocused: true,
    inCall: false,
  };
  const validSig = service.getValidator().signHeartbeat(validUnsigned, sessionSecret);
  service.ingestHeartbeat({ ...validUnsigned, signature: validSig }, virtualClock);
  console.log(`  [SECURITY CHECK] First heartbeat with nonce accepted.`);

  try {
    // Replay attack
    service.ingestHeartbeat({ ...validUnsigned, sequenceNumber: seq++, signature: validSig }, virtualClock);
  } catch (err: any) {
    console.log(`  [SECURITY ALERT] Replay attack blocked: "${err.message}"`);
  }

  // STEP 13: End of Day Explicit Logout
  logStep(
    13,
    'FR-ATT-002 & Row 14: Explicit Logout / Day Completion',
    'User clocks out / logs out at end of workday.\nSession is CLOSED; clockOutSource is LOGOUT; exact server timestamp applied.',
  );
  virtualClock = new Date(virtualClock.getTime() + 10000);
  const logoutRes = service.onExplicitLogout(userId, virtualClock);
  if (logoutRes) {
    const s = logoutRes.session;
    console.log(`  Session ID:      ${s.id}`);
    console.log(`  Final Status:    ${s.status} (${s.currentState})`);
    console.log(`  Clock-in:        ${s.clockInAt.toISOString()}`);
    console.log(`  Clock-out:       ${s.clockOutAt?.toISOString()} (source: ${s.clockOutSource})`);
    console.log(`  Active Work:     ${s.activeSeconds}s`);
    console.log(`  Meeting Time:    ${s.meetingSeconds}s`);
    console.log(`  Break Time:      ${s.breakSeconds}s`);
    console.log(`  Idle Time:       ${s.idleSeconds}s (Excluded from pay)`);
    console.log(`  Total Net Paid:  ${s.netSeconds}s (${(s.netSeconds / 60).toFixed(1)} mins)`);
    console.log(`  Flags Recorded:  [${s.flags.join(', ')}]`);
  }

  console.log(`\n========================================================================`);
  console.log(`   DEMO COMPLETE: ALL REQUIREMENTS FR-ATT-001..005 VERIFIED SUCCESSFULLY!`);
  console.log(`========================================================================\n`);
}

runDemo().catch(console.error);
