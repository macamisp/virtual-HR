'use client';

import { useEffect, useState } from 'react';

/**
 * Reads `token` from the URL fragment (#token=…), falling back to ?token=. Fragments are not
 * sent to servers or in Referer headers. The fragment is removed from the address bar after
 * reading so it does not linger in history.
 */
export function useUrlToken(): string | null | undefined {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const fromHash = hash.get('token');
    const fromQuery = new URLSearchParams(window.location.search).get('token');
    setToken(fromHash ?? fromQuery ?? null);
    if (fromHash || fromQuery) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);
  return token;
}
