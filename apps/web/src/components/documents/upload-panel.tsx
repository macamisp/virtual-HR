'use client';

import { useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { UploadCloud } from 'lucide-react';
import { CATEGORY_LABEL, CONFIDENTIALITY_LEVELS, DOCUMENT_CATEGORIES, MAX_UPLOAD_BYTES } from '@hrvo/shared';
import type { DocumentCategory, DocumentDetail, Confidentiality } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { Permission, useCan } from '@/lib/permissions';
import { docKeys, useFolders, useShareTargets } from '@/lib/document-queries';
import { uploadDocument } from '@/lib/uploader';
import { cn } from '@/lib/utils';
import { sizeLabel } from './badges';

const ACCEPT = '.pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.gif,.webp,.zip,.txt';
const CONF_LABEL: Record<Confidentiality, string> = { NORMAL: 'Normal', CONFIDENTIAL: 'Confidential', RESTRICTED: 'Restricted' };

/**
 * FR-DOC-001 upload: drag and drop or pick, up to 100 MB, straight to storage in parts.
 * With `documentId` it uploads a new version (FR-DOC-004) and asks no metadata.
 */
export function UploadPanel({ documentId, defaultFolderId, needsPassword, onDone }: { documentId?: string; defaultFolderId?: string; needsPassword?: boolean; onDone: (d: DocumentDetail) => void }) {
  const qc = useQueryClient();
  const isHr = useCan(Permission.DOCUMENTS_READ_ALL);
  const folders = useFolders();
  const people = useShareTargets(isHr && !documentId);
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<DocumentCategory>('OTHER');
  const [confidentiality, setConfidentiality] = useState<Confidentiality>('NORMAL');
  const [folderId, setFolderId] = useState(defaultFolderId ?? '');
  const [linkedUserId, setLinkedUserId] = useState('');
  const [tags, setTags] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [docPassword, setDocPassword] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const ids = { file: useId(), title: useId(), cat: useId(), conf: useId(), folder: useId(), user: useId(), tags: useId(), exp: useId() };

  const choose = (f: File | undefined) => {
    if (!f) return;
    setError(null);
    if (f.size > MAX_UPLOAD_BYTES) return setError(`${f.name} is ${sizeLabel(f.size)}; the limit is 100 MB.`);
    if (f.size === 0) return setError('The file is empty.');
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ''));
  };

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return setError('Choose a file first.');
    if (!documentId && !title.trim()) return setError('Give the document a title.');
    setError(null);
    abort.current = new AbortController();
    setProgress(0);
    try {
      const target = documentId
        ? { documentId, documentPassword: needsPassword ? docPassword : undefined }
        : {
            metadata: {
              title: title.trim(), category, confidentiality,
              folderId: folderId || null,
              linkedUserId: linkedUserId || undefined,
              tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
              expiresAt: expiresAt || null,
            },
          };
      const d = await uploadDocument(file, target, (p) => setProgress(Math.round((p.loaded / p.total) * 100)), abort.current.signal);
      void qc.invalidateQueries({ queryKey: docKeys.all });
      setFile(null);
      setTitle('');
      onDone(d);
    } catch (err) {
      setError((err as Error).name === 'AbortError' ? 'Upload cancelled.' : (err as Error).message);
    } finally {
      setProgress(null);
    }
  };

  const busy = progress !== null;
  return (
    <Card data-testid="upload-panel">
      <CardHeader>
        <CardTitle className="text-base">{documentId ? 'Upload a new version' : 'Upload a document'}</CardTitle>
        <CardDescription>PDF, Word, Excel, PowerPoint, images, ZIP or text, up to 100 MB. Every file is checked for viruses before anyone can open it.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void start(e)} noValidate className="grid gap-3 sm:grid-cols-2" aria-label={documentId ? 'Upload a new version' : 'Upload a document'}>
          <div
            className={cn('flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-center sm:col-span-2', over && 'border-primary bg-primary/5')}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); choose(e.dataTransfer.files[0]); }}
            data-testid="drop-zone"
          >
            <UploadCloud className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm">{file ? <><span className="font-medium">{file.name}</span> · {sizeLabel(file.size)}</> : 'Drop a file here, or'}</p>
            <Label htmlFor={ids.file} className="sr-only">File</Label>
            <input ref={input} id={ids.file} type="file" accept={ACCEPT} className="sr-only" onChange={(e) => choose(e.target.files?.[0])} />
            <Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()} disabled={busy}>Choose a file</Button>
          </div>
          {documentId && needsPassword ? (
            <div className="space-y-1.5 sm:col-span-2"><Label htmlFor={`${ids.file}-pw`}>Document password</Label>
              <Input id={`${ids.file}-pw`} type="password" autoComplete="off" value={docPassword} onChange={(e) => setDocPassword(e.target.value)} /></div>
          ) : null}
          {!documentId ? (
            <>
              <div className="space-y-1.5 sm:col-span-2"><Label htmlFor={ids.title}>Title</Label><Input id={ids.title} value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} /></div>
              <div className="space-y-1.5"><Label htmlFor={ids.cat}>Category</Label>
                <NativeSelect id={ids.cat} value={category} onChange={(e) => setCategory(e.target.value as DocumentCategory)}>
                  {DOCUMENT_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
                </NativeSelect></div>
              <div className="space-y-1.5"><Label htmlFor={ids.conf}>Confidentiality</Label>
                <NativeSelect id={ids.conf} value={confidentiality} onChange={(e) => setConfidentiality(e.target.value as Confidentiality)}>
                  {CONFIDENTIALITY_LEVELS.map((c) => <option key={c} value={c}>{CONF_LABEL[c]}</option>)}
                </NativeSelect></div>
              <div className="space-y-1.5"><Label htmlFor={ids.folder}>Folder</Label>
                <NativeSelect id={ids.folder} value={folderId} onChange={(e) => setFolderId(e.target.value)}>
                  <option value="">No folder</option>
                  {(folders.data?.items ?? []).filter((f) => f.canEdit).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </NativeSelect></div>
              {isHr ? (
                <div className="space-y-1.5"><Label htmlFor={ids.user}>Linked person</Label>
                  <NativeSelect id={ids.user} value={linkedUserId} onChange={(e) => setLinkedUserId(e.target.value)}>
                    <option value="">Nobody</option>
                    {(people.data?.users ?? []).map((u) => <option key={u.id} value={u.id}>{u.displayName ?? u.email}</option>)}
                  </NativeSelect></div>
              ) : null}
              <div className="space-y-1.5"><Label htmlFor={ids.tags}>Tags (comma-separated)</Label><Input id={ids.tags} value={tags} onChange={(e) => setTags(e.target.value)} /></div>
              <div className="space-y-1.5"><Label htmlFor={ids.exp}>Expires on</Label><Input id={ids.exp} type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} /></div>
            </>
          ) : null}
          <div className="space-y-2 sm:col-span-2">
            {busy ? (
              <div className="space-y-1" role="status" aria-live="polite">
                <div className="h-2 w-full overflow-hidden rounded bg-muted"><div className="h-2 bg-primary transition-all" style={{ width: `${progress}%` }} /></div>
                <p className="text-xs text-muted-foreground" data-testid="upload-progress">Uploading… {progress}%</p>
              </div>
            ) : null}
            {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || !file}>Upload</Button>
              {busy ? <Button type="button" variant="outline" onClick={() => abort.current?.abort()}>Cancel</Button> : null}
            </div>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
