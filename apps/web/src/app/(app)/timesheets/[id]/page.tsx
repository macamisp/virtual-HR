'use client';

import Link from 'next/link';
import { use } from 'react';
import { ArrowLeft } from 'lucide-react';
import { ErrorState, LoadingState } from '@/components/state-views';
import { TimesheetView } from '@/components/timesheets/timesheet-view';
import { useAuthStore } from '@/lib/auth-store';
import { useTimesheet } from '@/lib/timesheet-queries';

export default function TimesheetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const sheet = useTimesheet(id);
  const me = useAuthStore((s) => s.user?.id);
  const own = sheet.data?.user.id === me;
  return (
    <div className="space-y-4">
      <Link href={own ? '/timesheets' : '/timesheets/review'} className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> {own ? 'My timesheet' : 'Review timesheets'}
      </Link>
      {sheet.isPending ? <LoadingState label="Loading timesheet" rows={6} /> : null}
      {sheet.isError ? <ErrorState error={sheet.error} onRetry={() => void sheet.refetch()} /> : null}
      {sheet.data ? <TimesheetView sheet={sheet.data} heading={own ? 'My timesheet' : 'Timesheet'} /> : null}
    </div>
  );
}
