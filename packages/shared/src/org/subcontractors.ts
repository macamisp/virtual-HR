/**
 * Subcontractor profile (SRS 5.2 FR-ORG-002; ADR 033). Identity, contact and emergency contact
 * are readable by the person and by subcontractors.read (HR, admins). The tax ID and bank
 * details are encrypted at the application layer; a profile read shows them masked, and the
 * clear values come only from the audited reveal, for the person themselves or holders of
 * subcontractors.sensitive.read (HR manager, admins). Rates are shown to whoever may see rates.
 */
import { z } from 'zod';

const Person = z.object({ id: z.string(), displayName: z.string().nullable(), email: z.string() });
const text = (max: number) => z.string().trim().max(max);

export const EmergencyContactSchema = z
  .object({ name: text(200).min(1, 'Give a name'), relationship: text(100).default(''), phone: text(40).min(3, 'Give a phone number') })
  .strict();
export type EmergencyContact = z.infer<typeof EmergencyContactSchema>;

export const BankDetailsSchema = z
  .object({
    accountName: text(200).min(1, 'Give the account holder'),
    bankName: text(200).min(1, 'Give the bank'),
    branch: text(200).default(''),
    accountNumber: z.string().trim().regex(/^[A-Za-z0-9 -]{4,40}$/, 'Use 4 to 40 letters, digits, spaces or hyphens'),
    swiftCode: z.string().trim().regex(/^([A-Za-z]{6}[A-Za-z0-9]{2}([A-Za-z0-9]{3})?)?$/, 'Use an 8 or 11 character SWIFT/BIC code').default(''),
  })
  .strict();
export type BankDetails = z.infer<typeof BankDetailsSchema>;

/** Masked view of an encrypted value: whether one is on file and its last four characters. */
export const MaskedSchema = z.object({ set: z.boolean(), last4: z.string().nullable() });
export type Masked = z.infer<typeof MaskedSchema>;

export const SubcontractorRatesSchema = z.object({
  rateType: z.string(), rate: z.string(), currency: z.string(), overtimeMultiplier: z.string(), weeklyHoursCap: z.string().nullable(),
});

export const SubcontractorProfileSchema = z.object({
  user: Person,
  legalName: z.string(),
  companyName: z.string(),
  country: z.string().nullable(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  address: z.string(),
  emergencyContact: EmergencyContactSchema.nullable(),
  taxId: MaskedSchema,
  bankDetails: MaskedSchema.extend({ bankName: z.string().nullable() }),
  /** Null when there is no rate profile; absent when the reader may not see rates. */
  rates: SubcontractorRatesSchema.nullable().optional(),
  updatedAt: z.string().nullable(),
  can: z.object({ reveal: z.boolean(), editIdentity: z.boolean(), editContact: z.boolean(), editSensitive: z.boolean() }),
});
export type SubcontractorProfile = z.infer<typeof SubcontractorProfileSchema>;

export const SubcontractorSensitiveSchema = z.object({ taxId: z.string().nullable(), bankDetails: BankDetailsSchema.nullable() });
export type SubcontractorSensitive = z.infer<typeof SubcontractorSensitiveSchema>;

export const SubcontractorListSchema = z.object({
  items: z.array(z.object({
    user: Person, legalName: z.string(), companyName: z.string(), country: z.string().nullable(),
    hasTaxId: z.boolean(), hasBankDetails: z.boolean(), updatedAt: z.string().nullable(),
  })),
});
export type SubcontractorList = z.infer<typeof SubcontractorListSchema>;

/**
 * Every field is optional; null clears it. The person edits their contact, emergency contact,
 * tax ID and bank details; subcontractors.manage edits everything. Rates stay on the rates screen.
 */
export const SubcontractorProfileDtoSchema = z
  .object({
    legalName: text(200).optional(),
    companyName: text(200).optional(),
    country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use a two-letter ISO 3166 country code').nullable().optional(),
    contactEmail: z.string().trim().email().max(255).nullable().optional(),
    contactPhone: z.string().trim().regex(/^[+0-9 ()-]{3,40}$/, 'Use digits, spaces, +, ( ) or -').nullable().optional(),
    address: text(500).optional(),
    emergencyContact: EmergencyContactSchema.nullable().optional(),
    taxId: z.string().trim().regex(/^[A-Za-z0-9 ./-]{3,40}$/, 'Use 3 to 40 letters, digits, spaces or . / -').nullable().optional(),
    bankDetails: BankDetailsSchema.nullable().optional(),
  })
  .strict()
  .refine((d) => Object.values(d).some((v) => v !== undefined), { message: 'Nothing to change' });
export type SubcontractorProfileDto = z.input<typeof SubcontractorProfileDtoSchema>;

export const IDENTITY_FIELDS = ['legalName', 'companyName', 'country'] as const;
export const SENSITIVE_FIELDS = ['taxId', 'bankDetails'] as const;
