import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.ts';
import { PostgresAttendanceRepository } from '../attendance/attendance-repository.ts';

@Injectable()
export class AuditService {
  private repo: PostgresAttendanceRepository;

  constructor(private prisma: PrismaService) {
    this.repo = new PostgresAttendanceRepository();
  }

  async getAuditLogs(orgId: string, limit: number = 50, offset: number = 0) {
    return await this.prisma.runWithTenantContext(orgId, async (client) => {
      const res = await client.query(
        `SELECT id, org_id, actor_id, action, entity_type, entity_id, before, after, ip, user_agent, prev_hash, hash, created_at
         FROM audit_logs
         WHERE org_id = $1
         ORDER BY id DESC
         LIMIT $2 OFFSET $3`,
        [orgId, limit, offset],
      );
      return res.rows;
    });
  }

  async verifyChain(orgId: string): Promise<boolean> {
    return await this.repo.verifyAuditLogChain(orgId);
  }
}
