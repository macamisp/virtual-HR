'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { ReauthStatusSchema } from '@hrvo/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, apiDownload, apiFetch } from '@/lib/api';

export type ContentMode = 'download' | 'preview' | 'view';
export interface OpenedContent {
  blob: Blob;
  filename: string;
  viewOnly: boolean;
}

type Prompt =
  | { kind: 'reauth'; error?: string; resolve: (v: { password?: string; totpCode?: string }) => void; reject: () => void }
  | { kind: 'password'; error?: string; resolve: (password: string) => void; reject: () => void };

class Cancelled extends Error {}

/**
 * FR-DOC-005 / 006 in the browser: opens document content and, when the API asks for it,
 * prompts for a re-authentication (password or authenticator code) or the document password,
 * then retries. The document password stays in memory for this page only.
 */
export function useVaultOpen(documentId: string) {
  const qc = useQueryClient();
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const docPassword = useRef<string | null>(null);
  useEffect(() => () => {
    docPassword.current = null;
  }, [documentId]);

  const ask = useCallback(<K extends Prompt['kind']>(kind: K, error?: string) =>
    new Promise<K extends 'reauth' ? { password?: string; totpCode?: string } : string>((resolve, reject) => {
      setPrompt({ kind, error, resolve: resolve as never, reject: () => reject(new Cancelled('cancelled')) } as Prompt);
    }), []);

  const open = useCallback(async (mode: ContentMode, versionId?: string): Promise<OpenedContent> => {
    const path = mode === 'download' ? 'download' : mode;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const res = docPassword.current
          ? await apiDownload(`/documents/${documentId}/content`, { method: 'POST', body: { mode, versionId, password: docPassword.current } })
          : await apiDownload(`/documents/${documentId}/${path}${versionId ? `?versionId=${versionId}` : ''}`);
        setPrompt(null);
        return res;
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        if (err.code === 'REAUTH_REQUIRED') {
          let creds = await ask('reauth');
          for (;;) {
            try {
              await apiFetch('/vault/reauth', { method: 'POST', body: creds, schema: ReauthStatusSchema });
              void qc.invalidateQueries({ queryKey: ['vault', 'reauth'] });
              break;
            } catch (e) {
              creds = await ask('reauth', e instanceof ApiError && e.status === 401 ? 'That did not match. Try again.' : (e as Error).message);
            }
          }
          continue;
        }
        if (err.code === 'PASSWORD_REQUIRED' || err.code === 'WRONG_DOCUMENT_PASSWORD') {
          docPassword.current = await ask('password', err.code === 'WRONG_DOCUMENT_PASSWORD' ? 'Wrong document password.' : undefined);
          continue;
        }
        setPrompt(null);
        throw err;
      }
    }
    throw new Error('Could not open the document');
  }, [ask, documentId, qc]);

  const dialog = prompt ? <VaultPrompt prompt={prompt} onClose={() => { prompt.reject(); setPrompt(null); }} /> : null;
  return { open, dialog, isCancel: (e: unknown) => e instanceof Cancelled };
}

function VaultPrompt({ prompt, onClose }: { prompt: Prompt; onClose: () => void }) {
  const [value, setValue] = useState('');
  const [useCode, setUseCode] = useState(false);
  const id = useId();
  const reauth = prompt.kind === 'reauth';
  return (
    <div role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid={reauth ? 'reauth-dialog' : 'doc-password-dialog'}>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle id={`${id}-t`} className="flex items-center gap-2 text-base">
            {reauth ? <ShieldCheck className="h-4 w-4" aria-hidden="true" /> : <KeyRound className="h-4 w-4" aria-hidden="true" />}
            {reauth ? 'Confirm it is you' : 'Document password'}
          </CardTitle>
          <CardDescription>
            {reauth ? 'Confidential documents need a recent sign-in check. It lasts a few minutes.' : 'This document is protected by its own password. Three wrong attempts lock it for 15 minutes.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-3" onSubmit={(e) => {
            e.preventDefault();
            if (!value) return;
            if (prompt.kind === 'reauth') prompt.resolve(useCode ? { totpCode: value.trim() } : { password: value });
            else prompt.resolve(value);
            setValue('');
          }}>
            <div className="space-y-1.5">
              <Label htmlFor={id}>{reauth ? (useCode ? 'Code from your authenticator app' : 'Your account password') : 'Document password'}</Label>
              <Input id={id} type={reauth && useCode ? 'text' : 'password'} inputMode={reauth && useCode ? 'numeric' : undefined} autoComplete={reauth && !useCode ? 'current-password' : 'off'}
                autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
            </div>
            {prompt.error ? <Alert variant="destructive"><AlertDescription>{prompt.error}</AlertDescription></Alert> : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={!value}>{reauth ? 'Confirm' : 'Unlock'}</Button>
              <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
              {reauth ? <Button type="button" variant="link" onClick={() => { setUseCode((c) => !c); setValue(''); }}>{useCode ? 'Use my password instead' : 'Use an authenticator code'}</Button> : null}
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
