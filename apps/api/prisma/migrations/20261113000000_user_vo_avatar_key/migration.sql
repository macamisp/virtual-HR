-- FR-VO-002, ADR 053: the pixel-art office character each person chose. Additive; every existing
-- user gets the default character with no data change. Only the allowlisted presets are accepted
-- (keep this list equal to AVATAR_KEYS in packages/shared/src/office/avatars.ts; a test checks it).
-- users.avatar_key stays reserved for an uploaded photo (SRS data model).
ALTER TABLE "users" ADD COLUMN "vo_avatar_key" VARCHAR(32) NOT NULL DEFAULT 'sage';
ALTER TABLE "users" ADD CONSTRAINT "users_vo_avatar_key_check"
  CHECK ("vo_avatar_key" IN ('sage', 'river', 'ember', 'juniper', 'sol', 'indigo'));
