'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, BadgeDollarSign, Building2, BellRing, FileLock2, ShieldCheck, LayoutDashboard, PieChart, BarChart3, History, KeyRound, Settings2, UserCheck, CheckSquare, FileText, PenLine, ScrollText, ClipboardCheck, Clock, Eye, FolderKanban, CalendarCheck, Laptop, ListChecks, ShieldAlert, LogOut, Menu, MessagesSquare, Video, Timer, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TrackingBadge } from '@/components/tracking-badge';
import { NotificationBell } from '@/components/notification-bell';
import { LiveAlerts } from '@/components/live-alerts';
import { PresenceChallengeDialog } from '@/components/presence-challenge';
import { TimerBadge } from '@/components/timesheets/timer';
import { ConsentGate } from '@/components/consent-gate';
import { ErrorState, LoadingState } from '@/components/state-views';
import { useAuthStore } from '@/lib/auth-store';
import { logout, refreshSession, secondsUntilExpiry } from '@/lib/session';
import { Permission, useCan } from '@/lib/permissions';
import { useConsent } from '@/lib/queries';
import { useMyAccess } from '@/lib/admin-queries';
import { useHeartbeat } from '@/heartbeat/use-heartbeat';
import { cn } from '@/lib/utils';
import { ROLE_LABEL } from '@hrvo/shared';


/** Restores the session from the refresh cookie on load and refreshes ~60 s before expiry. */
function useSessionBootstrap() {
  const router = useRouter();
  const pathname = usePathname();
  const status = useAuthStore((s) => s.status);
  const accessToken = useAuthStore((s) => s.accessToken);

  useEffect(() => {
    if (status === 'unknown') {
      void refreshSession();
    } else if (status === 'anonymous') {
      router.replace(`/login?returnTo=${encodeURIComponent(pathname)}`);
    }
  }, [status, router, pathname]);

  useEffect(() => {
    if (!accessToken) return;
    const delayMs = Math.max(5_000, (secondsUntilExpiry(accessToken) - 60) * 1000);
    const t = setTimeout(() => void refreshSession(), delayMs);
    return () => clearTimeout(t);
  }, [accessToken]);
}

function NavLink({ href, icon: Icon, children }: { href: string; icon: typeof Clock; children: React.ReactNode }) {
  const pathname = usePathname();
  const active = pathname === href || ((href === '/tasks' || href === '/meetings') && pathname.startsWith(`${href}/`));
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      {children}
    </Link>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  useSessionBootstrap();
  const router = useRouter();
  const queryClient = useQueryClient();
  const status = useAuthStore((s) => s.status);
  const user = useAuthStore((s) => s.user);
  const consent = useConsent();
  const accepted = consent.data?.accepted === true;
  useHeartbeat(status === 'authenticated' && accepted);

  const canSeeBoard = useCan(Permission.ATTENDANCE_READ_TEAM);
  const canSeeAllAttendance = useCan(Permission.ATTENDANCE_READ_ALL);
  const canReview = useCan(Permission.ATTENDANCE_CORRECTIONS_REVIEW);
  const canTasks = useCan(Permission.TASKS_USE);
  const canTimesheets = useCan(Permission.TIMESHEETS_USE);
  const canDocuments = useCan(Permission.DOCUMENTS_USE);
  const canAudit = useCan(Permission.AUDIT_READ);
  const canReadAllTimesheets = useCan(Permission.TIMESHEETS_READ_ALL);
  const canApproveTeam = useCan(Permission.TIMESHEETS_APPROVE_TEAM);
  const canApproveAll = useCan(Permission.TIMESHEETS_APPROVE_ALL);
  const canManageRates = useCan(Permission.RATES_MANAGE);
  const access = useMyAccess();
  const canManageOrg = useCan(Permission.ORG_MANAGE);
  const canOffice = useCan(Permission.OFFICE_USE);
  const canMeetings = useCan(Permission.MEETINGS_USE);
  const canChat = useCan(Permission.CHAT_USE);
  const canAgent = useCan(Permission.AGENT_USE);
  const canReviewFlags = useCan(Permission.ATTENDANCE_CORRECTIONS_REVIEW) || canSeeAllAttendance;
  const canReportsTeam = useCan(Permission.REPORTS_TEAM);
  const canReportsAll = useCan(Permission.REPORTS_ALL);
  const canReports = canReportsTeam || canReportsAll;
  const canManageRoles = useCan(Permission.ROLES_MANAGE);
  const canPrivacy = useCan(Permission.PRIVACY_MANAGE);
  const canApproveTimesheets = canApproveTeam || canApproveAll;
  const canRates = canManageRates || canReadAllTimesheets;
  const [navOpen, setNavOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setNavOpen(false), [pathname]);

  if (status !== 'authenticated' || !user) {
    return (
      <main id="main" className="mx-auto max-w-md p-8">
        <LoadingState label="Restoring your session" rows={2} />
      </main>
    );
  }

  if (consent.isPending) {
    return (
      <main id="main" className="mx-auto max-w-md p-8">
        <LoadingState label="Checking monitoring notice" rows={2} />
      </main>
    );
  }
  if (consent.isError) {
    return (
      <main id="main" className="mx-auto max-w-md p-8">
        <ErrorState error={consent.error} onRetry={() => void consent.refetch()} />
      </main>
    );
  }
  if (!accepted) {
    return <ConsentGate noticeVersion={consent.data.noticeVersion} />;
  }

  const signOut = async () => {
    await logout();
    queryClient.clear();
    router.replace('/login');
  };

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:absolute focus:left-2 focus:top-2"
      >
        Skip to main content
      </a>
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          aria-label="Toggle navigation"
          aria-expanded={navOpen}
          aria-controls="sidebar"
          onClick={() => setNavOpen((o) => !o)}
        >
          <Menu />
        </Button>
        <span className="font-semibold">HR Virtual Office</span>
        <div className="ml-auto flex items-center gap-3">
          <TrackingBadge />
          <TimerBadge />
          <NotificationBell />
          <span className="hidden text-sm text-muted-foreground sm:inline" data-testid="current-user">
            {user.displayName ?? user.email} · {access.data?.customRoleName ?? ROLE_LABEL[user.role as keyof typeof ROLE_LABEL] ?? user.role}
          </span>
          <Button variant="outline" size="sm" onClick={() => void signOut()}>
            <LogOut aria-hidden="true" />
            Sign out
          </Button>
        </div>
      </header>
      <div className="flex flex-1">
        <nav
          id="sidebar"
          aria-label="Main"
          className={cn(
            'w-60 shrink-0 border-r bg-background p-3 md:block',
            navOpen ? 'absolute inset-y-14 left-0 z-20 block shadow-lg' : 'hidden',
          )}
        >
          <ul className="space-y-1">
            {canOffice ? (
              <li>
                <NavLink href="/office" icon={Building2}>Office</NavLink>
              </li>
            ) : null}
            {canMeetings ? (
              <li>
                <NavLink href="/meetings" icon={Video}>Meetings</NavLink>
              </li>
            ) : null}
            {canChat ? (
              <li>
                <NavLink href="/chat" icon={MessagesSquare}>Chat</NavLink>
              </li>
            ) : null}
            {canTasks ? (
              <li>
                <NavLink href="/tasks" icon={CheckSquare}>Tasks</NavLink>
              </li>
            ) : null}
            <li>
              <NavLink href="/attendance" icon={Clock}>My attendance</NavLink>
            </li>
            <li>
              <NavLink href="/attendance/transparency" icon={Eye}>What we collect</NavLink>
            </li>
            {canReports ? (
              <li>
                <NavLink href="/dashboard" icon={LayoutDashboard}>Dashboard</NavLink>
              </li>
            ) : null}
            {canReports ? (
              <li>
                <NavLink href="/reports" icon={PieChart}>Reports</NavLink>
              </li>
            ) : null}
            {canSeeBoard ? (
              <li>
                <NavLink href="/live" icon={Users}>Live board</NavLink>
              </li>
            ) : null}
            {canReview ? (
              <li>
                <NavLink href="/corrections" icon={ListChecks}>Corrections</NavLink>
              </li>
            ) : null}
            {canReviewFlags ? (
              <li>
                <NavLink href="/attendance/review" icon={ShieldAlert}>Attendance review</NavLink>
              </li>
            ) : null}
            {canTasks ? (
              <li>
                <NavLink href="/projects" icon={FolderKanban}>Projects</NavLink>
              </li>
            ) : null}
            {canDocuments ? (
              <li>
                <NavLink href="/documents" icon={FileText}>Documents</NavLink>
              </li>
            ) : null}
            {canDocuments ? (
              <li>
                <NavLink href="/signatures" icon={PenLine}>Signatures</NavLink>
              </li>
            ) : null}
            {canDocuments && canAudit ? (
              <li>
                <NavLink href="/documents/access-log" icon={ScrollText}>Document access log</NavLink>
              </li>
            ) : null}
            {canTimesheets ? (
              <li>
                <NavLink href="/timesheets" icon={Timer}>My timesheet</NavLink>
              </li>
            ) : null}
            {canApproveTimesheets || canReadAllTimesheets ? (
              <li>
                <NavLink href="/timesheets/review" icon={ClipboardCheck}>Review timesheets</NavLink>
              </li>
            ) : null}
            {canApproveTimesheets || canReadAllTimesheets ? (
              <li>
                <NavLink href="/timesheets/reports" icon={BarChart3}>Timesheet reports</NavLink>
              </li>
            ) : null}
            {canRates ? (
              <li>
                <NavLink href="/timesheets/rates" icon={BadgeDollarSign}>Rates</NavLink>
              </li>
            ) : null}
            <li>
              <NavLink href="/account/notifications" icon={BellRing}>Notification settings</NavLink>
            </li>
            {canMeetings ? (
              <li>
                <NavLink href="/account/calendar" icon={CalendarCheck}>Calendar sync</NavLink>
              </li>
            ) : null}
            <li>
              <NavLink href="/account/consents" icon={UserCheck}>My consents</NavLink>
            </li>
            <li>
              <NavLink href="/account/privacy" icon={FileLock2}>My data</NavLink>
            </li>
            {canAgent ? (
              <li>
                <NavLink href="/account/agents" icon={Laptop}>My desktop agents</NavLink>
              </li>
            ) : null}
            {canManageOrg || canManageRoles || canAudit || canPrivacy ? (
              <li className="px-2 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground" aria-hidden="true">Administration</li>
            ) : null}
            {canManageOrg ? (
              <li>
                <NavLink href="/admin/policy" icon={Settings2}>Policy settings</NavLink>
              </li>
            ) : null}
            {canManageOrg ? (
              <li>
                <NavLink href="/admin/retention" icon={Archive}>Data retention</NavLink>
              </li>
            ) : null}
            {canManageRoles ? (
              <li>
                <NavLink href="/admin/roles" icon={KeyRound}>Roles and permissions</NavLink>
              </li>
            ) : null}
            {canAudit ? (
              <li>
                <NavLink href="/admin/audit" icon={History}>Audit log</NavLink>
              </li>
            ) : null}
            {canPrivacy ? (
              <li>
                <NavLink href="/admin/privacy" icon={ShieldCheck}>Privacy requests</NavLink>
              </li>
            ) : null}
          </ul>
        </nav>
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 p-4 focus:outline-none sm:p-6">
          {children}
        </main>
        <LiveAlerts />
        <PresenceChallengeDialog />
      </div>
    </div>
  );
}
