'use client';

import { useId, useState } from 'react';
import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useOfficePeople } from '@/lib/office-queries';

export interface PickedPerson { id: string; name: string }

/** Search colleagues by name, email or team and pick several (meetings, group chats, channels). */
export function PeoplePicker({ label, value, onChange, excludeId, max = 49 }: { label: string; value: PickedPerson[]; onChange: (v: PickedPerson[]) => void; excludeId?: string; max?: number }) {
  const [q, setQ] = useState('');
  const people = useOfficePeople(q.trim());
  const id = useId();
  const picked = new Set(value.map((p) => p.id));
  const options = (people.data?.items ?? []).filter((p) => p.id !== excludeId && !picked.has(p.id)).slice(0, 8);
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {value.length ? (
        <ul className="flex flex-wrap gap-1" aria-label={`${label}: chosen`}>
          {value.map((p) => (
            <li key={p.id}><Badge variant="secondary" className="gap-1">{p.name}<button type="button" aria-label={`Remove ${p.name}`} onClick={() => onChange(value.filter((x) => x.id !== p.id))}><X className="h-3 w-3" aria-hidden="true" /></button></Badge></li>
          ))}
        </ul>
      ) : null}
      <Input id={id} type="search" value={q} placeholder="Search by name, email or team" onChange={(e) => setQ(e.target.value)} disabled={value.length >= max} />
      {q.trim() ? (
        <ul className="max-h-48 overflow-auto rounded border" aria-label={`${label}: matches`}>
          {people.isPending ? <li className="p-2 text-sm text-muted-foreground">Searching…</li> : null}
          {people.isError ? <li className="p-2 text-sm text-destructive">{people.error.message}</li> : null}
          {people.data && !options.length ? <li className="p-2 text-sm text-muted-foreground">No one found.</li> : null}
          {options.map((p) => (
            <li key={p.id}>
              <Button type="button" variant="ghost" size="sm" className="w-full justify-start" onClick={() => { onChange([...value, { id: p.id, name: p.displayName ?? p.email }]); setQ(''); }}>
                {p.displayName ?? p.email} <span className="text-xs text-muted-foreground">{p.email}</span>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
