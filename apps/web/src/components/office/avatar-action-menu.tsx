'use client';

import { useEffect, useRef, useState } from 'react';
import { Armchair, ArrowUpFromLine, ChevronLeft, Hand, HandHeart, Music, PartyPopper, Smile, Square } from 'lucide-react';
import type { PairAction, Seat } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import type { OfficeClient } from '@/lib/office/office-client';
import { cn } from '@/lib/utils';

/** ADR 056: what the menu offers right now (worked out by the map a few times a second). */
export interface ActionContext {
  /** A free chair within reach, or null. */
  seat: Seat | null;
  seated: boolean;
  dancing: boolean;
  /** Colleagues close enough for a hug or a high five (same room, within reach). */
  nearby: Array<{ id: string; name: string }>;
}

const item = 'flex w-full items-center gap-2 rounded px-3 py-2.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent disabled:cursor-not-allowed disabled:opacity-50';

/**
 * The "Actions" button over the map and its menu: sit or stand, jump, wave, dance (and stop), and
 * a hug or a high five for someone nearby, which first asks them. Arrow keys move, Escape closes.
 */
export function AvatarActionMenu({ client, ctx }: { client: OfficeClient; ctx: ActionContext }) {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<PairAction | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    const away = (e: PointerEvent) => { if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) { setOpen(false); setPick(null); } };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open, pick]);

  const close = (refocus = true) => { setOpen(false); setPick(null); if (refocus) button.current?.focus(); };
  const run = (fn: () => void) => { fn(); close(false); };
  const onKey = (e: React.KeyboardEvent) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') { e.preventDefault(); if (pick) setPick(null); else close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus(); }
    else if (e.key === 'Tab') close(false);
  };

  return (
    <div className="pointer-events-none absolute bottom-10 right-2 flex flex-col items-end gap-2">
      {ctx.dancing ? (
        <Button size="sm" variant="secondary" className="pointer-events-auto shadow" data-testid="stop-dancing" onClick={() => void client.act('stop')}>
          <Square aria-hidden="true" /> Stop dancing
        </Button>
      ) : null}
      {open ? (
        <div
          ref={menu}
          role="menu"
          aria-label={pick ? `Who would you like to ${pick === 'hug' ? 'hug' : 'high-five'}?` : 'Avatar actions'}
          data-testid="action-menu"
          onKeyDown={onKey}
          className="pointer-events-auto w-60 rounded-md border bg-background p-1 shadow-lg"
        >
          {pick ? (
            <>
              <button type="button" role="menuitem" className={item} onClick={() => setPick(null)}><ChevronLeft aria-hidden="true" className="h-4 w-4" /> Back</button>
              {ctx.nearby.length ? ctx.nearby.map((p) => (
                <button key={p.id} type="button" role="menuitem" className={item} onClick={() => run(() => void client.askPair(pick, p.id))}>
                  {pick === 'hug' ? <HandHeart aria-hidden="true" className="h-4 w-4 text-[#c2363b]" /> : <Hand aria-hidden="true" className="h-4 w-4 text-[#d9a94e]" />} {p.name}
                </button>
              )) : <p className="px-3 py-2 text-sm text-muted-foreground">Nobody is close enough. Stand next to a colleague first.</p>}
            </>
          ) : (
            <>
              {ctx.seated ? (
                <button type="button" role="menuitem" className={item} onClick={() => run(() => void client.stand())}><ArrowUpFromLine aria-hidden="true" className="h-4 w-4" /> Stand up <kbd className="ml-auto text-xs text-muted-foreground">E</kbd></button>
              ) : (
                <button type="button" role="menuitem" className={item} disabled={!ctx.seat} onClick={() => ctx.seat && run(() => void client.sit(ctx.seat!.id))}>
                  <Armchair aria-hidden="true" className="h-4 w-4" /> {ctx.seat ? 'Sit down' : 'Sit down (walk up to a free chair)'} <kbd className="ml-auto text-xs text-muted-foreground">E</kbd>
                </button>
              )}
              <button type="button" role="menuitem" className={item} onClick={() => run(() => void client.act('jump'))}><PartyPopper aria-hidden="true" className="h-4 w-4" /> Jump <kbd className="ml-auto text-xs text-muted-foreground">Space</kbd></button>
              <button type="button" role="menuitem" className={item} onClick={() => run(() => void client.act('wave'))}><Smile aria-hidden="true" className="h-4 w-4" /> Wave</button>
              {ctx.dancing
                ? <button type="button" role="menuitem" className={item} onClick={() => run(() => void client.act('stop'))}><Square aria-hidden="true" className="h-4 w-4" /> Stop dancing</button>
                : <button type="button" role="menuitem" className={item} onClick={() => run(() => void client.act('dance'))}><Music aria-hidden="true" className="h-4 w-4" /> Dance</button>}
              <button type="button" role="menuitem" aria-haspopup="menu" className={item} disabled={!!client.outgoing} onClick={() => setPick('hug')}><HandHeart aria-hidden="true" className="h-4 w-4" /> Friendly hug…</button>
              <button type="button" role="menuitem" aria-haspopup="menu" className={item} disabled={!!client.outgoing} onClick={() => setPick('highfive')}><Hand aria-hidden="true" className="h-4 w-4" /> High five…</button>
            </>
          )}
        </div>
      ) : null}
      <Button
        ref={button}
        size="sm"
        variant="outline"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="actions-button"
        className={cn('pointer-events-auto bg-background shadow', open && 'ring-2 ring-primary')}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <PartyPopper aria-hidden="true" /> Actions
      </Button>
    </div>
  );
}
