/**
 * Teams and the manager hierarchy (SRS 5.2 FR-ORG-006; ADR 031). HR and admins place each person
 * in a team and under a manager. The manager is the approver for leave, timesheets and
 * corrections; the team scopes what a team lead sees. Cycles are impossible: a person cannot be
 * placed under someone who already reports to them, directly or through others.
 */
import { z } from 'zod';

const Person = z.object({ id: z.string(), displayName: z.string().nullable(), email: z.string() });

export const OrgTeamSchema = z.object({
  id: z.string(),
  name: z.string(),
  lead: Person.nullable(),
  memberCount: z.number().int(),
});
export type OrgTeam = z.infer<typeof OrgTeamSchema>;

export const OrgPersonSchema = z.object({
  id: z.string(),
  displayName: z.string().nullable(),
  email: z.string(),
  role: z.string(),
  status: z.string(),
  teamId: z.string().nullable(),
  managerId: z.string().nullable(),
});
export type OrgPerson = z.infer<typeof OrgPersonSchema>;

export const OrgStructureSchema = z.object({ teams: z.array(OrgTeamSchema), people: z.array(OrgPersonSchema) });
export type OrgStructure = z.infer<typeof OrgStructureSchema>;

const teamName = z.string().trim().min(1, 'Give the team a name').max(100);

export const TeamDtoSchema = z.object({ name: teamName, leadId: z.string().uuid().nullable().default(null) }).strict();
export type TeamDto = z.input<typeof TeamDtoSchema>;

export const TeamUpdateDtoSchema = z
  .object({ name: teamName.optional(), leadId: z.string().uuid().nullable().optional() })
  .strict()
  .refine((d) => d.name !== undefined || d.leadId !== undefined, { message: 'Nothing to change' });
export type TeamUpdateDto = z.input<typeof TeamUpdateDtoSchema>;

/** Both fields are set together; null removes the person from a team or leaves them without a manager. */
export const PlacementDtoSchema = z.object({ teamId: z.string().uuid().nullable(), managerId: z.string().uuid().nullable() }).strict();
export type PlacementDto = z.input<typeof PlacementDtoSchema>;
