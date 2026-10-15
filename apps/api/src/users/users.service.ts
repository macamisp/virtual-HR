import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.ts';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async getProfile(userId: string, orgId: string) {
    return await this.prisma.runWithTenantContext(orgId, async (client) => {
      const res = await client.query(
        `SELECT id, org_id, email, display_name, role, team_id, manager_id, mfa_enabled, status, created_at
         FROM users
         WHERE id = $1 AND org_id = $2`,
        [userId, orgId],
      );
      if (res.rows.length === 0) {
        throw new NotFoundException('User not found');
      }
      return res.rows[0];
    });
  }

  async findAll(orgId: string, teamId?: string) {
    return await this.prisma.runWithTenantContext(orgId, async (client) => {
      let query = `SELECT id, org_id, email, display_name, role, team_id, manager_id, status, created_at
                   FROM users
                   WHERE org_id = $1`;
      const params: any[] = [orgId];
      if (teamId) {
        query += ` AND team_id = $2`;
        params.push(teamId);
      }
      query += ` ORDER BY display_name ASC`;
      const res = await client.query(query, params);
      return res.rows;
    });
  }
}
