'use client';

import { EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { SubcontractorProfileView } from '@/components/subcontractors/profile-view';
import { ApiError } from '@/lib/api';
import { useSubcontractorProfile } from '@/lib/subcontractor-queries';

/** FR-ORG-002 (ADR 033): a subcontractor keeps their own contact, emergency contact, tax and bank details. */
export default function MyContractorProfilePage() {
  const profile = useSubcontractorProfile('me');
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">My contractor profile</h1>
      {profile.isPending ? <LoadingState label="Loading your profile" /> : null}
      {profile.isError ? (profile.error instanceof ApiError && profile.error.status === 404
        ? <EmptyState title="No contractor profile" description="Contractor profiles are for subcontractors." />
        : <ErrorState error={profile.error} onRetry={() => void profile.refetch()} />) : null}
      {profile.data ? <SubcontractorProfileView key={profile.data.user.id} target="me" profile={profile.data} /> : null}
    </div>
  );
}
