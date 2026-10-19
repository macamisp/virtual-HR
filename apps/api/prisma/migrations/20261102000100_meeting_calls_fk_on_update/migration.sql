-- FR-VO-008 (ADR 035): 20261102000000_office_calls_chat created these foreign keys without
-- ON UPDATE CASCADE, the default of Prisma relations, so the CI drift check failed. Same keys, same
-- ON DELETE behaviour; only the ON UPDATE action changes. (Applied migrations are never edited.)

-- DropForeignKey
ALTER TABLE "channels" DROP CONSTRAINT "channels_meeting_id_fkey";

-- DropForeignKey
ALTER TABLE "meeting_calls" DROP CONSTRAINT "meeting_calls_callee_id_fkey";

-- DropForeignKey
ALTER TABLE "meeting_calls" DROP CONSTRAINT "meeting_calls_caller_id_fkey";

-- DropForeignKey
ALTER TABLE "meeting_calls" DROP CONSTRAINT "meeting_calls_meeting_id_fkey";

-- DropForeignKey
ALTER TABLE "meeting_calls" DROP CONSTRAINT "meeting_calls_org_id_fkey";

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_calls" ADD CONSTRAINT "meeting_calls_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_calls" ADD CONSTRAINT "meeting_calls_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_calls" ADD CONSTRAINT "meeting_calls_caller_id_fkey" FOREIGN KEY ("caller_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_calls" ADD CONSTRAINT "meeting_calls_callee_id_fkey" FOREIGN KEY ("callee_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

