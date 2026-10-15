'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Permission, useCan } from '@/lib/permissions';
import { cn } from '@/lib/utils';

const VIEWS = [
  { href: '/tasks/today', label: 'Today' },
  { href: '/tasks/week', label: 'Week' },
  { href: '/tasks', label: 'My tasks' },
  { href: '/tasks/board', label: 'Board' },
  { href: '/tasks/calendar', label: 'Calendar' },
];
const TEAM_VIEWS = [{ href: '/tasks/workload', label: 'Team workload' }];

/** Secondary navigation between task views (FR-TASK-005). */
export function TaskViewsNav({ extra = [] }: { extra?: Array<{ href: string; label: string; permission?: (typeof Permission)[keyof typeof Permission] }> }) {
  const pathname = usePathname();
  const canTeam = useCan(Permission.TASKS_READ_TEAM);
  const views = [...VIEWS, ...(canTeam ? TEAM_VIEWS : []), ...extra.filter((v) => !v.permission || (v.permission === Permission.TASKS_READ_TEAM && canTeam))];
  return (
    <nav aria-label="Task views" className="flex flex-wrap gap-1 border-b pb-2">
      {views.map((v) => (
        <Link
          key={v.href}
          href={v.href}
          aria-current={pathname === v.href ? 'page' : undefined}
          className={cn(
            'rounded-md px-3 py-1.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            pathname === v.href ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent',
          )}
        >
          {v.label}
        </Link>
      ))}
    </nav>
  );
}
