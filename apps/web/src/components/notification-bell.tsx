'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InlineSpinner } from '@/components/state-views';
import { useMarkNotifications, useNotifications } from '@/lib/notification-queries';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

/** In-app notification centre (FR-NOTIF-001): unread count, list, mark as read. */
export function NotificationBell() {
  const list = useNotifications();
  const mark = useMarkNotifications();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const unread = list.data?.unreadCount ?? 0;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!wrapper.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); button.current?.focus(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div className="relative" ref={wrapper}>
      <Button
        ref={button}
        variant="ghost"
        size="icon"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        aria-controls={panelId}
        data-testid="notification-bell"
        onClick={() => setOpen((o) => !o)}
        className="relative"
      >
        <Bell aria-hidden="true" />
        {unread > 0 ? (
          <span aria-hidden="true" data-testid="notification-count"
            className="absolute -right-0.5 -top-0.5 min-w-[1.1rem] rounded-full bg-destructive px-1 text-[10px] font-semibold leading-[1.1rem] text-destructive-foreground">
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </Button>
      {open ? (
        <div id={panelId} role="region" aria-label="Notifications" data-testid="notification-panel"
          className="absolute right-0 z-40 mt-2 w-80 rounded-lg border bg-card shadow-lg sm:w-96">
          <div className="flex items-center justify-between border-b p-3">
            <h2 className="text-sm font-semibold">Notifications</h2>
            <Button variant="ghost" size="sm" disabled={unread === 0 || mark.isPending} onClick={() => mark.mutate({ all: true })}>Mark all read</Button>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {list.isPending ? <div className="p-3"><InlineSpinner label="Loading notifications" /></div> : null}
            {list.isError ? <p className="p-3 text-sm text-destructive">Could not load notifications.</p> : null}
            {list.data && list.data.items.length === 0 ? <p className="p-3 text-sm text-muted-foreground">You&apos;re all caught up.</p> : null}
            <ul>
              {(list.data?.items ?? []).map((n) => {
                const body = (
                  <>
                    <span className={cn('block text-sm', !n.readAt && 'font-semibold')}>{n.title}</span>
                    {n.body ? <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{n.body}</span> : null}
                    <span className="mt-0.5 block text-xs text-muted-foreground">{formatDateTime(n.createdAt)}{n.readAt ? '' : ' · unread'}</span>
                  </>
                );
                const onOpen = () => { if (!n.readAt) mark.mutate({ id: n.id }); setOpen(false); };
                return (
                  <li key={n.id} className={cn('border-b last:border-0', !n.readAt && 'bg-primary/5')}>
                    {n.link ? (
                      <Link href={n.link} onClick={onOpen} className="block p-3 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">{body}</Link>
                    ) : (
                      <button type="button" onClick={onOpen} className="block w-full p-3 text-left hover:bg-accent">{body}</button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}
