'use client';

import Link from 'next/link';
import { use, useCallback, useId, useRef, useState } from 'react';
import { ArrowLeft, Eraser, PenLine, ShieldCheck } from 'lucide-react';
import { ESIGN_CONSENT } from '@hrvo/shared';
import type { SignatureRequest } from '@hrvo/shared';
import { SIGN_STATUS } from '@/components/documents/signatures-card';
import { ErrorState, InlineSpinner, LoadingState } from '@/components/state-views';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { formatDateTime } from '@/lib/format';
import { useSign, useSignatureAction, useSignatureRequest, useSignatureVerification } from '@/lib/esign-queries';

const W = 500;
const H = 150;

/** A drawing surface for a signature (mouse, pen or finger); reports a PNG data URL, or null when blank. */
function SignaturePad({ onChange }: { onChange: (png: string | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const inked = useRef(0);
  const ctx = useCallback(() => {
    const c = ref.current?.getContext('2d');
    if (c) { c.lineWidth = 2.5; c.lineCap = 'round'; c.lineJoin = 'round'; c.strokeStyle = '#111827'; }
    return c;
  }, []);
  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const clear = () => {
    ctx()?.clearRect(0, 0, W, H);
    inked.current = 0;
    onChange(null);
  };
  return (
    <div className="space-y-1">
      <canvas
        ref={ref} width={W} height={H} data-testid="signature-pad" aria-label="Draw your signature here"
        className="w-full max-w-[500px] touch-none rounded border bg-white"
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drawing.current = true; const p = point(e); const c = ctx(); c?.beginPath(); c?.moveTo(p.x, p.y); }}
        onPointerMove={(e) => { if (!drawing.current) return; const p = point(e); const c = ctx(); c?.lineTo(p.x, p.y); c?.stroke(); inked.current += 1; }}
        onPointerUp={() => { drawing.current = false; if (inked.current > 5 && ref.current) onChange(ref.current.toDataURL('image/png')); }}
      />
      <Button type="button" size="sm" variant="ghost" onClick={clear}><Eraser aria-hidden="true" /> Clear</Button>
    </div>
  );
}

function SignForm({ r }: { r: SignatureRequest }) {
  const sign = useSign(r.id);
  const decline = useSignatureAction(r.id, 'decline');
  const [method, setMethod] = useState<'DRAW' | 'TYPE'>('DRAW');
  const [png, setPng] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [consent, setConsent] = useState(false);
  const [secret, setSecret] = useState('');
  const [useCode, setUseCode] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const ids = { typed: useId(), secret: useId(), reason: useId() };
  const ready = consent && !!secret && (method === 'DRAW' ? !!png : typed.trim().length >= 2);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    const base = { consentVersion: ESIGN_CONSENT.version, consent: true as const };
    sign.mutate({
      credentials: useCode ? { totpCode: secret.trim() } : { password: secret },
      dto: method === 'DRAW' ? { method, imagePng: png!, ...base } : { method, typedName: typed.trim(), ...base },
    }, { onSettled: () => setSecret('') });
  };
  if (declining) {
    return (
      <form className="space-y-3" aria-label="Decline to sign" onSubmit={(e) => { e.preventDefault(); decline.mutate(reason); }}>
        <div className="space-y-1"><Label htmlFor={ids.reason}>Why are you declining?</Label><Textarea id={ids.reason} rows={3} minLength={3} maxLength={500} required value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        {decline.isError ? <Alert variant="destructive"><AlertDescription>{decline.error.message}</AlertDescription></Alert> : null}
        <div className="flex gap-2"><Button type="submit" variant="destructive" disabled={reason.trim().length < 3 || decline.isPending}>Decline</Button><Button type="button" variant="ghost" onClick={() => setDeclining(false)}>Back</Button></div>
      </form>
    );
  }
  return (
    <form className="space-y-4" aria-label="Sign" onSubmit={submit}>
      <div role="radiogroup" aria-label="How to sign" className="flex gap-1">
        <Button type="button" role="radio" size="sm" aria-checked={method === 'DRAW'} variant={method === 'DRAW' ? 'default' : 'outline'} onClick={() => setMethod('DRAW')}>Draw</Button>
        <Button type="button" role="radio" size="sm" aria-checked={method === 'TYPE'} variant={method === 'TYPE' ? 'default' : 'outline'} onClick={() => setMethod('TYPE')}>Type</Button>
      </div>
      {method === 'DRAW' ? <SignaturePad onChange={setPng} /> : (
        <div className="space-y-1">
          <Label htmlFor={ids.typed}>Your full name</Label>
          <Input id={ids.typed} maxLength={100} value={typed} onChange={(e) => setTyped(e.target.value)} />
          {typed.trim() ? <p className="text-2xl italic" aria-hidden="true">{typed}</p> : null}
        </div>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="esign-consent" />
        <span>{ESIGN_CONSENT.text} <span className="text-xs text-muted-foreground">({ESIGN_CONSENT.version})</span></span>
      </label>
      <div className="space-y-1">
        <Label htmlFor={ids.secret} className="flex items-center gap-1"><ShieldCheck className="h-4 w-4" aria-hidden="true" /> {useCode ? 'Code from your authenticator app' : 'Confirm with your account password'}</Label>
        <Input id={ids.secret} type={useCode ? 'text' : 'password'} inputMode={useCode ? 'numeric' : undefined} autoComplete={useCode ? 'one-time-code' : 'current-password'} value={secret} onChange={(e) => setSecret(e.target.value)} />
        <Button type="button" variant="link" size="sm" className="px-0" onClick={() => { setUseCode((c) => !c); setSecret(''); }}>{useCode ? 'Use my password instead' : 'Use an authenticator code'}</Button>
      </div>
      {sign.isError ? <Alert variant="destructive"><AlertDescription>{sign.error.message}</AlertDescription></Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!ready || sign.isPending}><PenLine aria-hidden="true" /> {sign.isPending ? 'Signing…' : 'Sign'}</Button>
        <Button type="button" variant="outline" onClick={() => setDeclining(true)}>Decline</Button>
      </div>
    </form>
  );
}

function Verification({ r }: { r: SignatureRequest }) {
  const v = useSignatureVerification(r.id, true);
  if (v.isPending) return <InlineSpinner label="Checking fingerprints" />;
  if (v.isError) return <Alert variant="destructive"><AlertDescription>{v.error.message}</AlertDescription></Alert>;
  const d = v.data;
  return (
    <div className="space-y-2 text-sm" data-testid="esign-verification">
      <p>Original as requested: {d.sourceIntact ? <Badge variant="success">Unchanged</Badge> : <Badge variant="destructive">Does not match</Badge>}</p>
      {r.status === 'COMPLETED' ? <p>Signed copy: {d.signedIntact === null ? <Badge variant="secondary">Being scanned</Badge> : d.signedIntact ? <Badge variant="success">Unchanged</Badge> : <Badge variant="destructive">Does not match</Badge>}</p> : null}
      {d.signedSha256 ? <p className="break-all font-mono text-xs">SHA-256 {d.signedSha256}</p> : null}
      <ol className="space-y-1">{d.events.map((e, i) => <li key={i} className="text-xs text-muted-foreground">{formatDateTime(e.at)} · {e.what}</li>)}</ol>
    </div>
  );
}

/** FR-DOC-014: review, sign or decline; requesters follow progress, cancel, and verify the result. */
export default function SignaturePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const req = useSignatureRequest(id);
  const cancel = useSignatureAction(id, 'cancel');
  const finalize = useSignatureAction(id, 'finalize');
  if (req.isPending) return <LoadingState label="Loading signature request" rows={5} />;
  if (req.isError) return <ErrorState error={req.error} onRetry={() => void req.refetch()} />;
  const r = req.data;
  const allSigned = r.signers.every((s) => s.status === 'SIGNED');
  return (
    <div className="space-y-4">
      <Link href="/signatures" className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"><ArrowLeft className="h-4 w-4" aria-hidden="true" /> Signatures</Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold" data-testid="esign-title">{r.documentTitle}</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant={SIGN_STATUS[r.status].variant} data-testid="esign-status">{SIGN_STATUS[r.status].label}</Badge>
            <span className="text-muted-foreground">requested by {r.requestedBy.displayName ?? r.requestedBy.email} · {formatDateTime(r.createdAt)}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild><Link href={`/documents/${r.documentId}`}>Open the document</Link></Button>
          {r.canCancel ? <Button variant="outline" disabled={cancel.isPending} onClick={() => { if (window.confirm('Cancel this signature request? Signatures already given stay in the audit log.')) cancel.mutate(undefined); }}>Cancel request</Button> : null}
        </div>
      </div>
      {cancel.isError ? <Alert variant="destructive"><AlertDescription>{cancel.error.message}</AlertDescription></Alert> : null}
      {r.message ? <Alert><AlertTitle>Message</AlertTitle><AlertDescription className="whitespace-pre-wrap">{r.message}</AlertDescription></Alert> : null}
      {r.status === 'OPEN' && allSigned && r.canCancel ? (
        <Alert variant="destructive">
          <AlertTitle>Everyone has signed, but the signed copy was not produced</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{finalize.isError ? finalize.error.message : 'Try again; if it keeps failing the stored file may not match its fingerprint.'}</p>
            <Button size="sm" disabled={finalize.isPending} onClick={() => finalize.mutate(undefined)}>Produce the signed copy</Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {r.canSign ? (
            <Card>
              <CardHeader><CardTitle className="text-base">Your signature</CardTitle><CardDescription>Read the document first. Your signature, the time, your IP address and the document fingerprint are recorded.</CardDescription></CardHeader>
              <CardContent><SignForm r={r} /></CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader><CardTitle className="text-base">Verification</CardTitle><CardDescription>Fingerprints (SHA-256) recorded when signatures were requested and when the signed copy was produced.</CardDescription></CardHeader>
            <CardContent><Verification r={r} /></CardContent>
          </Card>
        </div>
        <Card>
          <CardHeader><CardTitle className="text-base">Signers</CardTitle></CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm" data-testid="esign-signers">
              {r.signers.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>{s.displayName ?? s.email}</span>
                  {s.status === 'SIGNED' ? <Badge variant="success">Signed {s.signedAt ? formatDateTime(s.signedAt) : ''}</Badge> : s.status === 'DECLINED' ? <Badge variant="destructive">Declined</Badge> : <Badge variant="secondary">Waiting</Badge>}
                  {s.declineReason ? <p className="w-full text-xs text-muted-foreground">“{s.declineReason}”</p> : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
