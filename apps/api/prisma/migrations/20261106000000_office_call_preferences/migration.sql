-- ADR 048: "Mute my microphone when I leave the office page", per user.
ALTER TABLE "users" ADD COLUMN "vo_mute_on_leave" BOOLEAN NOT NULL DEFAULT false;
