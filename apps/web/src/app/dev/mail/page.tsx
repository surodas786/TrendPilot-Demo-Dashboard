import { notFound } from 'next/navigation';
import { getDb, listCapturedEmails } from '@trendpilot/db';
import { devMailboxEnabled } from '@/server/devMailbox';

export const dynamic = 'force-dynamic';

/** Development email capture (SRS §13 mock email). Absent in production. */
export default async function DevMailbox() {
  if (!devMailboxEnabled()) notFound();
  const mails = await listCapturedEmails(getDb(), 50);
  const linkify = (text: string) =>
    text.split(/(https?:\/\/\S+)/g).map((part, i) =>
      /^https?:\/\//.test(part) ? (
        <a key={i} href={part} className="break-all text-accent underline">
          {part}
        </a>
      ) : (
        <span key={i}>{part}</span>
      )
    );
  return (
    <div className="min-h-[100dvh] bg-canvas px-4 py-8 text-ink">
      <div className="mx-auto max-w-3xl space-y-4">
        <header>
          <h1 className="text-xl font-bold">Development mailbox</h1>
          <p className="mt-1 text-sm text-muted">Emails captured locally instead of being sent. Disabled in production. Newest first.</p>
        </header>
        {mails.length === 0 && <p className="text-sm text-subtle">No emails yet.</p>}
        <ul className="space-y-3">
          {mails.map((m) => (
            <li key={m.id} data-testid="captured-email" className="rounded-xl border border-line bg-surface p-4">
              <p className="text-xs text-subtle">
                {new Date(m.createdAt).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' })} · {m.template}
              </p>
              <p className="mt-1 font-semibold">{m.subject}</p>
              <p className="text-sm text-muted">To: {m.to}</p>
              <pre className="mt-3 whitespace-pre-wrap font-sans text-sm text-ink">{linkify(m.body)}</pre>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
