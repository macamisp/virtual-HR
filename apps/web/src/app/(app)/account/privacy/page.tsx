'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Download } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiDownload, saveBlob } from '@/lib/api';

/** FR-AUD-002: the right of access, self-service. */
export default function MyDataPage() {
  const [busy, setBusy] = useState<'zip' | 'json' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const download = async (format: 'zip' | 'json') => {
    setBusy(format);
    setError(null);
    try {
      const f = await apiDownload(`/me/export?format=${format}`);
      saveBlob(f.blob, f.filename);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed.');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">My data</h1>
      <Card data-testid="my-data">
        <CardHeader>
          <CardTitle className="text-base">Download everything we hold about you</CardTitle>
          <CardDescription>Your profile, consents, attendance (including raw presence events), timesheets, tasks and comments, document list and access history, notifications, sign-ins and your own audit trail. Document files are not included; open them from <Link href="/documents" className="text-primary underline-offset-4 hover:underline">Documents</Link>. Each download is recorded.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void download('zip')} disabled={busy !== null}><Download aria-hidden="true" /> {busy === 'zip' ? 'Preparing…' : 'Download ZIP'}</Button>
          <Button variant="outline" onClick={() => void download('json')} disabled={busy !== null}>{busy === 'json' ? 'Preparing…' : 'Download JSON'}</Button>
          {error ? <Alert variant="destructive" className="w-full"><AlertDescription>{error}</AlertDescription></Alert> : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Deletion</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          To have your personal data removed, ask HR. They run an anonymisation that replaces your identity with a pseudonym once open obligations (timesheets, contracts, legal holds) are settled. Audit entries, consent records and approved pay records are kept under the pseudonym, as the law requires.
        </CardContent>
      </Card>
    </div>
  );
}
