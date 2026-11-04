'use client';

import { useEffect, useState } from 'react';
import { LinkStatusSchema, MessageResponseSchema } from '@hrvo/shared';
import type { LinkKind, LinkStatus } from '@hrvo/shared';
import { apiFetch } from './api';

/** ADR 039: what an e-mailed link can still do, asked once when its page opens. */
export function useLinkStatus(kind: LinkKind, token: string | null | undefined): { status: LinkStatus | null; error: string | null } {
  const [status, setStatus] = useState<LinkStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!token) return;
    let live = true;
    apiFetch('/auth/links/status', { method: 'POST', auth: 'none', body: { kind, token }, schema: LinkStatusSchema })
      .then((s) => { if (live) setStatus(s); })
      .catch((err: unknown) => { if (live) setError(err instanceof Error ? err.message : 'Could not check the link'); });
    return () => { live = false; };
  }, [kind, token]);
  return { status, error };
}

/** A new link, sent to the address the old one went to. */
export async function renewLink(kind: LinkKind, token: string): Promise<string> {
  const r = await apiFetch('/auth/links/renew', { method: 'POST', auth: 'none', body: { kind, token }, schema: MessageResponseSchema });
  return r.message ?? 'A new link is on its way.';
}

/** The sign-in page with the address filled in (and where to go afterwards). */
export function signInHref(email?: string | null, returnTo?: string): string {
  const q = new URLSearchParams();
  if (email) q.set('email', email);
  if (returnTo) q.set('returnTo', returnTo);
  const s = q.toString();
  return s ? `/login?${s}` : '/login';
}

/**
 * Development only: where to read the e-mails the API sent (Mailhog). Shown on "Check your
 * e-mail" when NEXT_PUBLIC_MAIL_VIEWER_URL is set, or in `next dev` by default; never in a
 * production build unless someone sets it on purpose (they should not).
 */
export function mailViewerUrl(): string | null {
  const configured = process.env.NEXT_PUBLIC_MAIL_VIEWER_URL;
  if (configured) return configured;
  return process.env.NODE_ENV === 'development' ? 'http://localhost:8025' : null;
}
