'use client';

import { Menu, X } from 'lucide-react';
import { useEffect, useRef, type MouseEvent } from 'react';

export interface NavLink {
  href: string;
  label: string;
}

/**
 * The phone-width navigation: a native disclosure, so it works before (and without) JavaScript.
 * The script only closes it after a link is chosen, on Escape, and when focus or a click leaves it.
 */
export function MobileMenu({ links, loginHref, signupHref }: { links: NavLink[]; loginHref: string; signupHref: string }) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const details = ref.current;
    if (!details) return;
    const close = () => { details.open = false; };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && details.open) {
        close();
        details.querySelector('summary')?.focus();
      }
    };
    const onPointer = (e: PointerEvent) => {
      if (details.open && e.target instanceof Node && !details.contains(e.target)) close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, []);

  const onClick = (e: MouseEvent<HTMLElement>) => {
    if (e.target instanceof HTMLElement && e.target.closest('a') && ref.current) ref.current.open = false;
  };

  return (
    <details ref={ref} className="group relative md:hidden">
      <summary
        className="flex h-10 w-10 cursor-pointer list-none items-center justify-center rounded-md border bg-background text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
        aria-label="Menu"
      >
        <Menu className="h-5 w-5 group-open:hidden" aria-hidden="true" />
        <X className="hidden h-5 w-5 group-open:block" aria-hidden="true" />
      </summary>
      <nav
        aria-label="Mobile"
        onClick={onClick}
        className="absolute right-0 top-12 z-50 w-64 rounded-lg border bg-card p-2 text-card-foreground shadow-lg"
      >
        <ul className="space-y-1">
          {links.map((l) => (
            <li key={l.href}>
              <a href={l.href} className="block rounded-md px-3 py-2 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {l.label}
              </a>
            </li>
          ))}
        </ul>
        <div className="mt-2 grid gap-2 border-t pt-2">
          <a href={loginHref} className="rounded-md px-3 py-2 text-center text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Log in
          </a>
          <a href={signupHref} className="rounded-md bg-primary px-3 py-2 text-center text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
            Get started
          </a>
        </div>
      </nav>
    </details>
  );
}
