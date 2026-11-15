'use client';

import { useEffect, useRef, useState } from 'react';
import { Bell, BellRing, Navigation } from 'lucide-react';
import { CallPerson } from '@/components/call-person';
import { Button } from '@/components/ui/button';
import type { OfficeClient } from '@/lib/office/office-client';
import type { OfficeRenderer } from '@/lib/office/office-renderer';

/** `block`: why this person cannot be nudged right now (null: they can). ADR 058. */
interface Spot { id: string; x: number; y: number; block: ReturnType<OfficeClient['nudgeBlock']> }
const NUDGE_BLOCK_TEXT = { far: 'walk closer', dnd: 'do not disturb', away: 'not looking at the office', pending: 'waiting for an answer' } as const;
const SIZE = 30;

/**
 * FR-VO-008 / FR-MEET-001: the canvas is invisible to keyboards and screen readers, so every other
 * person's avatar gets a focusable button laid over it ("Avatar actions for …"). Click, right-click,
 * Shift+F10 or the Menu key opens a menu: Call, Go to, Nudge. Arrow keys move, Escape closes and returns focus.
 *
 * ADR 058 (FR-VO-016): a colleague near enough to nudge also gets a small bell at the corner of
 * their avatar. It shows when the pointer is over the avatar or the keyboard focus is on it, and
 * all the time on a touch screen (where nothing hovers). The server decides whether the nudge is
 * allowed; the bell is only offered when it looks possible.
 */
export function AvatarActions({ client, renderer }: { client: OfficeClient; renderer: () => OfficeRenderer | null }) {
  const [spots, setSpots] = useState<Spot[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const menu = useRef<HTMLDivElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);

  // Positions follow the avatars a few times a second; buttons are keyed by person, so focus stays put.
  useEffect(() => {
    const t = setInterval(() => {
      const r = renderer();
      if (!r) return;
      r.onAvatarMenu = (id) => setOpen(id);
      const w = box.current?.clientWidth ?? 0;
      const h = box.current?.clientHeight ?? 0;
      setSpots(r.avatarsOnScreen().filter((s) => s.x >= 0 && s.y >= 0 && s.x <= w && s.y <= h).map((s) => ({ id: s.id, x: Math.round(s.x), y: Math.round(s.y), block: client.nudgeBlock(s.id) })));
    }, 150);
    return () => clearInterval(t);
  }, [renderer, client]);

  useEffect(() => {
    if (!open) return undefined;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (e: PointerEvent) => { if (!menu.current?.contains(e.target as Node)) setOpen(null); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  const close = (refocus: boolean) => {
    const id = open;
    setOpen(null);
    if (refocus && id) triggers.current.get(id)?.focus();
  };
  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') { e.preventDefault(); close(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus(); }
    else if (e.key === 'Tab') close(false);
  };

  const spot = open ? spots.find((s) => s.id === open) : undefined;
  const name = (id: string) => client.roster.get(id)?.name ?? 'Someone';
  return (
    <div ref={box} className="pointer-events-none absolute inset-0" data-testid="avatar-actions">
      {spots.map((s) => (
        <div key={s.id} className="group pointer-events-none absolute" style={{ left: s.x - SIZE / 2, top: s.y - SIZE / 2, width: SIZE, height: SIZE }}>
          <button
            ref={(el) => { if (el) triggers.current.set(s.id, el); else triggers.current.delete(s.id); }}
            type="button"
            aria-label={`Avatar actions for ${name(s.id)}`}
            aria-haspopup="menu"
            aria-expanded={open === s.id}
            className="pointer-events-auto absolute inset-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-primary"
            onClick={() => setOpen(s.id)}
            onContextMenu={(e) => { e.preventDefault(); setOpen(s.id); }}
            onKeyDown={(e) => { if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') { e.preventDefault(); setOpen(s.id); } }}
          />
          {s.block === null ? (
            <button
              type="button"
              data-testid="nudge-bell"
              data-user={s.id}
              aria-label={`Nudge ${name(s.id)}`}
              title={`Nudge ${name(s.id)}`}
              className="pointer-events-none absolute -right-4 -top-4 flex h-6 w-6 items-center justify-center rounded-full border border-primary bg-background text-primary opacity-0 shadow outline-none transition-opacity hover:bg-primary hover:text-primary-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-primary group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 motion-reduce:transition-none [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:-right-6 [@media(hover:none)]:-top-6 [@media(hover:none)]:h-8 [@media(hover:none)]:w-8 [@media(hover:none)]:opacity-100"
              onClick={() => { void client.sendNudge(s.id); }}
            >
              <Bell aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {client.nudgeOut?.to === s.id || client.nudgesIn.some((n) => n.from === s.id) ? (
            <span
              aria-hidden="true"
              data-testid="nudge-marker"
              data-state={client.nudgeOut?.to === s.id ? 'sent' : 'received'}
              className="absolute -top-9 left-1/2 flex h-6 w-6 -translate-x-1/2 items-center justify-center rounded-full bg-primary text-primary-foreground shadow"
            >
              <BellRing className={client.nudgeOut?.to === s.id ? 'h-3.5 w-3.5' : 'h-3.5 w-3.5 motion-safe:animate-bounce'} />
            </span>
          ) : null}
        </div>
      ))}
      {open ? (
        <div
          ref={menu}
          role="menu"
          aria-label={`Actions for ${name(open)}`}
          tabIndex={-1}
          onKeyDown={onMenuKey}
          className="pointer-events-auto absolute z-10 flex min-w-40 flex-col gap-1 rounded-md border bg-background p-1 shadow-lg"
          style={{ left: (spot?.x ?? 40) + SIZE / 2, top: (spot?.y ?? 40) - SIZE / 2 }}
        >
          <CallPerson userId={open} name={name(open)} menu />
          <Button size="sm" variant="ghost" role="menuitem" className="justify-start" onClick={() => { const id = open; close(false); void client.teleport({ kind: 'user', userId: id }); }}>
            <Navigation aria-hidden="true" /> Go to {name(open)}
          </Button>
          {(() => {
            const block = client.nudgeBlock(open);
            return (
              <Button
                size="sm"
                variant="ghost"
                role="menuitem"
                data-testid="nudge-menu-item"
                aria-disabled={block !== null}
                className={block === null ? 'justify-start' : 'justify-start text-muted-foreground'}
                onClick={() => { if (block !== null) return; const id = open; close(true); void client.sendNudge(id); }}
              >
                <Bell aria-hidden="true" /> Nudge {name(open)}{block ? ` (${NUDGE_BLOCK_TEXT[block]})` : ''}
              </Button>
            );
          })()}
        </div>
      ) : null}
    </div>
  );
}
