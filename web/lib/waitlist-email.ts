import nodemailer from 'nodemailer';

const SUBJECT = 'You’re on the Legate waitlist';

const TEXT = `You're on the Legate waitlist.

Legate routes encrypted trade intents through a confidential enclave on Horizen, so opposing flow is netted before the market ever sees it. It isn't live yet. We'll email you once, when the first vaults open to strategists and depositors.

Didn't sign up, or want off the list? Just reply to this email.

— Legate
`;

const HTML = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#0b0b0d;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0b0d;">
      <tr>
        <td align="center" style="padding:40px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#121215;border:1px solid #26262c;border-radius:10px;">
            <tr>
              <td style="padding:32px 32px 8px;font-family:'SFMono-Regular',Consolas,monospace;font-size:13px;letter-spacing:0.34em;color:#ececee;">
                LEGATE
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:22px;font-weight:600;line-height:1.3;color:#ececee;">
                You’re on the waitlist.
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#a1a1aa;">
                Legate routes encrypted trade intents through a confidential enclave on Horizen, so opposing flow is netted before the market ever sees it.
              </td>
            </tr>
            <tr>
              <td style="padding:12px 32px 0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#a1a1aa;">
                It isn’t live yet. We’ll email you once, when the first vaults open to strategists and depositors.
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 32px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#71717a;">
                Didn’t sign up, or want off the list? Just reply to this email.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

/**
 * Sends the "you're on the list" confirmation: through Resend from the
 * legate.finance domain when RESEND_API_KEY is set, otherwise over Gmail SMTP.
 * Does nothing when neither is configured (local dev, or a deploy that hasn't
 * been given credentials yet) so a missing env var never breaks signup.
 */
export async function sendWaitlistConfirmation(to: string): Promise<void> {
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    const from = process.env.WAITLIST_FROM ?? 'hello@legate.finance';
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `Legate <${from}>`,
        to: [to],
        reply_to: process.env.WAITLIST_REPLY_TO ?? 'legatefinance@gmail.com',
        subject: SUBJECT,
        text: TEXT,
        html: HTML,
      }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
    return;
  }

  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    console.warn('waitlist confirmation skipped: no RESEND_API_KEY or GMAIL_* credentials set');
    return;
  }

  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  await transporter.sendMail({
    from: { name: 'Legate', address: user },
    to,
    subject: SUBJECT,
    text: TEXT,
    html: HTML,
  });
}
