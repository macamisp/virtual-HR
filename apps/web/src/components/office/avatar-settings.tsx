'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { AVATAR_FRAME_MS, AVATAR_KEYS, AVATAR_PRESETS, AVATAR_SIZE, sheetCell } from '@hrvo/shared';
import type { AvatarFrame, AvatarKey, Facing } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { sharedAvatarSheet } from '@/lib/office/avatar-sheet';
import { useSetAvatar } from '@/lib/office-queries';
import { cn } from '@/lib/utils';

/** The order the large preview turns in while it walks. */
const TURN: Facing[] = ['down', 'right', 'up', 'left'];
const STEPS_PER_FACING = 8;

/**
 * One character drawn on a small canvas, scaled with nearest-neighbour sampling. `walk` animates
 * it in place (about 7 frames a second, turning every few steps) without any React state; reduced
 * motion shows the standing frame only.
 */
function AvatarPreview({ avatarKey, scale, walk = false }: { avatarKey: AvatarKey; scale: number; walk?: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return undefined;
    ctx.imageSmoothingEnabled = false;
    const sheet = sharedAvatarSheet();
    const draw = (facing: Facing, frame: AvatarFrame) => {
      const c = sheetCell(avatarKey, facing, frame);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(sheet, c.x, c.y, c.width, c.height, 0, 0, canvas.width, canvas.height);
    };
    draw('down', 0);
    const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!walk || reduced) return undefined;
    let tick = 0;
    const t = setInterval(() => {
      tick += 1;
      draw(TURN[Math.floor(tick / STEPS_PER_FACING) % TURN.length]!, tick % 2 ? 1 : 2);
    }, AVATAR_FRAME_MS);
    return () => clearInterval(t);
  }, [avatarKey, walk]);
  return <canvas ref={ref} width={AVATAR_SIZE * scale} height={AVATAR_SIZE * scale} aria-hidden="true" className="block [image-rendering:pixelated]" />;
}

/**
 * ADR 053, in the office "Me" panel: preview the six characters, pick one, save it. Choosing only
 * changes the preview here; the map keeps the saved character until the server accepts the new one.
 */
export function AvatarSettings({ saved }: { saved: AvatarKey }) {
  const save = useSetAvatar();
  const [choice, setChoice] = useState<AvatarKey>(saved);
  const id = useId();
  const dirty = choice !== saved;
  const chosen = AVATAR_PRESETS[choice];
  return (
    <form
      className="space-y-2"
      aria-labelledby={`${id}-t`}
      data-testid="avatar-settings"
      onSubmit={(e) => { e.preventDefault(); if (dirty) save.mutate({ avatarKey: choice }); }}
    >
      <h3 id={`${id}-t`} className="text-sm font-medium">Character</h3>
      <div className="flex items-center gap-3">
        <div className="shrink-0 rounded border bg-slate-50 p-1" data-testid="avatar-preview" data-avatar={choice}>
          <AvatarPreview avatarKey={choice} scale={3} walk />
        </div>
        <p className="min-w-0 text-xs text-muted-foreground" aria-live="polite">
          <span className="font-medium text-foreground">{chosen.label}</span>: {chosen.description}.{' '}
          {dirty ? 'Preview only, not saved yet.' : 'This is your character.'}
        </p>
      </div>
      <fieldset>
        <legend className="sr-only">Choose a character</legend>
        <div className="grid grid-cols-3 gap-1">
          {AVATAR_KEYS.map((k) => (
            <label
              key={k}
              data-testid={`avatar-option-${k}`}
              className={cn(
                'flex cursor-pointer flex-col items-center rounded border p-1 text-xs hover:bg-accent/50',
                'has-[:checked]:border-primary has-[:checked]:bg-accent/40 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary',
              )}
            >
              <input
                type="radio"
                name={`${id}-avatar`}
                value={k}
                checked={choice === k}
                onChange={() => { setChoice(k); save.reset(); }}
                className="sr-only"
                aria-describedby={`${id}-${k}-d`}
              />
              <AvatarPreview avatarKey={k} scale={2} />
              <span>{AVATAR_PRESETS[k].label}{k === saved ? <span className="text-muted-foreground"> (current)</span> : null}</span>
              <span id={`${id}-${k}-d`} className="sr-only">{AVATAR_PRESETS[k].description}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" type="submit" disabled={!dirty || save.isPending}>{save.isPending ? 'Saving…' : 'Save character'}</Button>
        {dirty && !save.isPending ? <Button size="sm" type="button" variant="ghost" onClick={() => { setChoice(saved); save.reset(); }}>Cancel</Button> : null}
        {save.isSuccess && !dirty ? <span role="status" className="text-xs text-muted-foreground">Character saved. Everyone in the office now sees {AVATAR_PRESETS[saved].label}.</span> : null}
        {save.isError ? <span role="alert" className="text-xs text-destructive">Could not save your character: {save.error.message}</span> : null}
      </div>
    </form>
  );
}
