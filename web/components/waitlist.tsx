'use client';

import { useState, type FormEvent } from 'react';

type Status = 'idle' | 'loading' | 'success' | 'error';

export function Waitlist() {
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (status === 'loading') return;
    setStatus('loading');
    setError('');

    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, company }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Something went wrong. Try again.');
        setStatus('error');
        return;
      }
      setStatus('success');
      setEmail('');
    } catch {
      setError('Something went wrong. Try again.');
      setStatus('error');
    }
  }

  if (status === 'success') {
    return (
      <p className="flex items-center gap-2 text-sm text-accent">
        <span aria-hidden>&#10003;</span>
        You&rsquo;re on the list — we&rsquo;ll email you when strategy slots open.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <div className="flex-1">
        <label htmlFor="waitlist-email" className="sr-only">
          Email address
        </label>
        <input
          id="waitlist-email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@domain.com"
          className="w-full rounded-lg border border-line bg-surface-2 px-4 py-3 text-sm text-fg placeholder:text-faint outline-none transition-colors focus:border-accent"
        />
        {/* Honeypot: hidden from real visitors, bots fill every field they find. */}
        <input
          type="text"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          className="hidden"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden
        />
        {error ? <p className="mt-2 text-xs text-negative">{error}</p> : null}
      </div>
      <button
        type="submit"
        disabled={status === 'loading'}
        className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-accent px-5 py-3 text-sm font-semibold text-[#1a1206] transition-colors hover:bg-accent-bright disabled:opacity-60"
      >
        {status === 'loading' ? 'Joining…' : 'Join the waitlist'}
      </button>
    </form>
  );
}
