'use client';
import { useRouter } from 'next/navigation';
import { Phone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCreateMeeting } from '@/lib/meeting-queries';
import { Permission, useCan } from '@/lib/permissions';

/** FR-VO-008 / FR-MEET-001: the same instant call from the people list and avatar menu. */
export function CallPerson({ userId, name, menu = false }: { userId: string; name: string; menu?: boolean }) {
  const create = useCreateMeeting();
  const router = useRouter();
  const allowed = useCan(Permission.MEETINGS_USE);
  if (!allowed) return null;
  return <span>
    <Button size="sm" variant="outline" role={menu ? 'menuitem' : undefined} aria-label={`Call ${name}`} disabled={create.isPending}
      // mutateAsync: navigate even if this button unmounts first (the avatar menu closes, the list refreshes).
      onClick={() => { create.mutateAsync({ type: 'INSTANT', title: `Call with ${name}`.slice(0, 200), attendeeIds: [userId], lobby: true, sendInvites: false }).then((m) => router.push(`/meetings/${m.id}?join=1`)).catch(() => undefined); }}>
      <Phone aria-hidden="true" />{create.isPending ? 'Calling…' : 'Call'}
    </Button>
    {create.isError ? <span role="alert" className="block text-xs text-destructive">{create.error.message}</span> : null}
  </span>;
}
