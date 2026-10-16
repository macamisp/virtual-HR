/**
 * Chat (SRS 5.4 FR-MEET-012, 013; 7.4 channels, channel_members, messages). ADR 017.
 * Kinds: PUBLIC (any employee may see and join), PRIVATE (members only), GROUP (an ad-hoc group
 * chat), DM (exactly two people, one per pair).
 */
import { z } from 'zod';
import { MENTION_PATTERN } from '../tasks/types.ts';

const isoDate = z.string().datetime({ offset: true });
export const CHANNEL_KINDS = ['PUBLIC', 'PRIVATE', 'GROUP', 'DM'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];
export const MAX_MESSAGE_LENGTH = 4000;

/** @[Display Name](user:<uuid>) — the same mention syntax as task comments. */
export function mentionedIds(body: string): string[] {
  return [...new Set([...body.matchAll(new RegExp(MENTION_PATTERN.source, 'g'))].map((m) => m[2]!))];
}

export const ChannelCreateDtoSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('PUBLIC'), name: z.string().trim().min(2).max(60).regex(/^[\p{L}\p{N} _.-]+$/u, 'Letters, numbers, spaces, - _ .'), topic: z.string().trim().max(250).default('') }).strict(),
  z.object({ kind: z.literal('PRIVATE'), name: z.string().trim().min(2).max(60).regex(/^[\p{L}\p{N} _.-]+$/u, 'Letters, numbers, spaces, - _ .'), topic: z.string().trim().max(250).default(''), memberIds: z.array(z.string().uuid()).max(500).default([]) }).strict(),
  z.object({ kind: z.literal('GROUP'), memberIds: z.array(z.string().uuid()).min(2).max(49), name: z.string().trim().max(60).optional() }).strict(),
  z.object({ kind: z.literal('DM'), userId: z.string().uuid() }).strict(),
]);
export type ChannelCreateDto = z.input<typeof ChannelCreateDtoSchema>;

export const ChannelSchema = z.object({
  id: z.string(),
  kind: z.enum(CHANNEL_KINDS),
  /** For DMs: the other person's name. */
  name: z.string(),
  topic: z.string(),
  memberCount: z.number().int(),
  isMember: z.boolean(),
  unread: z.number().int(),
  archived: z.boolean(),
  lastMessageAt: isoDate.nullable(),
  /** DM partner, for presence and calls. */
  otherUserId: z.string().nullable(),
  canManage: z.boolean(),
});
export type Channel = z.infer<typeof ChannelSchema>;
export const ChannelListSchema = z.object({ items: z.array(ChannelSchema) });

export const AttachmentSchema = z.object({ documentId: z.string(), title: z.string(), sizeBytes: z.number().nullable(), mimeType: z.string().nullable() });

export const MessageSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  author: z.object({ id: z.string(), displayName: z.string().nullable(), email: z.string() }),
  body: z.string(),
  parentId: z.string().nullable(),
  replyCount: z.number().int(),
  mentions: z.array(z.string()),
  attachment: AttachmentSchema.nullable(),
  createdAt: isoDate,
  editedAt: isoDate.nullable(),
  deleted: z.boolean(),
});
export type ChatMessage = z.infer<typeof MessageSchema>;
export const MessageListSchema = z.object({ items: z.array(MessageSchema), hasMore: z.boolean() });

export const MessageQuerySchema = z.object({
  before: isoDate.optional(),
  /** Thread replies of one message. */
  parentId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type MessageQuery = z.infer<typeof MessageQuerySchema>;

export const MessageDtoSchema = z
  .object({
    body: z.string().trim().max(MAX_MESSAGE_LENGTH).default(''),
    parentId: z.string().uuid().nullable().default(null),
    /** FR-MEET-013: a document the author may manage, already scanned clean. */
    documentId: z.string().uuid().nullable().default(null),
  })
  .strict()
  .refine((m) => m.body.length > 0 || m.documentId, { message: 'A message needs text or a file' });
export type MessageDto = z.input<typeof MessageDtoSchema>;

export const MessageEditDtoSchema = z.object({ body: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH) }).strict();

export const ChatSearchQuerySchema = z.object({ q: z.string().trim().min(2).max(100), limit: z.coerce.number().int().min(1).max(50).default(20) });
export const ChatSearchSchema = z.object({ items: z.array(MessageSchema.extend({ channelName: z.string() })) });

export const MembersDtoSchema = z.object({ add: z.array(z.string().uuid()).max(500).default([]), remove: z.array(z.string().uuid()).max(500).default([]) }).strict();
export type MembersDto = z.input<typeof MembersDtoSchema>;

/** Socket push (server to client): a new or changed message in one of your channels. */
export interface ChatEvent {
  type: 'message' | 'edit' | 'delete';
  channelId: string;
  message: ChatMessage;
}
