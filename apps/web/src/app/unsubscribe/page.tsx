'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useUnsubscribe } from '@/lib/notification-queries';

/**
 * FR-NOTIF-002: landing page of the unsubscribe link in an email. The token travels in the URL
 * fragment, so it never reaches server logs; one click confirms.
 */
export default function UnsubscribePage() {
  const [token, setToken] = useState<string | null>(null);
  const unsub = useUnsubscribe();
  useEffect(() => {
    const read = () => setToken(window.location.hash.slice(1) || '');
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);
  return (
    <main id="main" className="mx-auto max-w-md p-8">
      <Card data-testid="unsubscribe">
        <CardHeader>
          <CardTitle>Email notifications</CardTitle>
          <CardDescription>Stop receiving emails about this kind of event. Notifications still appear in HR Virtual Office, and you can turn emails back on in your notification settings.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {token === '' ? <Alert variant="destructive"><AlertDescription>This link is incomplete. Open it from the email again.</AlertDescription></Alert> : null}
          {unsub.isSuccess ? (
            <Alert role="status"><AlertTitle>Done</AlertTitle><AlertDescription>You will no longer get emails about “{unsub.data.label.toLowerCase()}”.</AlertDescription></Alert>
          ) : null}
          {unsub.isError ? <Alert variant="destructive"><AlertDescription>{unsub.error.message}</AlertDescription></Alert> : null}
          {token && !unsub.isSuccess ? <Button onClick={() => unsub.mutate(token)} disabled={unsub.isPending}>Stop these emails</Button> : null}
          <p className="text-sm text-muted-foreground"><Link href="/account/notifications" className="text-primary underline-offset-4 hover:underline">All notification settings</Link> (sign-in required)</p>
        </CardContent>
      </Card>
    </main>
  );
}
