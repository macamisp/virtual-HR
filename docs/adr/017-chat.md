# ADR 017: Chat

**Status:** Accepted
**Date:** 16 October 2026
**Requirements:** SRS 5.4 FR-MEET-012, 013; 7.4 channels, channel_members, messages.

## 1. Decisions agreed with the product owner

| Topic | Decision |
| --- | --- |
| Channel kinds | **PUBLIC** (any employee sees and may join; `chat.channels.public`, not subcontractors), **PRIVATE** (members only, invited), **GROUP** (ad-hoc, 3–50 people), **DM** (exactly two, one per pair). |
| Who talks to whom | Anyone may DM anyone in the organisation; subcontractors see only what they are invited to. |
| Moderation | `chat.moderate` (admins, HR) and channel owners archive. Archived channels are read-only. Messages are never hard-deleted by the app (no DELETE grant): delete = soft delete, body cleared. |

## 2. Data and security

- `channels`, `channel_members` (role OWNER/MEMBER, `last_read_at`), `messages` (`parent_id` for threads, `document_id`, `mentions`, `edited_at`, `deleted_at`, a generated `search` tsvector with a GIN index). All with `org_id` and forced RLS.
- Trigger `fn_chat_same_org`: a reply must answer a top-level message of the same channel; an attached document must belong to the same organisation.
- **Visibility is one function** (`channelFor`): a channel you may not see answers 404, never 403, so ids cannot be probed.
- Mentions use the task-comment syntax `@[Name](user:<uuid>)`; outside PUBLIC channels only members can be mentioned. Mentioned people get a `CHAT_MENTION` notification (preferences and quiet hours apply, ADR 012). The message body is never logged and is rendered as plain text (no HTML).
- Live delivery: `chat:message` socket events to each member's user room (`{type, channelId, message}`); the page refetches that channel.
- Search: PostgreSQL full-text (`simple` configuration) over messages in channels the caller can see.

## 3. Files (FR-MEET-013)

Files are not uploaded into chat. A message references an existing **document** (ADR 009): the author must have MANAGE on it, its latest version must be **CLEAN** (virus-scanned), NORMAL confidentiality and not password-protected (vault files cannot be shared to chat). Posting grants every member **DOWNLOAD** on the document (`ON CONFLICT DO NOTHING`), people who join later get the same grants, and the share is written to the document access log (SHARE, via CHAT).

## 4. Tests

`chat-e2e.test.ts`: kinds and who may create them, subcontractor isolation, 404 for hidden channels, members-only mentions and notifications, threads (one level, same channel), edit by the author, delete by the author or a moderator, archive, search scope, attachments (not clean / vault refused; members granted). Playwright `18-chat.spec.ts`: public channel, live delivery with a mention, thread reply and count, search, DM, subcontractor does not see public channels.
