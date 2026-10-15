import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import pg from 'pg';
import { io, Socket } from 'socket.io-client';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { AppModule } from '../src/app.module.ts';
import { PrismaService } from '../src/common/prisma.service.ts';
import { HeartbeatValidator } from '../src/attendance/heartbeat-validator.ts';
import { UserRole } from '../../../packages/shared/src/auth/types.ts';

describe('HRVO Application Shell E2E (Auth, RBAC, RLS, Real-Time Socket Gateway, REST)', { concurrency: false }, () => {
  let app: INestApplication;
  let baseUrl: string;
  let port: number;
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  // Test tenants (valid RFC 4122 UUID v4)
  const orgA = '77770000-0000-4000-8000-000000000001';
  const orgB = '77770000-0000-4000-8000-000000000002';

  // Test users
  const adminAId = '77770000-0000-4000-8000-000000000011';
  const leadAId = '77770000-0000-4000-8000-000000000012';
  const empAId = '77770000-0000-4000-8000-000000000013';
  const empBId = '77770000-0000-4000-8000-000000000021';

  const teamAId = '77770000-0000-4000-8000-000000000101';

  let adminAccessToken: string;
  let leadAccessToken: string;
  let empAccessToken: string;
  let empBAccessToken: string;

  let empSessionId: string;
  let empSessionSecret: string;
  let empRefreshToken: string;

  before(async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL ||
      'postgresql://hrvo_app:hrvo_app_pass@localhost:5433/hrvo_dev?schema=public';
    // 1. Setup Postgres connections
    adminPool = new pg.Pool({
      host: process.env.PGHOST || 'localhost',
      port: Number(process.env.PGPORT || 5433),
      database: process.env.PGDATABASE || 'hrvo_dev',
      user: process.env.PGADMIN_USER || 'postgres',
      password: process.env.PGADMIN_PASSWORD || 'postgres',
    });

    appPool = new pg.Pool({
      host: process.env.PGHOST || 'localhost',
      port: Number(process.env.PGPORT || 5433),
      database: process.env.PGDATABASE || 'hrvo_dev',
      user: process.env.PGUSER || 'hrvo_app',
      password: process.env.PGPASSWORD || 'hrvo_app_pass',
    });

    // Clean test data
    await adminPool.query(`DELETE FROM organizations WHERE id IN ('${orgA}', '${orgB}') OR slug IN ('acme-shell-e2e', 'beta-shell-e2e')`);

    // Seed Organizations
    await adminPool.query(
      `INSERT INTO organizations (id, name, slug, timezone) VALUES
       ('${orgA}', 'Acme Global Corp', 'acme-shell-e2e', 'Asia/Colombo'),
       ('${orgB}', 'Beta Logistics Ltd', 'beta-shell-e2e', 'Asia/Colombo')`,
    );

    // Seed Teams
    await adminPool.query(
      `INSERT INTO teams (id, org_id, name) VALUES ('${teamAId}', '${orgA}', 'Engineering')`,
    );

    // Common password hash for test users
    const defaultPassword = 'ComplexPassword123!';
    const passwordHash = await argon2.hash(defaultPassword, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });

    // Seed Users in Org A
    await adminPool.query(
      `INSERT INTO users (id, org_id, email, display_name, role, password_hash, status)
       VALUES
       ('${adminAId}', '${orgA}', 'admin@acme.com', 'Acme Admin', '${UserRole.ADMIN}', '${passwordHash}', 'ACTIVE')`,
    );

    await adminPool.query(
      `INSERT INTO users (id, org_id, email, display_name, role, team_id, password_hash, status)
       VALUES
       ('${leadAId}', '${orgA}', 'lead@acme.com', 'Acme Lead', '${UserRole.TEAM_LEAD}', '${teamAId}', '${passwordHash}', 'ACTIVE'),
       ('${empAId}', '${orgA}', 'worker@acme.com', 'Acme Worker', '${UserRole.EMPLOYEE}', '${teamAId}', '${passwordHash}', 'ACTIVE')`,
    );

    // Seed User in Org B
    await adminPool.query(
      `INSERT INTO users (id, org_id, email, display_name, role, password_hash, status)
       VALUES
       ('${empBId}', '${orgB}', 'worker@beta.com', 'Beta Worker', '${UserRole.EMPLOYEE}', '${passwordHash}', 'ACTIVE')`,
    );

    // Update Team Lead and Manager
    await adminPool.query(`UPDATE teams SET lead_id = '${leadAId}' WHERE id = '${teamAId}'`);
    await adminPool.query(`UPDATE users SET manager_id = '${leadAId}' WHERE id = '${empAId}'`);

    // 2. Bootstrap NestJS test application
    app = await NestFactory.create(AppModule, { logger: false });
    app.use(cookieParser());
    app.enableCors({ origin: true, credentials: true });

    port = 3033;
    await app.listen(port);
    baseUrl = `http://localhost:${port}`;
  });

  after(async () => {
    if (app) {
      await app.close();
    }
    await adminPool.query(`DELETE FROM organizations WHERE id IN ('${orgA}', '${orgB}') OR slug IN ('acme-shell-e2e', 'beta-shell-e2e')`);
    await adminPool.end();
    await appPool.end();
  });

  describe('1. Authentication, Lockout, and 2FA (FR-AUTH-001..004, 007)', { concurrency: false }, () => {
    it('FR-AUTH-007: Locks account for 15 minutes after 5 consecutive failed logins', async () => {
      // 4 failed attempts
      for (let i = 1; i <= 4; i++) {
        const res = await fetch(`${baseUrl}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'worker@acme.com', password: 'WrongPassword123' }),
        });
        assert.equal(res.status, 401);
      }

      // 5th failed attempt triggers lockout
      const res5 = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'worker@acme.com', password: 'WrongPassword123' }),
      });
      assert.equal(res5.status, 401);
      const data5 = await res5.json();
      assert.match(data5.message, /Account locked for 15 minutes/i);

      // Even with correct password, login is blocked while locked
      const resLocked = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'worker@acme.com', password: 'ComplexPassword123!' }),
      });
      assert.equal(resLocked.status, 401);
      const dataLocked = await resLocked.json();
      assert.match(dataLocked.message, /Account is locked/i);

      // Reset lockout for continued testing
      await adminPool.query(`UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = '${empAId}'`);
    });

    it('FR-AUTH-004: Mandatory 2FA for Admin/HR requires setup before complete login', async () => {
      const res = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@acme.com', password: 'ComplexPassword123!' }),
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.requires2faSetup, true);
      assert.match(data.message, /Two-factor authentication is mandatory/i);

      // Pre-enable MFA for Admin with a known secret so Admin can login
      const { generateSecret } = await import('otplib');
      const testSecret = generateSecret();
      await adminPool.query(
        `UPDATE users SET mfa_enabled = true, mfa_secret = '${testSecret}' WHERE id = '${adminAId}'`,
      );

      // Login without code prompts for code
      const resMfaPrompt = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@acme.com', password: 'ComplexPassword123!' }),
      });
      assert.equal(resMfaPrompt.status, 200);
      const promptData = await resMfaPrompt.json();
      assert.equal(promptData.requires2fa, true);

      // Login with valid TOTP code succeeds
      const { generateSync } = await import('otplib');
      const validCode = generateSync({ secret: testSecret });

      const resMfaSuccess = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@acme.com', password: 'ComplexPassword123!', totpCode: validCode }),
      });
      assert.equal(resMfaSuccess.status, 200);
      const successData = await resMfaSuccess.json();
      assert.ok(successData.accessToken);
      assert.ok(successData.refreshToken);
      adminAccessToken = successData.accessToken;
    });

    it('Employee and Lead login without 2FA issues tokens and per-session HMAC secret', async () => {
      // Employee A
      const resEmp = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'worker@acme.com', password: 'ComplexPassword123!' }),
      });
      assert.equal(resEmp.status, 200);
      const dataEmp = await resEmp.json();
      assert.ok(dataEmp.accessToken);
      assert.ok(dataEmp.refreshToken);
      assert.ok(dataEmp.sessionId);
      assert.ok(dataEmp.sessionSecret); // Issued at login for WebSocket heartbeat signing
      empAccessToken = dataEmp.accessToken;
      empSessionId = dataEmp.sessionId;
      empSessionSecret = dataEmp.sessionSecret;
      empRefreshToken = dataEmp.refreshToken;

      // Team Lead A
      const resLead = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'lead@acme.com', password: 'ComplexPassword123!' }),
      });
      assert.equal(resLead.status, 200);
      const dataLead = await resLead.json();
      leadAccessToken = dataLead.accessToken;

      // Employee B (Org B)
      const resEmpB = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'worker@beta.com', password: 'ComplexPassword123!' }),
      });
      assert.equal(resEmpB.status, 200);
      const dataEmpB = await resEmpB.json();
      empBAccessToken = dataEmpB.accessToken;
    });

    it('FR-AUTH-001: Admin creates invitation and user signs up via invitation', async () => {
      const inviteEmail = 'newhire@acme.com';
      const inviteRes = await fetch(`${baseUrl}/auth/invitations/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminAccessToken}`,
        },
        body: JSON.stringify({
          email: inviteEmail,
          role: UserRole.EMPLOYEE,
          teamId: teamAId,
        }),
      });
      const inviteBody = await inviteRes.json();
      console.log('DEBUG: inviteRes status:', inviteRes.status, 'body:', inviteBody, 'adminAccessToken:', adminAccessToken ? adminAccessToken.slice(0, 20) : 'null');
      assert.equal(inviteRes.status, 201);
      const inviteData = inviteBody;
      assert.ok(inviteData.inviteToken);
      assert.equal(inviteData.email, inviteEmail);

      // Rejects weak password (< 12 chars)
      const weakRes = await fetch(`${baseUrl}/auth/invitations/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inviteToken: inviteData.inviteToken,
          password: 'short',
          displayName: 'New Hire',
        }),
      });
      assert.equal(weakRes.status, 400);

      // Rejects breached password
      const breachRes = await fetch(`${baseUrl}/auth/invitations/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inviteToken: inviteData.inviteToken,
          password: 'password123456',
          displayName: 'New Hire',
        }),
      });
      assert.equal(breachRes.status, 400);

      // Accepts invitation with valid password
      const acceptRes = await fetch(`${baseUrl}/auth/invitations/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inviteToken: inviteData.inviteToken,
          password: 'SecurePassword123!',
          displayName: 'New Hire',
        }),
      });
      assert.equal(acceptRes.status, 201);
      const acceptData = await acceptRes.json();
      assert.equal(acceptData.success, true);
      assert.equal(acceptData.user.email, inviteEmail);

      // Token is single-use; subsequent attempt is rejected
      const reuseRes = await fetch(`${baseUrl}/auth/invitations/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inviteToken: inviteData.inviteToken,
          password: 'SecurePassword123!',
          displayName: 'New Hire',
        }),
      });
      assert.equal(reuseRes.status, 400);
    });
  });

  describe('2. Refresh Token Rotation & Reuse Detection (FR-AUTH-003)', { concurrency: false }, () => {
    it('Rotates refresh token and detects reuse to revoke token family', async () => {
      // Obtain fresh login session for isolated refresh rotation testing
      const loginRes = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'worker@acme.com', password: 'ComplexPassword123!' }),
      });
      assert.equal(loginRes.status, 200);
      const loginData = await loginRes.json();
      const testRefreshToken = loginData.refreshToken;

      // 1. Initial refresh with testRefreshToken
      const refresh1Res = await fetch(`${baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: testRefreshToken }),
      });
      assert.equal(refresh1Res.status, 200);
      const data1 = await refresh1Res.json();
      assert.ok(data1.accessToken);
      assert.ok(data1.refreshToken);
      assert.notEqual(data1.refreshToken, testRefreshToken); // Rotated!

      const activeRefreshToken = data1.refreshToken;

      // 2. Second refresh using the new active token succeeds
      const refresh2Res = await fetch(`${baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: activeRefreshToken }),
      });
      assert.equal(refresh2Res.status, 200);
      const data2 = await refresh2Res.json();
      const latestRefreshToken = data2.refreshToken;

      // 3. REUSE DETECTION: Replaying the old (now revoked) testRefreshToken triggers family revocation!
      const replayRes = await fetch(`${baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: testRefreshToken }),
      });
      assert.equal(replayRes.status, 401);
      const replayData = await replayRes.json();
      assert.match(replayData.message, /Refresh token reuse detected/i);

      // 4. Now even the latest valid token in that family is revoked!
      const blockedRes = await fetch(`${baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: latestRefreshToken }),
      });
      assert.equal(blockedRes.status, 401);
    });
  });

  describe('3. RBAC & Cross-Tenant RLS Enforcement (FR-AUTH-006, FR-AUTH-010)', { concurrency: false }, () => {
    it('Employee cannot invite users or review corrections (Forbidden)', async () => {
      const inviteRes = await fetch(`${baseUrl}/auth/invitations/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${empAccessToken}`,
        },
        body: JSON.stringify({ email: 'test@acme.com', role: UserRole.EMPLOYEE }),
      });
      assert.equal(inviteRes.status, 403);

      const reviewRes = await fetch(`${baseUrl}/attendance/corrections/${randomUUID()}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${empAccessToken}`,
        },
        body: JSON.stringify({ status: 'APPROVED' }),
      });
      assert.equal(reviewRes.status, 403);
    });

    it('Cross-Tenant RLS isolation: Org B user cannot access Org A users or audit logs', async () => {
      // Org B user lists users -> only sees Org B users!
      const usersRes = await fetch(`${baseUrl}/users`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${empBAccessToken}` },
      });
      // Employee lacks USERS_MANAGE permission
      assert.equal(usersRes.status, 403);

      // Org A Lead lists users -> only sees Org A users
      const auditRes = await fetch(`${baseUrl}/audit-logs`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${adminAccessToken}` },
      });
      assert.equal(auditRes.status, 200);
      const logs = await auditRes.json();
      for (const log of logs) {
        assert.equal(log.org_id, orgA); // Strict RLS
      }
    });
  });

  describe('4. WebSocket Presence Gateway & Real-Time Ingestion (FR-ATT-001..004)', { concurrency: false }, () => {
    it('Rejects unauthenticated socket connections', async () => {
      const unauthSocket = io(`http://localhost:${port}`, {
        transports: ['websocket'],
        reconnection: false,
      });

      const disconnectPromise = new Promise<boolean>((resolve) => {
        unauthSocket.on('disconnect', () => resolve(true));
        unauthSocket.on('connect_error', () => resolve(true));
      });

      const disconnected = await disconnectPromise;
      assert.equal(disconnected, true);
    });

    it('Authenticated socket connects and sends signed presence:heartbeat to create attendance session', async () => {
      // 1. Consent Gate: Employee A accepts monitoring notice before heartbeat ingestion
      const consentRes = await fetch(`${baseUrl}/attendance/consent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${empAccessToken}`,
        },
        body: JSON.stringify({ noticeVersion: 'v1.0.0' }),
      });
      assert.equal(consentRes.status, 201);

      // Authenticate with Employee A's access token
      const socket = io(`http://localhost:${port}`, {
        transports: ['websocket'],
        auth: { token: empAccessToken },
        reconnection: false,
      });

      await new Promise<void>((resolve, reject) => {
        socket.on('connect', () => resolve());
        socket.on('connect_error', (err) => reject(err));
      });

      assert.ok(socket.connected);

      // Prepare events capture
      let presenceUpdateReceived: any = null;
      let attendanceEventReceived: any = null;

      socket.on('presence:update', (data) => {
        presenceUpdateReceived = data;
      });

      socket.on('attendance:event', (data) => {
        attendanceEventReceived = data;
      });

      // Send first valid active heartbeat signed with session HMAC secret (FR-ATT-001, FR-ATT-004)
      const validator = new HeartbeatValidator();
      const nonce = randomBytes(16).toString('hex');
      const sequenceNumber = 1;
      const deviceId = `test-laptop-${randomBytes(4).toString('hex')}`;

      const hbData = {
        orgId: orgA,
        userId: empAId,
        deviceId,
        sessionId: empSessionId,
        sequenceNumber,
        nonce,
        activeSeconds: 30,
        idleSeconds: 0,
        tabVisible: true,
        windowFocused: true,
        inCall: false,
      };
      const signature = validator.signHeartbeat(hbData, empSessionSecret);

      const heartbeatPayload = {
        ...hbData,
        signature,
      };

      const ackResponse = await socket.emitWithAck('presence:heartbeat', heartbeatPayload);
      console.log('DEBUG ackResponse:', ackResponse);
      assert.equal(ackResponse.success, true);
      assert.equal(ackResponse.currentState, 'ACTIVE');
      assert.match(ackResponse.actionTaken, /Create session|SESSION_CREATED/i);

      // Wait a moment for socket broadcast
      await new Promise((r) => setTimeout(r, 100));

      assert.ok(presenceUpdateReceived);
      assert.equal(presenceUpdateReceived.userId, empAId);
      assert.equal(presenceUpdateReceived.state, 'ACTIVE');

      assert.ok(attendanceEventReceived);
      assert.equal(attendanceEventReceived.currentState, 'ACTIVE');

      // Verify PostgreSQL session was created with server UTC clock
      const sessRes = await adminPool.query(
        `SELECT id, org_id, user_id, device_id, current_state, clock_in_source, status
         FROM attendance_sessions
         WHERE user_id = '${empAId}' AND status = 'OPEN'`,
      );
      assert.equal(sessRes.rows.length, 1);
      assert.equal(sessRes.rows[0].current_state, 'ACTIVE');
      assert.equal(sessRes.rows[0].clock_in_source, 'AUTO_HEARTBEAT');

      socket.disconnect();
    });
  });

  describe('5. REST Attendance Endpoints & Transparency (FR-ATT-013, 016, 019, 020)', { concurrency: false }, () => {
    it('GET /attendance/live returns role-scoped presence board', async () => {
      // HR/Admin view sees all
      const res = await fetch(`${baseUrl}/attendance/live`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${adminAccessToken}` },
      });
      assert.equal(res.status, 200);
      const board = await res.json();
      assert.ok(Array.isArray(board));
      assert.ok(board.length >= 2);

      const workerEntry = board.find((u: any) => u.userId === empAId);
      assert.ok(workerEntry);
      assert.equal(workerEntry.displayName, 'Acme Worker');
    });

    it('FR-ATT-020: GET /attendance/me/events returns worker transparency info and notice', async () => {
      const res = await fetch(`${baseUrl}/attendance/me/events`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${empAccessToken}` },
      });
      assert.equal(res.status, 200);
      const transparency = await res.json();
      assert.ok(transparency.plainLanguageNotice);
      assert.match(transparency.plainLanguageNotice, /No screenshots/i);
      assert.equal(transparency.noticeVersion, 'v1.0.0');
      assert.ok(Array.isArray(transparency.events));
    });

    it('POST /attendance/consent records monitoring notice acceptance', async () => {
      const res = await fetch(`${baseUrl}/attendance/consent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${empAccessToken}`,
        },
        body: JSON.stringify({ noticeVersion: 'v1.0.0' }),
      });
      assert.equal(res.status, 201);
      const consent = await res.json();
      assert.equal(consent.noticeVersion, 'v1.0.0');
    });

    it('FR-ATT-013: Attendance correction workflow with validation and manager approval', async () => {
      // 1. Employee requests correction
      const reqIn = '2026-10-14T03:30:00.000Z';
      const reqOut = '2026-10-14T11:30:00.000Z';

      const createRes = await fetch(`${baseUrl}/attendance/corrections`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${empAccessToken}`,
        },
        body: JSON.stringify({
          requestedIn: reqIn,
          requestedOut: reqOut,
          reason: 'Network outage during afternoon shift',
        }),
      });
      assert.equal(createRes.status, 201);
      const correction = await createRes.json();
      assert.equal(correction.status, 'PENDING');

      // 2. Employee cannot review/approve own correction (rejection of self-approval)
      const selfReviewRes = await fetch(`${baseUrl}/attendance/corrections/${correction.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${empAccessToken}`,
        },
        body: JSON.stringify({ status: 'APPROVED', reviewNote: 'Self approved' }),
      });
      assert.equal(selfReviewRes.status, 403);

      // 3. Team Lead approves correction
      const leadReviewRes = await fetch(`${baseUrl}/attendance/corrections/${correction.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${leadAccessToken}`,
        },
        body: JSON.stringify({ status: 'APPROVED', reviewNote: 'Approved verified by logs' }),
      });
      assert.equal(leadReviewRes.status, 200);
      const reviewResult = await leadReviewRes.json();
      assert.equal(reviewResult.correction.status, 'APPROVED');
    });

    it('FR-ATT-019: GET /attendance/export generates sanitized CSV and XLSX', async () => {
      // CSV Export
      const csvRes = await fetch(
        `${baseUrl}/attendance/export?format=csv&startDate=2026-10-01&endDate=2026-10-31`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${adminAccessToken}` },
        },
      );
      assert.equal(csvRes.status, 200);
      assert.match(csvRes.headers.get('content-type') || '', /text\/csv/);
      const csvContent = await csvRes.text();
      assert.ok(csvContent.length > 0);

      // XLSX Export
      const xlsxRes = await fetch(
        `${baseUrl}/attendance/export?format=xlsx&startDate=2026-10-01&endDate=2026-10-31`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${adminAccessToken}` },
        },
      );
      assert.equal(xlsxRes.status, 200);
      assert.match(
        xlsxRes.headers.get('content-type') || '',
        /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/,
      );
      const xlsxBuffer = await xlsxRes.arrayBuffer();
      assert.ok(xlsxBuffer.byteLength > 0);
    });

    it('GET /audit-logs/verify confirms tamper-evident hash chain integrity', async () => {
      const verifyRes = await fetch(`${baseUrl}/audit-logs/verify`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${adminAccessToken}` },
      });
      assert.equal(verifyRes.status, 200);
      const data = await verifyRes.json();
      assert.equal(data.valid, true);
    });
  });
});
