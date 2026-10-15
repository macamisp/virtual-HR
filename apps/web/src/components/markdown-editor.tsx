'use client';

import { useId, useState } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Markdown } from '@/components/markdown';
import { cn } from '@/lib/utils';

/** Markdown textarea with a Write / Preview toggle. */
export function MarkdownEditor({
  label,
  value,
  onChange,
  rows = 6,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  maxLength?: number;
}) {
  const id = useId();
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label htmlFor={id}>{label}</Label>
        <div role="tablist" aria-label={`${label} mode`} className="flex gap-1 text-xs">
          {(['write', 'preview'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn('rounded px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', tab === t ? 'bg-accent font-medium' : 'text-muted-foreground')}
            >
              {t === 'write' ? 'Write' : 'Preview'}
            </button>
          ))}
        </div>
      </div>
      {tab === 'write' ? (
        <>
          <Textarea id={id} rows={rows} value={value} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} aria-describedby={`${id}-hint`} />
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">Markdown: **bold**, _italic_, `code`, - lists, [links](https://…)</p>
        </>
      ) : (
        <div className="min-h-[6rem] rounded-md border p-3 text-sm" role="tabpanel" aria-label="Preview">
          {value.trim() ? <Markdown source={value} /> : <p className="text-muted-foreground">Nothing to preview.</p>}
        </div>
      )}
    </div>
  );
}
