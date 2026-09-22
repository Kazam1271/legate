import { put } from '@vercel/blob';
import { NextResponse } from 'next/server';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  await put(
    `waitlist/${Date.now()}-${crypto.randomUUID()}.json`,
    JSON.stringify({ email, submittedAt: new Date().toISOString() }),
    { access: 'private', contentType: 'application/json' },
  );

  return NextResponse.json({ ok: true });
}
