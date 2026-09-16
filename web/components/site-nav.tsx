'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

import { LegateMark } from '@/components/logo';

const LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/vaults', label: 'Vaults' },
  { href: '/batches', label: 'Batches' },
  { href: '/console', label: 'Console' },
];

export function SiteNav() {
  // usePathname, never window.location — the latter does not exist during the
  // server render, and reading it at render time breaks hydration.
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  return (
    <header className="sticky top-0 z-50 border-b border-line bg-canvas/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1240px] items-center gap-4 px-5 sm:px-8">
        {/* Three equal-growing regions — left and right both flex-1 — is what
            centres the nav on the bar itself rather than on the leftover space
            after the logo, which is what `ml-4 flex-1` used to do. */}
        <div className="flex flex-1 items-center">
          <Link href="/" className="flex shrink-0 items-center gap-2.5" aria-label="Legate home">
            <LegateMark size={30} animated compact />
            <span className="text-[15px] font-semibold tracking-[0.22em]">LEGATE</span>
          </Link>
        </div>

        <nav className="hidden shrink-0 items-center gap-1 md:flex" aria-label="Primary">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={isActive(link.href) ? 'page' : undefined}
              className={
                'relative px-3.5 py-5 text-sm transition-colors ' +
                (isActive(link.href) ? 'text-fg' : 'text-muted hover:text-fg')
              }
            >
              {link.label}
              {isActive(link.href) ? (
                <span className="absolute inset-x-3.5 -bottom-px h-px bg-accent" aria-hidden />
              ) : null}
            </Link>
          ))}
        </nav>

        <div className="flex flex-1 items-center justify-end gap-3">
          <span className="hidden items-center gap-2 font-mono text-xs text-muted lg:flex">
            <span className="size-1.5 rounded-full bg-positive" aria-hidden />
            Vela mainnet
          </span>

          <button
            type="button"
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-[#1a1206] transition-colors hover:bg-accent-bright"
          >
            Connect wallet
          </button>

          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label="Toggle navigation"
            className="rounded-lg border border-line p-2 text-muted hover:text-fg md:hidden"
          >
            <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden>
              <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      {open ? (
        <nav className="border-t border-line bg-surface px-5 py-2 md:hidden" aria-label="Primary mobile">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className={
                'block rounded-lg px-3 py-3 text-sm ' +
                (isActive(link.href) ? 'bg-raised text-accent' : 'text-muted')
              }
            >
              {link.label}
            </Link>
          ))}
        </nav>
      ) : null}
    </header>
  );
}
