-- ADR 025: when a login last sent a valid heartbeat; decides whether another login keeps a person clocked in.

-- AlterTable
ALTER TABLE "session_secrets" ADD COLUMN     "last_used_at" TIMESTAMPTZ;

