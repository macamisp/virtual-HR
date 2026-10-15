'use client';

import { use, useEffect, useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Eye } from 'lucide-react';
import { PublicShareInfoSchema } from '@hrvo/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingState } from '@/components/state-views';
import { sizeLabel } from '@/components/documents/badges';
import { ApiError, apiDownload, apiFetch, saveBlob } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

/** FR-DOC-010: what someone outside the organisation sees when opening a share link. */
export default function SharedDocumentPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const info = useQuery({
    queryKey: ['share', token],
    queryFn: () => apiFetch(`/share/${encodeURIComponent(token)}`, { auth: 'none', schema: PublicShareInfoSchema }),
    retry: false,
  });
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const pwId = useId();
  useEffect(() => () => { if (viewUrl) URL.revokeObjectURL(viewUrl); }, [viewUrl]);

  const open = async (mode: 'download' | 'view') => {
    setBusy(true);
    setError(null);
    try {
      const f = await apiDownload(`/share/${encodeURIComponent(token)}/open`, { method: 'POST', body: { mode, password: password || undefined }, auth: 'none' });
      if (mode === 'download') saveBlob(f.blob, f.filename);
      else setViewUrl(URL.createObjectURL(f.blob));
      void info.refetch();
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'LINK_PASSWORD' ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main id="main" className="mx-auto max-w-3xl space-y-4 p-6">
      <p className="text-sm font-semibold">HR Virtual Office · shared document</p>
      {info.isPending ? <LoadingState label="Opening link" rows={2} /> : null}
      {info.isError ? (
        <Alert variant="destructive" data-testid="link-invalid"><AlertDescription>{info.error.message}</AlertDescription></Alert>
      ) : null}
      {info.data ? (
        <Card>
          <CardHeader>
            <CardTitle data-testid="shared-title">{info.data.title}</CardTitle>
            <CardDescription>
              {info.data.fileName} · {sizeLabel(info.data.sizeBytes)} · available until {formatDateTime(info.data.expiresAt)}
              {info.data.remaining !== null ? ` · ${info.data.remaining} opening${info.data.remaining === 1 ? '' : 's'} left` : ''}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {info.data.passwordRequired ? (
              <div className="space-y-1.5"><Label htmlFor={pwId}>Password</Label><Input id={pwId} type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void open('view')} disabled={busy || (info.data.passwordRequired && !password)}><Eye aria-hidden="true" /> View</Button>
              {!info.data.viewOnly ? <Button variant="outline" onClick={() => void open('download')} disabled={busy || (info.data.passwordRequired && !password)}><Download aria-hidden="true" /> Download</Button> : null}
            </div>
            {info.data.viewOnly ? <p className="text-xs text-muted-foreground">View only: the document is watermarked with the time and your IP address, and cannot be downloaded.</p> : null}
            {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
            {viewUrl ? <iframe src={viewUrl} title="Shared document" className="h-[36rem] w-full rounded border" data-testid="shared-view" /> : null}
          </CardContent>
        </Card>
      ) : null}
    </main>
  );
}
