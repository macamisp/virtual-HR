# ADR 053: Pixel-art office avatars, chosen per user

Date: 2026-11-13. Status: proposed (built and tested locally on `feature/office-pixel-avatar-system`; not deployed, migration not applied to any hosted database).
Related: FR-VO-002, FR-VO-003; ADR 015 (office, PixiJS renderer), ADR 048 (away from the office view).

## Context

FR-VO-002 says each user has an avatar ("name, photo or character, status ring"). The office drew
every person as a coloured disc with their initials. We want animated pixel-art characters that
people choose, seen by everyone in the office, without changing the movement, collision, rooms,
presence, calls, authentication or tenant isolation. No new npm packages, no third-party art, no
image uploads.

## Decision

1. **Six original presets, drawn from code.** `packages/shared/src/office/avatar-art.ts` builds
   each 32 x 32 frame from pixel shapes (legs, torso and outfit, arms, head and face, hair,
   glasses) and adds a one-pixel outline round the silhouette. Each character has 4 facings (down,
   left, right, up; left mirrors right) and 3 frames (idle, step A, step B). The characters differ
   in hair silhouette (crop, bob, curls, ponytail, bun, spiky), clothing (collar, tie, stripe,
   hoodie, vest, zip jacket), colours and skin tones. The feet always end on the same row.
   No art was copied from any other project.
2. **The spritesheet is generated, never loaded.** `scripts/generate-avatar-sheet.ts` writes
   `docs/assets/office-avatars/avatars.png` (384 x 192, transparent) for review and editing
   (`avatars@4x.png` is an enlarged copy). The renderer and the picker draw the same pixels
   straight from the shared function into a canvas. Nothing is fetched, so the CSP and the
   deployment are unchanged. A test fails if the committed PNG no longer matches the source.
3. **Rendering in the existing PixiJS renderer.** One sheet texture per renderer
   (`CanvasSource`, nearest-neighbour sampling, `roundPixels`) is cut into 72 frame textures shared
   by every avatar. Each avatar keeps its container. The status ring is now an ellipse on the
   ground round the feet: solid, or dashed and faded with the "away" badge (ADR 048). The own
   avatar keeps a dark inner marker. The name label, depth sorting by y, the avatar action
   overlay, right-click menus, camera and zoom are unchanged. The renderer stays lazy-loaded.
   On leaving, the sheet texture is released with the stage, and so is the bench timer.
4. **Animation is inferred from movement.** `stepAnimation()` (shared, pure) gets how far the avatar
   actually moved this frame:
   - Below 12 px/s, it stands: the idle frame at once. This covers a stop, a wall and sub-pixel easing.
   - Above 5x walking speed, it is a jump (a teleport or a server snap-back): idle, facing kept.
   - Otherwise it walks: step A at once, then A and B alternate about 7 times a second.

   The facing comes from the movement's eight-way direction (0–7). A diagonal keeps the last
   facing when that facing is part of the diagonal, and faces sideways otherwise. Remote avatars
   use the eased position the viewer sees, so no extra socket message is needed. Animation lives
   in the Pixi ticker, with no React state per frame. Movement speed, controls and the server's
   validation are untouched.
5. **Stored as `users.vo_avatar_key`.** This is an additive migration:
   - `VARCHAR(32) NOT NULL DEFAULT 'sage'`, so existing users get the default with no data change;
   - a `CHECK` constraint lists the six allowed keys.

   The SRS keeps `users.avatar_key` for a future uploaded photo, so this column follows the
   office's `vo_*` naming instead (decided with the product owner). Shared `AVATAR_KEYS`,
   `AvatarKeySchema` and the constraint must list the same keys, and a test checks that they do.
6. **API: `PUT /office/me/avatar` `{ avatarKey }`**, under the existing `office.use` guard.
   - The body is a strict Zod schema of allowlisted keys. Any other field is refused, including a
     user or organisation id, and so is any URL.
   - The user and the organisation come from the verified token only.
   - The update runs in the tenant context (RLS) and changes only that one column.
   - The office snapshot returns `me.avatarKey`.

   Not audited: it is a cosmetic preference, like the office status message.
7. **Synchronisation via the roster.** `RosterEntry.avatar` is sent:
   - in the join acknowledgement;
   - in `office:presence` when someone saves a new character (`OfficeWorld.setAvatar` marks the
     roster changed; the position version is not bumped).

   It is not in the 10 Hz position tuples. Rosters are per organisation (`vo-org:<orgId>`), so a
   character never reaches another tenant. An unknown key (an older or newer peer) is drawn as
   the default.
8. **Picker in the Me panel.** It shows a walking preview that turns, and six choices as native
   radio buttons (keyboard and screen-reader friendly; descriptions linked).
   - "Save character" shows Saving…, then a success status or an error alert. Cancel goes back
     to the saved character.
   - Choosing only changes the preview. The map changes when the server accepts the save and the
     roster update arrives.
   - With reduced motion, the preview stands still.

## Consequences

- Adding a character means three edits: a preset in `avatar-art.ts`, its key in `AVATAR_KEYS`, and a
  migration that widens the CHECK constraint. Then regenerate the PNG. Removing a key needs a data
  migration first.
- A photo avatar (the SRS's `avatar_key`) remains possible later without touching this column.
- The ground ring sits under the feet, so the old 24 px disc's footprint is replaced by a
  32 x 32 sprite. Hit testing and the accessible avatar buttons use the same avatar point as before.
- Tests:
  - `apps/api/test/office-avatars.test.ts`: presets, keys, art, sheet, direction, animation.
  - `apps/api/test/office-e2e.test.ts`: save, validation, roster sync, persistence, RLS, CHECK.
  - `apps/web/e2e/42-office-avatars.spec.ts`: rendering, walking, idle, facing and blocked
    movement on the real map; status ring and away state; the avatar menu; picker, save, sync,
    refresh and re-login; a failed save; repeated office entry; a phone viewport; 40 avatars.

## Rollout

The migration is additive and safe to apply before or after the code. Old clients ignore the new
roster field, and new clients default it. Applying it to a hosted database and deploying both need
explicit approval (not done here).
