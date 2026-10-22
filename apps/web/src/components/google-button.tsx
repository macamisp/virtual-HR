'use client';

import { useState } from 'react';
import type { GoogleStartDto } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { startGoogleSignIn } from '@/lib/sso';

/**
 * "Continue with Google" (FR-AUTH-005). Explains itself when the server has no client id; `disabled`
 * lets a page hold it back until its own step is complete (the signup page: the workspace name).
 */
export function GoogleButton({ dto, label = 'Continue with Google', onError, disabled = false }: { dto: GoogleStartDto; label?: string; onError: (message: string) => void; disabled?: boolean }) {
  const [pending, setPending] = useState(false);
  return (
    <Button type="button" variant="outline" disabled={pending || disabled} onClick={async () => {
      setPending(true);
      try {
        await startGoogleSignIn(dto);
      } catch (err) {
        onError(err instanceof Error ? err.message : 'Google sign-in is not available');
        setPending(false);
      }
    }}>
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4"><path fill="currentColor" d="M21.6 12.2c0-.7-.1-1.3-.2-1.9H12v3.7h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3Z"/><path fill="currentColor" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22Z" opacity=".7"/><path fill="currentColor" d="M6.4 14a6 6 0 0 1 0-3.9V7.5H3.1a10 10 0 0 0 0 9l3.3-2.5Z" opacity=".5"/><path fill="currentColor" d="M12 6c1.5 0 2.8.5 3.8 1.5l2.8-2.8A10 10 0 0 0 3.1 7.5l3.3 2.6C7.2 7.8 9.4 6 12 6Z" opacity=".85"/></svg>
      {pending ? 'Opening Google…' : label}
    </Button>
  );
}
