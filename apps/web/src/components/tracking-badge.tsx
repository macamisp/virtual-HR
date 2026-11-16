'use client';

import { Loader2 } from 'lucide-react';
import { useToday } from '@/lib/queries';
import { formatClock } from '@/lib/format';
import { usePresenceStore } from '@/heartbeat/presence-store';
import { cn } from '@/lib/utils';

/**
 * Always-visible tracking status (SRS 8.2: "Tracking: Active since 09:02").
 * State and times come from the server (GET /attendance/me/today, refreshed on socket events);
 * the connection state comes from the heartbeat worker.
 */
export function TrackingBadge() {
  const today = useToday();
  const connection = usePresenceStore((s) => s.connection);
  const lastHeartbeatAt = usePresenceStore((s) => s.lastHeartbeatAt);
  const t = today.data;

  // `text` is the full wording (screen readers always get it; shown from the sm breakpoint).
  // On a phone the badge shows `word` (or `narrow` below 360 px) and, from 360 px, `time`, so it
  // stays on one line whatever else is in the header.
  let text: string;
  let word: string;
  let time: string | null = null;
  /** Below 360 px, a shorter word still (the spinner says it is reconnecting). */
  let narrow: string | null = null;
  let tone: 'active' | 'idle' | 'break' | 'off' | 'warn';
  const reconnecting = connection === 'reconnecting' || t?.state === 'DISCONNECTED';

  if (reconnecting) {
    text = 'Reconnecting… tracking paused';
    word = 'Reconnecting…';
    narrow = 'Paused';
    tone = 'warn';
  } else if (!t) {
    text = today.isError ? 'Tracking status unavailable' : 'Tracking: checking…';
    word = today.isError ? 'Unavailable' : 'Checking…';
    tone = today.isError ? 'warn' : 'off';
  } else {
    const since = formatClock(t.trackingSince);
    switch (t.state) {
      case 'ACTIVE':
        text = `Tracking: Active since ${since}`;
        word = 'Active';
        time = since;
        tone = 'active';
        break;
      case 'IN_MEETING':
        text = `Tracking: In meeting · since ${since}`;
        word = 'Meeting';
        time = since;
        tone = 'active';
        break;
      case 'IDLE':
      case 'PAUSED':
        text = `Tracking: Idle · since ${since}`;
        word = 'Idle';
        time = since;
        tone = 'idle';
        break;
      case 'ON_BREAK':
        text = `On break since ${formatClock(t.onBreakSince)}`;
        word = 'Break';
        time = formatClock(t.onBreakSince);
        tone = 'break';
        break;
      default:
        text = connection === 'connecting' ? 'Tracking: starting…' : 'Tracking: Not clocked in';
        word = connection === 'connecting' ? 'Starting…' : 'Not clocked in';
        tone = 'off';
    }
  }

  const title = lastHeartbeatAt
    ? `Last heartbeat ${new Date(lastHeartbeatAt).toLocaleTimeString([], { hour12: false })}`
    : 'No heartbeat sent yet from this tab';

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="tracking-badge"
      title={title}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-1 text-xs font-medium sm:gap-2 sm:px-3 sm:text-sm',
        tone === 'active' && 'border-success/50 text-success',
        tone === 'idle' && 'border-warning/50 text-warning',
        tone === 'break' && 'border-primary/50 text-primary',
        tone === 'warn' && 'border-warning bg-warning/10 text-warning',
        tone === 'off' && 'text-muted-foreground',
      )}
    >
      {reconnecting ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            'h-2 w-2 rounded-full',
            tone === 'active' && 'bg-success',
            tone === 'idle' && 'bg-warning',
            tone === 'break' && 'bg-primary',
            tone === 'off' && 'bg-muted-foreground',
          )}
        />
      )}
      <span aria-hidden="true" className="sm:hidden" data-testid="tracking-badge-short">
        {narrow ? (
          <>
            <span className="min-[360px]:hidden">{narrow}</span>
            <span className="hidden min-[360px]:inline">{word}</span>
          </>
        ) : word}
        {time ? <span className="hidden min-[360px]:inline"> · {time}</span> : null}
      </span>
      <span className="sr-only sm:not-sr-only">{text}</span>
    </div>
  );
}
