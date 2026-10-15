'use client';

import Link from 'next/link';
import { use, useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Download, RotateCcw, Trash2 } from 'lucide-react';
import { CATEGORY_LABEL, CONFIDENTIALITY_LEVELS, DOCUMENT_CATEGORIES } from '@hrvo/shared';
import type { Confidentiality, DocumentCategory, DocumentDetail } from '@hrvo/shared';
import { ErrorState, LoadingState } from '@/components/state-views';
import { ConfidentialityBadge, ScanBadge, sizeLabel } from '@/components/documents/badges';
import { UploadPanel } from '@/components/documents/upload-panel';
import { SharingCard } from '@/components/documents/sharing-card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { apiDownload, saveBlob } from '@/lib/api';
import { useAccessLog, useDeleteDocument, useDocument, useRestoreVersion, useUpdateDocument } from '@/lib/document-queries';
import { formatDateTime, formatWorkDate } from '@/lib/format';

async function download(docId: string, versionId?: string, setError?: (m: string) => void) {
  try {
    const f = await apiDownload(`/documents/${docId}/download${versionId ? `?versionId=${versionId}` : ''}`);
    saveBlob(f.blob, f.filename);
  } catch (err) {
    setError?.((err as Error).message);
  }
}

/** FR-DOC-019: PDFs and images only, fetched with the access token and shown from a blob URL. */
function Preview({ doc }: { doc: DocumentDetail }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = doc.versions.find((v) => v.isCurrent);
  useEffect(() => {
    if (!doc.abilities.canPreview || !current) return;
    let revoke: string | null = null;
    apiDownload(`/documents/${doc.id}/preview`)
      .then((f) => {
        revoke = URL.createObjectURL(f.blob);
        setUrl(revoke);
      })
      .catch((err: Error) => setError(err.message));
    return () => {
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [doc.id, doc.abilities.canPreview, current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!doc.abilities.canPreview) {
    return <p className="text-sm text-muted-foreground">{doc.previewable || doc.latestStatus !== 'CLEAN' ? 'No preview until the file has passed the virus scan.' : 'Preview is available for PDFs and images. Download the file to open it.'}</p>;
  }
  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  if (!url) return <LoadingState label="Loading preview" rows={3} />;
  return doc.mimeType === 'application/pdf'
    ? <iframe src={url} title={`Preview of ${doc.title}`} className="h-[32rem] w-full rounded border" data-testid="preview" />
    : // eslint-disable-next-line @next/next/no-img-element -- a private blob: URL; next/image cannot optimise it
      <img src={url} alt={`Preview of ${doc.title}`} className="max-h-[32rem] rounded border" data-testid="preview" />;
}

function DetailsCard({ doc }: { doc: DocumentDetail }) {
  const update = useUpdateDocument(doc.id);
  const [title, setTitle] = useState(doc.title);
  const [category, setCategory] = useState<DocumentCategory>(doc.category);
  const [conf, setConf] = useState<Confidentiality>(doc.confidentiality);
  const [tags, setTags] = useState(doc.tags.join(', '));
  const [expiresAt, setExpiresAt] = useState(doc.expiresAt ?? '');
  const [saved, setSaved] = useState(false);
  const ids = { t: useId(), c: useId(), cf: useId(), tg: useId(), e: useId() };
  if (!doc.abilities.canEdit) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">Details</CardTitle></CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p>Category: {CATEGORY_LABEL[doc.category]}</p>
          <p>Owner: {doc.owner.displayName ?? doc.owner.email}</p>
          {doc.linkedUser ? <p>Linked person: {doc.linkedUser.displayName ?? doc.linkedUser.email}</p> : null}
          {doc.linkedContract ? <p>Contract: {doc.linkedContract.title}</p> : null}
          {doc.expiresAt ? <p>Expires: {formatWorkDate(doc.expiresAt)}</p> : null}
          {doc.tags.length ? <p>Tags: {doc.tags.join(', ')}</p> : null}
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Details</CardTitle><CardDescription>Owner: {doc.owner.displayName ?? doc.owner.email}{doc.linkedUser ? ` · linked to ${doc.linkedUser.displayName ?? doc.linkedUser.email}` : ''}{doc.linkedContract ? ` · contract “${doc.linkedContract.title}”` : ''}</CardDescription></CardHeader>
      <CardContent>
        <form className="grid gap-3 sm:grid-cols-2" aria-label="Document details" onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          update.mutate(
            { version: doc.version, title: title.trim(), category, confidentiality: conf, tags: tags.split(',').map((t) => t.trim()).filter(Boolean), expiresAt: expiresAt || null },
            { onSuccess: () => setSaved(true) },
          );
        }}>
          <div className="space-y-1.5 sm:col-span-2"><Label htmlFor={ids.t}>Title</Label><Input id={ids.t} value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor={ids.c}>Category</Label>
            <NativeSelect id={ids.c} value={category} onChange={(e) => setCategory(e.target.value as DocumentCategory)}>{DOCUMENT_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</NativeSelect></div>
          <div className="space-y-1.5"><Label htmlFor={ids.cf}>Confidentiality</Label>
            <NativeSelect id={ids.cf} value={conf} onChange={(e) => setConf(e.target.value as Confidentiality)}>{CONFIDENTIALITY_LEVELS.map((c) => <option key={c} value={c}>{c.charAt(0) + c.slice(1).toLowerCase()}</option>)}</NativeSelect></div>
          <div className="space-y-1.5"><Label htmlFor={ids.tg}>Tags</Label><Input id={ids.tg} value={tags} onChange={(e) => setTags(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor={ids.e}>Expires on</Label><Input id={ids.e} type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} /></div>
          <div className="space-y-2 sm:col-span-2">
            {update.isError ? <Alert variant="destructive"><AlertDescription>{update.error.message}</AlertDescription></Alert> : null}
            {saved ? <p className="text-sm text-muted-foreground" role="status">Saved.</p> : null}
            <Button type="submit" disabled={update.isPending}>Save details</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function VersionsCard({ doc }: { doc: DocumentDetail }) {
  const restore = useRestoreVersion(doc.id);
  const [error, setError] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Versions</CardTitle><CardDescription>Every upload is kept. Restoring makes a new version from an old one.</CardDescription></CardHeader>
      <CardContent className="overflow-x-auto">
        <Table data-testid="versions">
          <TableHeader><TableRow><TableHead>#</TableHead><TableHead>File</TableHead><TableHead>Status</TableHead><TableHead>Uploaded</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
          <TableBody>
            {doc.versions.map((v) => (
              <TableRow key={v.id} data-testid={`version-${v.versionNo}`}>
                <TableCell>v{v.versionNo}{v.isCurrent ? <span className="ml-1 text-xs text-muted-foreground">(current)</span> : null}</TableCell>
                <TableCell>
                  <span className="block">{v.fileName}</span>
                  <span className="text-xs text-muted-foreground">{sizeLabel(v.sizeBytes)}{v.restoredFromVersionNo ? ` · restored from v${v.restoredFromVersionNo}` : ''}</span>
                </TableCell>
                <TableCell><ScanBadge status={v.scanStatus} />{v.scanDetail ? <span className="mt-1 block text-xs text-destructive">{v.scanDetail}</span> : null}</TableCell>
                <TableCell className="text-sm">{v.uploadedBy.displayName ?? v.uploadedBy.email}<span className="block text-xs text-muted-foreground">{formatDateTime(v.uploadedAt)}</span></TableCell>
                <TableCell className="whitespace-nowrap">
                  {v.scanStatus === 'CLEAN' && doc.abilities.canDownload ? (
                    <Button variant="ghost" size="sm" aria-label={`Download v${v.versionNo}`} onClick={() => void download(doc.id, v.id, setError)}><Download aria-hidden="true" /></Button>
                  ) : null}
                  {doc.abilities.canEdit && v.scanStatus === 'CLEAN' && !v.isCurrent ? (
                    <Button variant="ghost" size="sm" onClick={() => restore.mutate(v.id)} disabled={restore.isPending}><RotateCcw aria-hidden="true" /> Restore</Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {error || restore.isError ? <Alert variant="destructive" className="mt-2"><AlertDescription>{error ?? restore.error?.message}</AlertDescription></Alert> : null}
      </CardContent>
    </Card>
  );
}

function AccessLogCard({ docId }: { docId: string }) {
  const log = useAccessLog(docId, true);
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Access log</CardTitle><CardDescription>Every view, download, upload, sharing change and deletion. Entries cannot be changed.</CardDescription></CardHeader>
      <CardContent>
        {log.isPending ? <LoadingState label="Loading access log" rows={2} /> : null}
        <ol className="space-y-1 text-sm" data-testid="access-log">
          {(log.data?.items ?? []).map((e) => (
            <li key={e.id}><span className="font-medium">{e.action}</span> · {e.user ? (e.user.displayName ?? e.user.email) : 'virus scanner'} · <span className="text-muted-foreground">{formatDateTime(e.createdAt)}{e.ip ? ` · ${e.ip}` : ''}</span></li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

export default function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const doc = useDocument(id);
  const del = useDeleteDocument();
  const [showVersion, setShowVersion] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (doc.isPending) return <LoadingState label="Loading document" rows={6} />;
  if (doc.isError) return <ErrorState error={doc.error} onRetry={() => void doc.refetch()} />;
  const d = doc.data;
  const latest = d.versions[0];
  return (
    <div className="space-y-4">
      <Link href="/documents" className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"><ArrowLeft className="h-4 w-4" aria-hidden="true" /> Documents</Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold" data-testid="document-title">{d.title}</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm"><ScanBadge status={d.latestStatus} /><ConfidentialityBadge level={d.confidentiality} /><span className="text-muted-foreground">{CATEGORY_LABEL[d.category]}{d.folderName ? ` · ${d.folderName}` : ''}</span></div>
        </div>
        <div className="flex flex-wrap gap-2">
          {d.abilities.canDownload ? <Button onClick={() => void download(d.id, undefined, setError)}><Download aria-hidden="true" /> Download</Button> : null}
          {d.abilities.canEdit ? <Button variant="outline" onClick={() => setShowVersion((s) => !s)}>New version</Button> : null}
          {d.abilities.canManage ? (
            <Button variant="outline" onClick={() => { if (window.confirm(`Delete “${d.title}”? It disappears for everyone.`)) del.mutate(d.id, { onSuccess: () => router.push('/documents') }); }}>
              <Trash2 aria-hidden="true" /> Delete
            </Button>
          ) : null}
        </div>
      </div>
      {latest?.scanStatus === 'PENDING' ? <Alert data-testid="scanning"><AlertTitle>Checking for viruses</AlertTitle><AlertDescription>The file becomes available as soon as the scan finishes.</AlertDescription></Alert> : null}
      {latest?.scanStatus === 'INFECTED' ? <Alert variant="destructive" data-testid="quarantined"><AlertTitle>Quarantined</AlertTitle><AlertDescription>{latest.scanDetail}. The file cannot be opened.</AlertDescription></Alert> : null}
      {latest?.scanStatus === 'REJECTED' ? <Alert variant="destructive" data-testid="refused"><AlertTitle>Upload refused</AlertTitle><AlertDescription>{latest.scanDetail}</AlertDescription></Alert> : null}
      {error || del.isError ? <Alert variant="destructive"><AlertDescription>{error ?? del.error?.message}</AlertDescription></Alert> : null}
      {showVersion ? <UploadPanel documentId={d.id} onDone={() => { setShowVersion(false); void doc.refetch(); }} /> : null}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card><CardHeader><CardTitle className="text-base">Preview</CardTitle></CardHeader><CardContent><Preview doc={d} /></CardContent></Card>
          <VersionsCard doc={d} />
        </div>
        <div className="space-y-4">
          <DetailsCard doc={d} />
          {d.abilities.canManage ? <SharingCard target={{ documentId: d.id }} title="Sharing" /> : null}
          {d.abilities.canManage ? <AccessLogCard docId={d.id} /> : null}
        </div>
      </div>
    </div>
  );
}
