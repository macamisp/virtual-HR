'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Permission, useCan } from '@/lib/permissions';
import { cn } from '@/lib/utils';

/** ADR 049 §8: one place for the work-time pages; links follow the caller's permissions. */
export function WorkTimeNav() {
  const path = usePathname();
  const team = useCan(Permission.TIMESHEETS_APPROVE_TEAM);
  const all = useCan(Permission.TIMESHEETS_APPROVE_ALL);
  const canApprove = team || all;
  const links: Array<[string, string, boolean]> = [
    ['/work-time', 'My work time', true],
    ['/work-time/onsite', 'Onsite work', true],
    ['/work-time/overtime', 'Overtime', true],
    ['/work-time/review', 'Review requests', canApprove],
    ['/work-time/reports', 'Work-time report', true],
  ];
  return (
    <nav aria-label="Work time" className="-mx-1 flex gap-1 overflow-x-auto pb-1">
      {links.filter(([, , show]) => show).map(([href, label]) => (
        <Link
          key={href}
          href={href}
          aria-current={path === href ? 'page' : undefined}
          className={cn('whitespace-nowrap rounded-md px-3 py-1.5 text-sm', path === href ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}

/** FR-WT-021: the same plain statement on every work-time view. */
export function ActivityNote() {
  return (
    <p className="text-xs text-muted-foreground" data-testid="activity-note">
      Time records show when and on what people worked. They do not measure the quality or value of anyone&apos;s work.
    </p>
  );
}
