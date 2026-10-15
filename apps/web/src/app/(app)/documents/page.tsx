'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { FolderPlus, Plus } from 'lucide-react';
import { CATEGORY_LABEL, DOCUMENT_CATEGORIES } from '@hrvo/shared';
import type { Folder } from '@hrvo/shared';
import { EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { ConfidentialityBadge, ScanBadge, sizeLabel } from '@/components/documents/badges';
import { UploadPanel } from '@/components/documents/upload-panel';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useCreateFolder, useDocuments, useFolders } from '@/lib/document-queries';
import { formatDateTime, formatWorkDate } from '@/lib/format';
import { cn } from '@/lib/utils';

function FolderTree({ folders, parentId, selected, onSelect, depth = 0 }: { folders: Folder[]; parentId: string | null; selected: string; onSelect: (id: string) => void; depth?: number }) {
  const children = folders.filter((f) => f.parentId === parentId || (depth === 0 && f.parentId !== null && !folders.some((p) => p.id === f.parentId)));
  if (children.length === 0) return null;
  return (
    <ul className={cn(depth > 0 && 'ml-3 border-l pl-2')}>
      {children.map((f) => (
        <li key={f.id}>
          <button type="button" onClick={() => onSelect(f.id)} aria-current={selected === f.id ? 'true' : undefined}
            className={cn('w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-accent', selected === f.id && 'bg-accent font-medium')}>
            {f.name}
          </button>
          <FolderTree folders={folders.filter((x) => x.id !== f.id)} parentId={f.id} selected={selected} onSelect={onSelect} depth={depth + 1} />
        </li>
      ))}
    </ul>
  );
}

/** FR-DOC-002: folders and categories; FR-DOC-001 upload; list of documents you can see. */
export default function DocumentsPage() {
  const router = useRouter();
  const [folderId, setFolderId] = useState('');
  const [category, setCategory] = useState('');
  const [q, setQ] = useState('');
  const [showUpload, setShowUpload] = useState(false);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const folders = useFolders();
  const createFolder = useCreateFolder();
  const list = useDocuments({ folderId: folderId || undefined, category: category || undefined, q: q.trim() || undefined });
  const selectedFolder = folders.data?.items.find((f) => f.id === folderId);
  const canAddFolder = selectedFolder ? selectedFolder.canManage : folders.data?.canCreateTopLevel;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Documents</h1>
        <div className="flex gap-2">
          <Button variant="outline" asChild><Link href="/documents/contracts">Contracts</Link></Button>
          <Button onClick={() => setShowUpload((s) => !s)} aria-expanded={showUpload}><Plus aria-hidden="true" /> Upload</Button>
        </div>
      </div>

      {showUpload ? <UploadPanel defaultFolderId={folderId || undefined} onDone={(d) => router.push(`/documents/${d.id}`)} /> : null}

      <div className="grid gap-4 lg:grid-cols-[14rem_1fr]">
        <Card>
          <CardContent className="space-y-2 p-3">
            <nav aria-label="Folders">
              <button type="button" onClick={() => setFolderId('')} aria-current={folderId === '' ? 'true' : undefined}
                className={cn('w-full rounded px-2 py-1 text-left text-sm hover:bg-accent', folderId === '' && 'bg-accent font-medium')}>
                All my documents
              </button>
              {folders.isPending ? <LoadingState label="Loading folders" rows={2} /> : null}
              {folders.data ? <FolderTree folders={folders.data.items} parentId={null} selected={folderId} onSelect={setFolderId} /> : null}
            </nav>
            {canAddFolder ? (
              newFolder === null ? (
                <Button variant="ghost" size="sm" onClick={() => setNewFolder('')}><FolderPlus aria-hidden="true" /> {selectedFolder ? 'New sub-folder' : 'New folder'}</Button>
              ) : (
                <form className="space-y-2" onSubmit={(e) => {
                  e.preventDefault();
                  createFolder.mutate({ name: newFolder, parentId: folderId || null }, { onSuccess: () => setNewFolder(null) });
                }}>
                  <Label htmlFor="new-folder">Folder name</Label>
                  <Input id="new-folder" value={newFolder} maxLength={120} onChange={(e) => setNewFolder(e.target.value)} />
                  <div className="flex gap-2"><Button size="sm" type="submit" disabled={!newFolder.trim() || createFolder.isPending}>Create</Button><Button size="sm" variant="ghost" type="button" onClick={() => setNewFolder(null)}>Cancel</Button></div>
                  {createFolder.isError ? <Alert variant="destructive"><AlertDescription>{createFolder.error.message}</AlertDescription></Alert> : null}
                </form>
              )
            ) : null}
          </CardContent>
        </Card>

        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1"><Label htmlFor="doc-cat">Category</Label>
              <NativeSelect id="doc-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">All categories</option>
                {DOCUMENT_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
              </NativeSelect></div>
            <div className="space-y-1"><Label htmlFor="doc-q">Search title or tag</Label><Input id="doc-q" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          </div>
          {list.isPending ? <LoadingState label="Loading documents" rows={4} /> : null}
          {list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : null}
          {list.data && list.data.items.length === 0 ? <EmptyState title="No documents here" description="Upload one, or ask the owner to share it with you." /> : null}
          {list.data && list.data.items.length > 0 ? (
            <Card>
              <CardContent className="overflow-x-auto p-0">
                <Table data-testid="documents-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Title</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Owner</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Expires</TableHead>
                      <TableHead className="text-right">Size</TableHead>
                      <TableHead>Updated</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {list.data.items.map((d) => (
                      <TableRow key={d.id}>
                        <TableCell>
                          <Link href={`/documents/${d.id}`} className="font-medium text-primary underline-offset-4 hover:underline">{d.title}</Link>
                          <div className="mt-1 flex flex-wrap gap-1"><ConfidentialityBadge level={d.confidentiality} />{d.tags.map((t) => <span key={t} className="rounded bg-muted px-1.5 text-xs">{t}</span>)}</div>
                        </TableCell>
                        <TableCell>{CATEGORY_LABEL[d.category]}</TableCell>
                        <TableCell>{d.owner.displayName ?? d.owner.email}</TableCell>
                        <TableCell><ScanBadge status={d.latestStatus} /></TableCell>
                        <TableCell>{d.expiresAt ? formatWorkDate(d.expiresAt) : '—'}</TableCell>
                        <TableCell className="text-right tabular-nums">{sizeLabel(d.sizeBytes)}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{formatDateTime(d.updatedAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
