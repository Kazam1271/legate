import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import Link from 'next/link';

import { SiteNav } from '@/components/site-nav';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono-face',
});

export const metadata: Metadata = {
  title: {
    default: 'Legate — private agentic trading vaults',
    template: '%s — Legate',
  },
  description:
    'Legate routes encrypted trade intents through a confidential enclave on Horizen. Opposing flow is netted before the market ever sees it.',
  icons: {
    icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }],
    shortcut: [{ url: '/favicon.svg', type: 'image/svg+xml' }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable + ' ' + mono.variable}>
      <body className="min-h-screen antialiased">
        <SiteNav />
        <main>{children}</main>
        <footer className="mt-24 border-t border-line">
          <div className="mx-auto flex max-w-[1240px] flex-col gap-4 px-5 py-10 text-xs text-faint sm:flex-row sm:items-center sm:justify-between sm:px-8">
            <p>
              Legate — private agentic trading vaults on Horizen. Interface preview with
              representative data; not connected to a live deployment.
            </p>
            <nav className="flex gap-5" aria-label="Footer">
              <Link href="/batches" className="hover:text-muted">
                Transparency
              </Link>
              <a
                href="https://github.com/Kazam1271/legate"
                className="hover:text-muted"
                target="_blank"
                rel="noreferrer"
              >
                Source
              </a>
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}
