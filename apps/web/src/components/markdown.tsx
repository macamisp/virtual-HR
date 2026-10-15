'use client';

import { useMemo } from 'react';
import { renderMarkdown } from '@/lib/markdown';
import { cn } from '@/lib/utils';

/** Renders sanitised Markdown (see lib/markdown.ts). */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return (
    <div
      className={cn(
        'prose-sm max-w-none break-words leading-relaxed [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_h2]:mt-3 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-5 [&_mark.mention]:rounded [&_mark.mention]:bg-primary/15 [&_mark.mention]:px-1 [&_mark.mention]:text-primary [&_ol]:list-decimal [&_p]:my-1.5 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_ul]:list-disc',
        className,
      )}
      // Sanitised by DOMPurify in renderMarkdown.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
