/**
 * Subcontractor profiles (FR-ORG-002; ADR 033).
 *
 * Field-level access: the person and subcontractors.read see identity, contact and emergency
 * contact; the tax ID and bank details are encrypted (profile-crypto.ts) and shown masked; their
 * clear values come only from reveal(), for the person or subcontractors.sensitive.read. Every
 * read (list, profile, reveal) is in the audit log, and audit entries name fields, never values.
 */
import { ForbiddenException, Inject, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import { PrismaService } from '../common/prisma.service.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import type { RequestContext } from '../common/decorators/request-context.decorator.ts';
import { KEY_PROVIDER } from '../documents/crypto.ts';
import type { KeyProvider } from '../documents/crypto.ts';
import { openField, sealField, unwrapProfileKey, wrapProfileKey } from './profile-crypto.ts';
import type { SensitiveField } from './profile-crypto.ts';
import { BankDetailsSchema, IDENTITY_FIELDS, Permission, userCan } from '../../../../packages/shared/src/index.ts';
import type { AuthenticatedUser, BankDetails, SubcontractorList, SubcontractorProfile, SubcontractorProfileDto, SubcontractorSensitive } from '../../../../packages/shared/src/index.ts';

interface Row {
  id: string; display_name: string | null; email: string; role: string;
  legal_name: string | null; company_name: string | null; country: string | null; contact_email: string | null; contact_phone: string | null;
  address: string | null; emergency_contact: SubcontractorProfile['emergencyContact']; tax_id_enc: Buffer | null; bank_details_enc: Buffer | null;
  dek_wrapped: Buffer | null; dek_key_id: string | null; updated_at: Date | null; has_details: boolean;
}
const SELECT = `SELECT u.id, u.display_name, u.email, u.role, d.legal_name, d.company_name, d.country, d.contact_email, d.contact_phone, d.address,
    d.emergency_contact, d.tax_id_enc, d.bank_details_enc, d.dek_wrapped, d.dek_key_id, d.updated_at, d.user_id IS NOT NULL AS has_details
  FROM users u LEFT JOIN subcontractor_details d ON d.user_id = u.id`;
const last4 = (v: string) => v.replace(/[\s-]/g, '').slice(-4);

@Injectable()
export class SubcontractorsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
  ) {}

  async list(user: AuthenticatedUser, ctx: RequestContext): Promise<SubcontractorList> {
    return this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const rows = (await db.query<Row>(`${SELECT} WHERE u.role = 'SUBCONTRACTOR' AND u.anonymised_at IS NULL ORDER BY lower(coalesce(u.display_name, u.email))`)).rows;
      await this.audit(db, user, ctx, 'SUBCONTRACTOR_LIST_READ', 'ORGANIZATION', user.orgId, { people: rows.length });
      return {
        items: rows.map((r) => ({
          user: { id: r.id, displayName: r.display_name, email: r.email }, legalName: r.legal_name ?? '', companyName: r.company_name ?? '', country: r.country,
          hasTaxId: !!r.tax_id_enc, hasBankDetails: !!r.bank_details_enc, updatedAt: r.updated_at?.toISOString() ?? null,
        })),
      };
    });
  }

  async profile(user: AuthenticatedUser, targetId: string, ctx: RequestContext): Promise<SubcontractorProfile> {
    const self = targetId === user.id;
    if (!self && !userCan(user, Permission.SUBCONTRACTORS_READ)) throw new ForbiddenException('You can only read your own profile');
    return this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const r = await this.target(db, targetId);
      const sensitive = await this.decrypt(user.orgId, r);
      const seesRates = self || userCan(user, Permission.RATES_MANAGE) || userCan(user, Permission.TIMESHEETS_READ_ALL);
      const rates = seesRates
        ? (await db.query<{ rate_type: string; rate: string; currency: string; overtime_multiplier: string; weekly_hours_cap: string | null }>(
          `SELECT rate_type, rate::text, currency, overtime_multiplier::text, weekly_hours_cap::text FROM subcontractor_profiles WHERE user_id = $1`, [targetId])).rows[0]
        : undefined;
      await this.audit(db, user, ctx, 'SUBCONTRACTOR_PROFILE_READ', 'USER', targetId, { self, sensitiveShown: 'masked' });
      const manage = userCan(user, Permission.SUBCONTRACTORS_MANAGE);
      return {
        user: { id: r.id, displayName: r.display_name, email: r.email },
        legalName: r.legal_name ?? '', companyName: r.company_name ?? '', country: r.country, contactEmail: r.contact_email, contactPhone: r.contact_phone,
        address: r.address ?? '', emergencyContact: r.emergency_contact,
        taxId: { set: sensitive.taxId !== null, last4: sensitive.taxId ? last4(sensitive.taxId) : null },
        bankDetails: { set: sensitive.bankDetails !== null, last4: sensitive.bankDetails ? last4(sensitive.bankDetails.accountNumber) : null, bankName: sensitive.bankDetails?.bankName ?? null },
        ...(seesRates ? { rates: rates ? { rateType: rates.rate_type, rate: rates.rate, currency: rates.currency, overtimeMultiplier: rates.overtime_multiplier, weeklyHoursCap: rates.weekly_hours_cap } : null } : {}),
        updatedAt: r.updated_at?.toISOString() ?? null,
        can: { reveal: self || userCan(user, Permission.SUBCONTRACTORS_SENSITIVE_READ), editIdentity: manage, editContact: self || manage, editSensitive: self || manage },
      };
    });
  }

  /** The clear tax ID and bank details: the person themselves, or subcontractors.sensitive.read. Audited. */
  async reveal(user: AuthenticatedUser, targetId: string, ctx: RequestContext): Promise<SubcontractorSensitive> {
    const self = targetId === user.id;
    if (!self && !userCan(user, Permission.SUBCONTRACTORS_SENSITIVE_READ)) throw new ForbiddenException('Revealing tax and bank details needs subcontractors.sensitive.read');
    return this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const r = await this.target(db, targetId);
      const sensitive = await this.decrypt(user.orgId, r);
      await this.audit(db, user, ctx, 'SUBCONTRACTOR_SENSITIVE_READ', 'USER', targetId, {
        self, fields: [...(sensitive.taxId !== null ? ['taxId'] : []), ...(sensitive.bankDetails !== null ? ['bankDetails'] : [])],
      });
      return sensitive;
    });
  }

  async update(user: AuthenticatedUser, targetId: string, dto: SubcontractorProfileDto, ctx: RequestContext): Promise<SubcontractorProfile> {
    const self = targetId === user.id;
    const manage = userCan(user, Permission.SUBCONTRACTORS_MANAGE);
    if (!self && !manage) throw new ForbiddenException('You can only edit your own profile');
    const changed = (Object.keys(dto) as Array<keyof SubcontractorProfileDto>).filter((k) => dto[k] !== undefined);
    if (!manage && changed.some((k) => (IDENTITY_FIELDS as readonly string[]).includes(k))) {
      throw new ForbiddenException('Your legal name, company and country are changed by HR');
    }
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await db.query(`SELECT pg_advisory_xact_lock(hashtext('subcontractor-profile:' || $1::text))`, [targetId]);
      const r = await this.target(db, targetId);
      if (!r.has_details) await db.query(`INSERT INTO subcontractor_details (user_id, org_id) VALUES ($1, $2)`, [targetId, user.orgId]);
      const sets: string[] = [];
      const params: unknown[] = [targetId];
      const set = (column: string, value: unknown) => { params.push(value); sets.push(`${column} = $${params.length}`); };
      if (dto.legalName !== undefined) set('legal_name', dto.legalName);
      if (dto.companyName !== undefined) set('company_name', dto.companyName);
      if (dto.country !== undefined) set('country', dto.country);
      if (dto.contactEmail !== undefined) set('contact_email', dto.contactEmail);
      if (dto.contactPhone !== undefined) set('contact_phone', dto.contactPhone);
      if (dto.address !== undefined) set('address', dto.address);
      if (dto.emergencyContact !== undefined) set('emergency_contact', dto.emergencyContact === null ? null : JSON.stringify(dto.emergencyContact));
      if (dto.taxId !== undefined || dto.bankDetails !== undefined) {
        const key = await this.dataKey(user.orgId, r, (wrapped, keyId) => { set('dek_wrapped', wrapped); set('dek_key_id', keyId); });
        if (dto.taxId !== undefined) set('tax_id_enc', dto.taxId === null ? null : sealField(key, dto.taxId, this.ctx(user.orgId, targetId, 'taxId')));
        if (dto.bankDetails !== undefined) set('bank_details_enc', dto.bankDetails === null ? null : sealField(key, JSON.stringify(dto.bankDetails), this.ctx(user.orgId, targetId, 'bankDetails')));
        key.fill(0);
      }
      set('updated_by', user.id);
      await db.query(`UPDATE subcontractor_details SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1`, params);
      // Field names only: values (some of them secret) never enter the audit log.
      await this.audit(db, user, ctx, 'SUBCONTRACTOR_PROFILE_UPDATED', 'USER', targetId, { self, changed });
    });
    return this.profile(user, targetId, ctx);
  }

  // ---------------------------------------------------------------- helpers

  /** A subcontractor of this organisation (RLS hides other tenants), else 404. */
  private async target(db: pg.PoolClient, id: string): Promise<Row> {
    const r = (await db.query<Row>(`${SELECT} WHERE u.id = $1 AND u.anonymised_at IS NULL`, [id])).rows[0];
    if (!r || r.role !== 'SUBCONTRACTOR') throw new NotFoundException('Subcontractor profile not found');
    return r;
  }

  private ctx(orgId: string, userId: string, field: SensitiveField) { return { orgId, userId, field }; }

  /** The profile's data key: unwrapped when it exists, else created and stored with the update. */
  private async dataKey(orgId: string, r: Row, store: (wrapped: Buffer, keyId: string) => void): Promise<Buffer> {
    if (r.dek_wrapped && r.dek_key_id) return unwrapProfileKey(this.keys, orgId, r.id, r.dek_wrapped, r.dek_key_id);
    const { dek, wrapped, keyId } = await wrapProfileKey(this.keys, orgId, r.id);
    store(wrapped, keyId);
    return dek;
  }

  private async decrypt(orgId: string, r: Row): Promise<SubcontractorSensitive> {
    if (!r.tax_id_enc && !r.bank_details_enc) return { taxId: null, bankDetails: null };
    try {
      const key = await unwrapProfileKey(this.keys, orgId, r.id, r.dek_wrapped!, r.dek_key_id!);
      try {
        const taxId = r.tax_id_enc ? openField(key, r.tax_id_enc, this.ctx(orgId, r.id, 'taxId')) : null;
        const bankDetails: BankDetails | null = r.bank_details_enc ? BankDetailsSchema.parse(JSON.parse(openField(key, r.bank_details_enc, this.ctx(orgId, r.id, 'bankDetails')))) : null;
        return { taxId, bankDetails };
      } finally { key.fill(0); }
    } catch {
      // Never include the error (it may carry key material context) or any value; the id is enough to investigate.
      console.error(`Subcontractor profile ${r.id}: encrypted fields could not be opened`);
      throw new InternalServerErrorException('The encrypted details of this profile could not be opened');
    }
  }

  private audit(db: pg.PoolClient, user: AuthenticatedUser, ctx: RequestContext, action: string, entityType: string, entityId: string, after: unknown): Promise<void> {
    return appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action, entityType, entityId, after, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined });
  }
}
