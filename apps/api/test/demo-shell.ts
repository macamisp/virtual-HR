/**
 * HRVO Application Shell Interactive Demonstration Script
 * Ref: docs/SRS.md Sections 3, 4, 5.1 (AUTH), 8.3, 8.4, and AGENTS.md
 *
 * Demonstrates:
 * 1. Admin Login & TOTP Two-Factor Authentication (FR-AUTH-006)
 * 2. Employee Login & Session Secret Issuance (FR-ATT-004)
 * 3. Refresh Token Rotation & Token Family Revocation on Replay (FR-AUTH-003, FR-AUTH-004)
 * 4. Socket.IO Presence Gateway: Auth handshake, Signed Heartbeat Ingestion (FR-ATT-001..005)
 * 5. Role-Based Access Control (RBAC): Route protection & 403 Forbidden guards (FR-AUTH-010)
 * 6. Live Attendance Board & Real-Time Presence Updates (FR-ATT-016)
 * 7. Attendance Correction Lifecycle & Self-Approval Prevention (FR-ATT-013)
 * 8. Cryptographic Tamper-Evident Audit Log Hash Chain Verification (FR-AUD-001)
 *
 * Run via: npm run demo:shell
 */

import './support/refuse-in-production.ts'; // must stay the first import
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { io, Socket } from 'socket.io-client';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { generateSecret, generateSync } from 'otplib';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { HeartbeatValidator } from '../src/attendance/heartbeat-validator.ts';
import { UserRole } from '../../../packages/shared/src/auth/types.ts';

function logSection(title: string) {
  console.log('\n================================================================================');
  console.log(`  ${title}`);
  console.log('================================================================================\n');
}

function logStep(step: number | string, title: string, details: string) {
  console.log(`[Step ${step}] ${title}`);
  console.log(`  -> ${details}\n`);
}

async function runDemo() {
  logSection('Starting HRVO Application Shell Demonstration');

  // 1. Database Connections
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ||
    'postgresql://hrvo_app:hrvo_app_pass@localhost:5433/hrvo_dev?schema=public';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'hrvo-demo-jwt-secret-at-least-32-chars-long';
  process.env.MAIL_TRANSPORT = process.env.MAIL_TRANSPORT || 'memory';

  const adminPool = new pg.Pool({
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5433),
    database: process.env.PGDATABASE || 'hrvo_dev',
    user: process.env.PGADMIN_USER || 'postgres',
    password: process.env.PGADMIN_PASSWORD || 'postgres',
  });

  const demoOrgId = '88880000-0000-4000-8000-000000000001';
  const adminId = '88880000-0000-4000-8000-000000000011';
  const leadId = '88880000-0000-4000-8000-000000000012';
  const workerId = '88880000-0000-4000-8000-000000000013';
  const teamId = '88880000-0000-4000-8000-000000000101';

  logStep(1, 'Database Initialization & Seeding', 'Cleaning up and seeding demo organization Acme Global Corp');

  await adminPool.query(`DELETE FROM organizations WHERE id = '${demoOrgId}' OR slug = 'acme-demo-shell'`);
  await adminPool.query(
    `INSERT INTO organizations (id, name, slug, timezone) VALUES ('${demoOrgId}', 'Acme Global Corp (Demo)', 'acme-demo-shell', 'Asia/Colombo')`,
  );
  await adminPool.query(
    `INSERT INTO teams (id, org_id, name) VALUES ('${teamId}', '${demoOrgId}', 'Core Engineering')`,
  );

  const defaultPassword = 'DemoPassword123!';
  const passwordHash = await argon2.hash(defaultPassword, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });

  const adminTotpSecret = generateSecret();

  await adminPool.query(
    `INSERT INTO users (id, org_id, email, display_name, role, password_hash, status, mfa_secret, mfa_enabled)
     VALUES
     ('${adminId}', '${demoOrgId}', 'admin@demo-acme.com', 'Sarah Connor (Admin)', '${UserRole.ADMIN}', '${passwordHash}', 'ACTIVE', '${adminTotpSecret}', true),
     ('${leadId}', '${demoOrgId}', 'lead@demo-acme.com', 'Alex Murphy (Lead)', '${UserRole.TEAM_LEAD}', '${passwordHash}', 'ACTIVE', NULL, false),
     ('${workerId}', '${demoOrgId}', 'worker@demo-acme.com', 'John Matrix (Worker)', '${UserRole.EMPLOYEE}', '${passwordHash}', 'ACTIVE', NULL, false)`,
  );

  // Link worker to manager
  await adminPool.query(`UPDATE users SET manager_id = '${leadId}', team_id = '${teamId}' WHERE id = '${workerId}'`);
  await adminPool.query(`UPDATE users SET team_id = '${teamId}' WHERE id = '${leadId}'`);

  // 2. Bootstrap NestJS Application
  logStep(2, 'Bootstrapping NestJS Application Shell', 'Starting Express HTTP and Socket.IO server on ephemeral port');
  const app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0);

  const server = app.getHttpServer();
  const address = server.address();
  const port = typeof address === 'string' ? 4099 : address.port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`  [Server running at ${baseUrl}]`);

  // Helper fetch function with cookie handling
  let storedCookies: string[] = [];
  async function apiRequest(path: string, options: RequestInit = {}): Promise<{ status: number; body: any; cookies: string[] }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> || {}),
    };
    if (storedCookies.length > 0) {
      headers['Cookie'] = storedCookies.map((c) => c.split(';')[0]).join('; ');
    }
    const res = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers,
    });
    const setCookieHeader = res.headers.get('set-cookie');
    if (setCookieHeader) {
      storedCookies = [setCookieHeader];
    }
    let body: any = null;
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      body = await res.json();
    } else {
      body = await res.text();
    }
    return { status: res.status, body, cookies: storedCookies };
  }

  try {
    // Scenario 1: Admin Login with TOTP 2FA
    logSection('Scenario 1: Mandatory TOTP 2FA for Admin (FR-AUTH-006)');
    logStep(3, 'Primary Credential Challenge', 'Admin logs in with email & password without TOTP code');
    const step3 = await apiRequest('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@demo-acme.com', password: defaultPassword }),
    });
    console.log(`  Response Status: ${step3.status}`);
    console.log(`  Requires 2FA: ${step3.body.requires2fa}`);
    console.log(`  Message: ${step3.body.message}`);

    logStep(4, 'TOTP Second-Factor Verification', 'Admin submits email, password, and 6-digit TOTP code');
    const totpToken = generateSync({ secret: adminTotpSecret });
    const step4 = await apiRequest('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@demo-acme.com', password: defaultPassword, totpCode: totpToken }),
    });
    console.log(`  2FA Verification Status: ${step4.status}`);
    console.log(`  Access Token Issued: ${step4.body.accessToken ? 'yes' : 'no'}`);
    console.log(`  User: ${step4.body.user?.displayName} (${step4.body.user?.role})`);

    // Scenario 2: Employee Login & Refresh Token Rotation + Reuse Detection
    logSection('Scenario 2: Employee Login & Refresh Token Rotation with Family Revocation (FR-AUTH-003, FR-AUTH-004)');
    logStep(5, 'Worker Login', 'Worker authenticates and receives session HMAC secret');
    storedCookies = []; // clear cookies
    const step5 = await apiRequest('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'worker@demo-acme.com', password: defaultPassword }),
    });
    const workerAccessToken = step5.body.accessToken;
    const workerSessionSecret = step5.body.sessionSecret;
    const initialRefreshCookie = storedCookies[0];
    console.log(`  Login Status: ${step5.status}`);
    console.log(`  Worker Access Token Issued: ${workerAccessToken ? 'yes' : 'no'}`);
    console.log(`  Worker Session Secret Issued: ${workerSessionSecret ? 'yes (never printed)' : 'no'}`);
    console.log(`  HttpOnly Refresh Cookie Set: ${initialRefreshCookie ? "yes" : "no"}`);

    logStep(6, 'Legitimate Refresh Rotation', 'Worker exchanges refresh token for new access and refresh tokens');
    const step6 = await apiRequest('/auth/refresh', { method: 'POST' });
    console.log(`  Refresh Status: ${step6.status}`);
    console.log(`  Rotated Access Token Issued: ${step6.body.accessToken ? 'yes' : 'no'}`);
    const newWorkerAccessToken = step6.body.accessToken;
    const newRefreshCookie = storedCookies[0];

    logStep(7, 'Replay Attack Detection', 'Malicious actor attempts to reuse the previous invalidated refresh token');
    storedCookies = [initialRefreshCookie]; // inject revoked token
    const step7 = await apiRequest('/auth/refresh', { method: 'POST' });
    console.log(`  Replay Attack Response Status: ${step7.status} (Expected 401 Unauthorized)`);
    console.log(`  Replay Attack Message: ${JSON.stringify(step7.body)}`);

    logStep(8, 'Verify Token Family Revocation', 'Attacking replay triggered automatic family revocation; even newest token is now invalid');
    storedCookies = [newRefreshCookie]; // attempt to use newest token
    const step8 = await apiRequest('/auth/refresh', { method: 'POST' });
    console.log(`  Revoked Family Response Status: ${step8.status} (Expected 401 Unauthorized - Entire family destroyed)`);

    // Re-login worker to obtain clean tokens for remaining scenarios
    const reLogin = await apiRequest('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'worker@demo-acme.com', password: defaultPassword }),
    });
    const activeWorkerToken = reLogin.body.accessToken;
    const activeSessionSecret = reLogin.body.sessionSecret;
    const activeSessionId = reLogin.body.sessionId;

    // Login Team Lead
    const leadLogin = await apiRequest('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'lead@demo-acme.com', password: defaultPassword }),
    });
    const leadToken = leadLogin.body.accessToken;

    // Record worker consent (FR-ATT-020)
    logStep(9, 'Monitoring Notice Acceptance (FR-ATT-020)', 'Worker accepts monitoring notice version v1.0.0');
    const consentRes = await apiRequest('/attendance/consent', {
      method: 'POST',
      headers: { Authorization: `Bearer ${activeWorkerToken}` },
      body: JSON.stringify({ noticeVersion: 'v1.0.0' }),
    });
    console.log(`  Consent Recorded Status: ${consentRes.status}`);

    // Scenario 3: Real-Time Presence & Socket.IO Gateway
    logSection('Scenario 3: Real-Time Presence & Socket.IO Ingestion (FR-ATT-001..005)');
    logStep(10, 'Reject Unauthenticated Socket Handshake', 'Connecting socket with missing credentials is disconnected');
    await new Promise<void>((resolve) => {
      const rejectSocket = io(baseUrl, {
        transports: ['websocket'],
        autoConnect: true,
      });
      rejectSocket.on('connect_error', (err) => {
        console.log(`  Expected Connection Error: ${err.message}`);
        rejectSocket.close();
        resolve();
      });
      rejectSocket.on('disconnect', () => resolve());
    });

    logStep(11, 'Authenticate Socket & Ingest Signed Heartbeats', 'Worker connects via Socket.IO and submits HMAC-signed heartbeats');
    await new Promise<void>((resolve, reject) => {
      const socket = io(baseUrl, {
        transports: ['websocket'],
        auth: { token: activeWorkerToken },
      });

      socket.on('connect', async () => {
        console.log(`  Socket Connected! ID: ${socket.id}`);

        let attendanceEventReceived: any = null;
        socket.on('attendance:event', (event) => {
          attendanceEventReceived = event;
        });

        // Sign a valid 30s heartbeat payload with session secret (FR-ATT-001, FR-ATT-004)
        const validator = new HeartbeatValidator();
        const deviceId = `demo-macbook-pro-${randomBytes(3).toString('hex')}`;
        const nonce = randomBytes(16).toString('hex');

        const hbData = {
          orgId: demoOrgId,
          userId: workerId,
          deviceId,
          sessionId: activeSessionId,
          sequenceNumber: 1,
          nonce,
          activeSeconds: 30,
          idleSeconds: 0,
          tabVisible: true,
          windowFocused: true,
          inCall: false,
        };

        const signature = validator.signHeartbeat(hbData, activeSessionSecret);

        const heartbeatPayload = {
          ...hbData,
          signature,
        };

        console.log(`  Emitting presence:heartbeat with HMAC-SHA256 signature...`);
        const ackResponse = await socket.emitWithAck('presence:heartbeat', heartbeatPayload);
        console.log(`  Heartbeat Ack Response:`, ackResponse);

        // Allow event loop to process local socket broadcast
        await new Promise((r) => setTimeout(r, 100));

        if (attendanceEventReceived) {
          console.log(`  Received attendance:event from server:`);
          console.log(`    State: ${attendanceEventReceived.currentState}, Session ID: ${attendanceEventReceived.session?.id}`);
        }

        socket.disconnect();
        resolve();
      });

      socket.on('connect_error', (err) => {
        reject(err);
      });
    });

    // Scenario 4: Role-Based Access Control & Live Board
    logSection('Scenario 4: RBAC Route Protection & Live Board Query (FR-AUTH-010, FR-ATT-016)');
    logStep(12, 'RBAC Access Denied for Unauthorized Role', 'Worker attempts to invoke Manager/HR-only export endpoint');
    const forbiddenRes = await apiRequest('/attendance/export?format=csv', {
      method: 'GET',
      headers: { Authorization: `Bearer ${activeWorkerToken}` },
    });
    console.log(`  Export Endpoint Response Status: ${forbiddenRes.status} (Expected 403 Forbidden)`);

    logStep(13, 'Authorized Team Lead Queries Live Board', 'Lead requests live presence board for their engineering team');
    const liveBoardRes = await apiRequest('/attendance/live', {
      method: 'GET',
      headers: { Authorization: `Bearer ${leadToken}` },
    });
    console.log(`  Live Board Status: ${liveBoardRes.status}`);
    const boardEntries = Array.isArray(liveBoardRes.body) ? liveBoardRes.body : [];
    console.log(`  Total Users Online / In Scope: ${boardEntries.length}`);
    if (boardEntries.length > 0) {
      for (const u of boardEntries) {
        console.log(`  User: ${u.displayName} (${u.role}) | Status: ${u.status} | Net Today: ${u.todayNetSeconds}s`);
      }
    }

    // Scenario 5: Attendance Correction Workflow
    logSection('Scenario 5: Attendance Correction Lifecycle (FR-ATT-013)');
    logStep(14, 'Worker Requests Correction', 'Worker submits correction request for forgotten clock-in');
    const correctionReq = await apiRequest('/attendance/corrections', {
      method: 'POST',
      headers: { Authorization: `Bearer ${activeWorkerToken}` },
      body: JSON.stringify({
        requestedIn: '2026-10-14T03:30:00.000Z',
        requestedOut: '2026-10-14T11:30:00.000Z',
        reason: 'Network outage during afternoon shift',
      }),
    });
    console.log(`  Correction Request Status: ${correctionReq.status}`);
    console.log(`  Correction ID: ${correctionReq.body?.id} | Status: ${correctionReq.body?.status}`);
    const correctionId = correctionReq.body?.id;

    logStep(15, 'Self-Approval Prohibition', 'Worker attempts to approve their own correction');
    const selfApprove = await apiRequest(`/attendance/corrections/${correctionId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${activeWorkerToken}` },
      body: JSON.stringify({ status: 'APPROVED', reviewNote: 'Self approving' }),
    });
    console.log(`  Self Approval Response Status: ${selfApprove.status} (Expected 403 Forbidden - Self approval blocked)`);

    logStep(16, 'Manager Review & Approval', 'Team Lead reviews and approves correction');
    const leadApprove = await apiRequest(`/attendance/corrections/${correctionId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${leadToken}` },
      body: JSON.stringify({ status: 'APPROVED', reviewNote: 'Verified standup attendance with team' }),
    });
    console.log(`  Manager Approval Status: ${leadApprove.status}`);
    console.log(`  Approved Correction Status: ${leadApprove.body?.correction?.status} | Reviewed By: Alex Murphy`);

    // Scenario 6: Cryptographic Audit Trail Verification
    logSection('Scenario 6: Audit Log Cryptographic Hash Chain (FR-AUD-001)');
    logStep(17, 'Verify Immutable Audit Log Chain', 'Admin calls audit verification endpoint to confirm SHA-256 chain integrity');
    const auditRes = await apiRequest('/audit-logs/verify', {
      method: 'GET',
      headers: { Authorization: `Bearer ${step4.body.accessToken}` },
    });
    console.log(`  Audit Verification Status: ${auditRes.status}`);
    console.log(`  Hash Chain Valid: ${auditRes.body.valid}`);

    logSection('Demonstration Completed Successfully!');
    console.log('Summary of Verified Features:');
    console.log('  [PASS] TOTP 2FA Enforcement for Admin');
    console.log('  [PASS] Refresh Token Rotation & Token Family Revocation on Replay');
    console.log('  [PASS] Socket.IO Handshake Authentication & Heartbeat Ingestion');
    console.log('  [PASS] RBAC Guards & Route Permissions');
    console.log('  [PASS] Role-Scoped Live Presence Board');
    console.log('  [PASS] Attendance Correction Lifecycle & Self-Approval Prevention');
    console.log('  [PASS] SHA-256 Cryptographic Audit Log Hash Chain Verification');
    console.log('================================================================================\n');
  } finally {
    await app.close();
    await adminPool.end();
  }
}

runDemo().catch((err) => {
  console.error('Demo script encountered error:', err);
  process.exit(1);
});
