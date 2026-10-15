'use client';

import { AlertTriangle, Inbox, Loader2, ShieldOff } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export function LoadingState({ label = 'Loading…', rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite" className="space-y-3">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

export function InlineSpinner({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      {label}
    </span>
  );
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-8 text-center">
      <Inbox className="mb-2 h-6 w-6 text-muted-foreground" aria-hidden="true" />
      <p className="font-medium">{title}</p>
      {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  return (
    <Alert variant="destructive">
      <AlertTriangle className="h-4 w-4" aria-hidden="true" />
      <AlertTitle>Could not load this section</AlertTitle>
      <AlertDescription>
        <p>{message}</p>
        {onRetry ? (
          <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

export function AccessDenied({ what }: { what: string }) {
  return (
    <Alert variant="warning" data-testid="access-denied">
      <ShieldOff className="h-4 w-4" aria-hidden="true" />
      <AlertTitle>You don&apos;t have access</AlertTitle>
      <AlertDescription>
        {what} is available to team leads, managers and HR. Ask an administrator if you need access.
      </AlertDescription>
    </Alert>
  );
}
