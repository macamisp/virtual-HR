'use client';

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { MENTION_PATTERN } from '@hrvo/shared';

/**
 * Task descriptions and comments are Markdown. They are rendered with `marked` and then
 * sanitised with DOMPurify against a small allow-list; nothing user-written reaches the DOM
 * unsanitised. Mentions (@[Name](user:<id>)) become highlighted names.
 */
const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a',
  'h1', 'h2', 'h3', 'h4', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'mark',
];
const ALLOWED_ATTR = ['href', 'title', 'class'];

let hooked = false;
function ensureHooks(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function renderMarkdown(source: string): string {
  if (typeof window === 'undefined') return escapeHtml(source);
  ensureHooks();
  const withMentions = source.replace(MENTION_PATTERN, (_m, name: string) => `<mark class="mention">@${escapeHtml(name)}</mark>`);
  const html = marked.parse(withMentions, { async: false, gfm: true, breaks: true });
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOW_DATA_ATTR: false });
}
