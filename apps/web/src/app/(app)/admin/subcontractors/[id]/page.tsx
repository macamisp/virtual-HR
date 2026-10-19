'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { AccessDenied, ErrorState, LoadingState } from '@/components/state-views';
import { SubcontractorProfileView } from '@/components/subcontractors/profile-view';
import { Button } from '@/components/ui/button';
import { Permission, useCan } from '@/lib/permissions';
import { useSubcontractorProfile } from '@/lib/subcontractor-queries';

/** FR-ORG-002 (ADR 033): one subcontractor's profile for HR; tax and bank masked unless revealed. */
export default function SubcontractorProfilePage() {
  const { id } = useParams<{ id: string }>();
  const allowed = useCan(Permission.SUBCONTRACTORS_READ);
  const profile = useSubcontractorProfile(id, allowed);
  if (!allowed) return <AccessDenied what="Subcontractor profiles" />;
  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" asChild><Link href="/admin/subcontractors"><ArrowLeft aria-hidden="true" /> Subcontractors</Link></Button>
      <h1 className="text-2xl font-semibold">{profile.data ? (profile.data.user.displayName ?? profile.data.user.email) : 'Subcontractor'}</h1>
      {profile.isPending ? <LoadingState label="Loading the profile" /> : null}
      {profile.isError ? <ErrorState error={profile.error} onRetry={() => void profile.refetch()} /> : null}
      {profile.data ? <SubcontractorProfileView key={profile.data.user.id} target={id} profile={profile.data} /> : null}
    </div>
  );
}
