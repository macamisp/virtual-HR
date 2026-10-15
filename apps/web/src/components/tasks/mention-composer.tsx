'use client';

import { useId, useMemo, useRef, useState } from 'react';
import type { UserRef } from '@hrvo/shared';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/**
 * Comment box with @mentions (FR-TASK-006). Typing "@" opens a list of people who can see the
 * task; ↑/↓ choose, Enter/Tab insert, Esc closes. Mentions are inserted as
 * @[Name](user:<id>), which the API validates and the renderer shows as a highlighted name.
 */
export function MentionComposer({
  label,
  value,
  onChange,
  candidates,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  candidates: UserRef[];
}) {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<{ text: string; start: number } | null>(null);
  const [active, setActive] = useState(0);

  const matches = useMemo(() => {
    if (!query) return [];
    const q = query.text.toLowerCase();
    return candidates.filter((u) => (u.displayName ?? '').toLowerCase().includes(q) || u.email.toLowerCase().includes(q)).slice(0, 8);
  }, [candidates, query]);
  const open = !!query && matches.length > 0;

  const detect = (text: string, caret: number) => {
    const upto = text.slice(0, caret);
    const m = /(^|\s)@([\p{L}\p{N}._-]{0,30})$/u.exec(upto);
    setQuery(m ? { text: m[2]!, start: caret - m[2]!.length - 1 } : null);
    setActive(0);
  };

  const insert = (u: UserRef) => {
    if (!query) return;
    const caret = ref.current?.selectionStart ?? value.length;
    const name = (u.displayName ?? u.email).replace(/[[\]\n]/g, '');
    const token = `@[${name}](user:${u.id}) `;
    const next = value.slice(0, query.start) + token + value.slice(caret);
    onChange(next);
    setQuery(null);
    requestAnimationFrame(() => {
      const pos = query.start + token.length;
      ref.current?.focus();
      ref.current?.setSelectionRange(pos, pos);
    });
  };

  return (
    <div className="relative space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        ref={ref}
        rows={3}
        value={value}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={open ? `${id}-opt-${active}` : undefined}
        aria-describedby={`${id}-hint`}
        onChange={(e) => {
          onChange(e.target.value);
          detect(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => (a + 1) % matches.length);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => (a - 1 + matches.length) % matches.length);
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            insert(matches[active]!);
          } else if (e.key === 'Escape') {
            setQuery(null);
          }
        }}
      />
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">Markdown supported. Type @ to mention someone who can see this task.</p>
      {open ? (
        <ul id={`${id}-list`} role="listbox" aria-label="People you can mention" className="absolute z-10 mt-1 w-72 rounded-md border bg-card p-1 shadow-md">
          {matches.map((u, i) => (
            <li
              key={u.id}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                insert(u);
              }}
              className={cn('cursor-pointer rounded px-2 py-1 text-sm', i === active && 'bg-accent')}
            >
              {u.displayName ?? u.email} <span className="text-xs text-muted-foreground">{u.email}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
