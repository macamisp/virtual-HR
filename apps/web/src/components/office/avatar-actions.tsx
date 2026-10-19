'use client';

import { useEffect, useRef, useState } from 'react';
import { Navigation } from 'lucide-react';
import { CallPerson } from '@/components/call-person';
import { Button } from '@/components/ui/button';
import type { OfficeClient } from '@/lib/office/office-client';
import type { OfficeRenderer } from '@/lib/office/office-renderer';

interface Spot { id: string; x: number; y: number }
const SIZE = 30;

/**
 * FR-VO-008 / FR-MEET-001: the canvas is invisible to keyboards and screen readers, so every other
 * person's avatar gets a focusable button laid over it ("Avatar actions for …"). Click, right-click,
 * Shift+F10 or the Menu key opens a menu: Call, Go to. Arrow keys move, Escape closes and returns focus.
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
      setSpots(r.avatarsOnScreen().filter((s) => s.x >= 0 && s.y >= 0 && s.x <= w && s.y <= h).map((s) => ({ id: s.id, x: Math.round(s.x), y: Math.round(s.y) })));
    }, 150);
    return () => clearInterval(t);
  }, [renderer]);

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
        <button
          key={s.id}
          ref={(el) => { if (el) triggers.current.set(s.id, el); else triggers.current.delete(s.id); }}
          type="button"
          aria-label={`Avatar actions for ${name(s.id)}`}
          aria-haspopup="menu"
          aria-expanded={open === s.id}
          className="pointer-events-auto absolute rounded-full outline-none focus-visible:ring-2 focus-visible:ring-primary"
          style={{ left: s.x - SIZE / 2, top: s.y - SIZE / 2, width: SIZE, height: SIZE }}
          onClick={() => setOpen(s.id)}
          onContextMenu={(e) => { e.preventDefault(); setOpen(s.id); }}
          onKeyDown={(e) => { if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') { e.preventDefault(); setOpen(s.id); } }}
        />
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
        </div>
      ) : null}
    </div>
  );
}
