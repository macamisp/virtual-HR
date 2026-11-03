'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Building2, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/lib/auth-store';
import { callController } from '@/lib/media/call-controller';
import { RemoteAudio, useSession } from './call-view';
import { CallDock } from './call-dock';
import { CallContext, useCallController } from './use-call-controller';

/** Remote audio for the running call, once per tab, on every page. */
function CallAudio() {
  const c = useCallController();
  useSession(c.session);
  return <RemoteAudio session={c.session} />;
}

/**
 * Shown in the header while the user is in the office but not on the office page: their avatar is
 * still there (away from the office view) until they leave or sign out.
 */
export function OfficePresenceBadge() {
  const c = useCallController();
  const pathname = usePathname();
  if (!c.office || pathname === '/office') return null;
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="office-presence">
      <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
      <Link href="/office" className="underline">In the office</Link>
      <Button size="sm" variant="ghost" className="h-6 px-1 text-xs" aria-label="Leave the office" onClick={() => c.leaveOffice()}><LogOut aria-hidden="true" /> Leave</Button>
    </span>
  );
}

/**
 * ADR 046: mounted once by the app shell for the signed-in user. The call and the office presence
 * live here, so client-side navigation never touches them; a sign-out or a revoked session shuts
 * everything down and releases the devices.
 */
export function CallProvider({ children }: { children: React.ReactNode }) {
  const [controller] = useState(() => callController());
  const status = useAuthStore((s) => s.status);
  useEffect(() => { if (status === 'anonymous') void controller.shutdown(); }, [status, controller]);
  return (
    <CallContext.Provider value={controller}>
      {children}
      <CallAudio />
      <CallDock />
    </CallContext.Provider>
  );
}
