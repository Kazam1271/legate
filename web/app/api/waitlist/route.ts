import { put } from '@vercel/blob';
import { after, NextResponse } from 'next/server';

import { sendWaitlistConfirmation } from '@/lib/waitlist-email';

// Deliberately narrow: no commas, brackets, quotes or slashes, so the address can
// only ever name one recipient when handed to the mailer, and is safe to use as
// part of a blob pathname.
const EMAIL_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);

  // Honeypot: bots fill every field they find; a real visitor never sees this one.
  if (typeof body?.company === 'string' && body.company.trim() !== '') {
    return NextResponse.json({ ok: true });
  }

  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });
  }

  // One object per address, named by the address itself: a repeat signup collides
  // with the existing object instead of adding a duplicate, so the list counts
  // unique people and only a first signup ever triggers an email. Naming it by the
  // address also means the store's file listing reads as the waitlist.
  try {
    await put(
      `waitlist/${email}.json`,
      JSON.stringify({ email, submittedAt: new Date().toISOString() }),
      { access: 'private', contentType: 'application/json', allowOverwrite: false },
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) {
      return NextResponse.json({ ok: true });
    }
    throw err;
  }

  after(() =>
    sendWaitlistConfirmation(email).catch((err) => {
      console.error('waitlist confirmation failed', err);
    }),
  );

  return NextResponse.json({ ok: true });
}
