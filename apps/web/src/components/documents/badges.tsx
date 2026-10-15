'use client';

import { Loader2, ShieldAlert, ShieldCheck, Upload, XCircle } from 'lucide-react';
import type { Confidentiality, ScanStatus } from '@hrvo/shared';
import { Badge } from '@/components/ui/badge';

const SCAN: Record<ScanStatus, { label: string; variant: 'secondary' | 'warning' | 'success' | 'destructive'; icon: typeof Upload }> = {
  UPLOADING: { label: 'Uploading', variant: 'secondary', icon: Upload },
  PENDING: { label: 'Scanning for viruses', variant: 'warning', icon: Loader2 },
  CLEAN: { label: 'Ready', variant: 'success', icon: ShieldCheck },
  INFECTED: { label: 'Quarantined', variant: 'destructive', icon: ShieldAlert },
  REJECTED: { label: 'Refused', variant: 'destructive', icon: XCircle },
};

export function ScanBadge({ status }: { status: ScanStatus | null }) {
  if (!status) return null;
  const s = SCAN[status];
  return (
    <Badge variant={s.variant} data-testid="scan-status">
      <s.icon className={`mr-1 h-3 w-3 ${status === 'PENDING' ? 'animate-spin' : ''}`} aria-hidden="true" />
      {s.label}
    </Badge>
  );
}

export function ConfidentialityBadge({ level }: { level: Confidentiality }) {
  if (level === 'NORMAL') return null;
  return <Badge variant={level === 'RESTRICTED' ? 'destructive' : 'warning'}>{level === 'RESTRICTED' ? 'Restricted' : 'Confidential'}</Badge>;
}

export function sizeLabel(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
