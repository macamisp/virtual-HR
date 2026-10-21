-- FR-AUTH-004: newest TOTP time step (30 s counter) a person has used. A code for this step or an
-- earlier one is refused, so a code cannot be replayed inside the clock-drift window.
ALTER TABLE users ADD COLUMN mfa_last_used_step BIGINT;
