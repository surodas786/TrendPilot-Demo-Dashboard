'use client';

import React, { useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2Icon, KeyRoundIcon, SaveIcon, SendIcon, XCircleIcon } from 'lucide-react';
import type { MailBoxViewDto, MailTestResultDto, SmtpSecurity } from '@trendpilot/domain';
import { issueMap, request } from '@/lib/api';
import { Button } from '../ui/Button';
import { SegmentedControl } from '../ui/SegmentedControl';
import { StatusPill } from '../ui/StatusPill';
import { TextField } from '../ui/TextField';

const fmt = (iso: string | null, tz: string) => (iso ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(iso)) : '—');

interface Form {
  host: string;
  port: string;
  security: SmtpSecurity;
  username: string;
  password: string;
  clearPassword: boolean;
  senderName: string;
  senderEmail: string;
  replyTo: string;
}

const formFrom = (v: MailBoxViewDto): Form => ({
  host: v.settings.host,
  port: String(v.settings.port),
  security: v.settings.security,
  username: v.settings.username,
  password: '',
  clearPassword: false,
  senderName: v.settings.senderName,
  senderEmail: v.settings.senderEmail,
  replyTo: v.settings.replyTo
});

const sameForm = (a: Form, b: Form) => (Object.keys(a) as (keyof Form)[]).every((k) => a[k] === b[k]);

function Card({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-4 lg:p-5">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {description && <p className="mt-0.5 text-xs text-subtle">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function TestResult({ t, timezone }: { t: MailTestResultDto | null; timezone: string }) {
  if (!t) return <p className="text-sm text-subtle" data-testid="mail-last-test">No test email sent yet.</p>;
  return (
    <div className={`rounded-lg border p-3 text-sm ${t.ok ? 'border-gain/30 bg-gain/5' : 'border-loss/35 bg-loss/5'}`} data-testid="mail-last-test" data-ok={t.ok}>
      <p className={`flex items-center gap-1.5 font-semibold ${t.ok ? 'text-gain' : 'text-loss'}`}>
        {t.ok ? <CheckCircle2Icon className="h-4 w-4" aria-hidden /> : <XCircleIcon className="h-4 w-4" aria-hidden />}
        {t.ok ? 'Accepted by the SMTP server' : 'Not sent'}
      </p>
      <p className="mt-1 text-xs text-muted">
        {fmt(t.at, timezone)} ({timezone}) · to {t.recipient}
      </p>
      <p className="mt-1.5 break-words text-xs text-ink">{t.detail}</p>
    </div>
  );
}

/** Admin → Settings → Mail Box: outgoing SMTP for invitations, password resets and notices. */
export function MailBoxAdmin({ initial, timezone, adminEmail }: { initial: MailBoxViewDto; timezone: string; adminEmail: string }) {
  const [view, setView] = useState(initial);
  const [saved, setSaved] = useState(() => formFrom(initial));
  const [form, setForm] = useState(() => formFrom(initial));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [recipient, setRecipient] = useState(adminEmail);
  const [testError, setTestError] = useState<string | undefined>();
  const [testing, setTesting] = useState(false);

  const s = view.settings;
  const dirty = !sameForm(form, saved);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErrors({});
    const r = await request<MailBoxViewDto>('PUT', '/v1/admin/settings/mail', {
      revision: s.revision,
      body: {
        host: form.host,
        port: Number(form.port),
        security: form.security,
        username: form.username,
        password: form.password,
        clearPassword: form.clearPassword,
        senderName: form.senderName,
        senderEmail: form.senderEmail,
        replyTo: form.replyTo
      }
    });
    setSaving(false);
    if (!r.ok) {
      setErrors(issueMap(r.issues));
      toast.error(r.message);
      return;
    }
    setView(r.data);
    const next = formFrom(r.data);
    setSaved(next);
    setForm(next);
    toast.success('Mail settings saved');
  };

  const sendTest = async () => {
    setTesting(true);
    setTestError(undefined);
    const r = await request<MailTestResultDto>('POST', '/v1/admin/settings/mail/test', { body: { recipient } });
    setTesting(false);
    if (!r.ok) {
      setTestError(issueMap(r.issues).recipient ?? r.message);
      return;
    }
    setView((v) => ({ ...v, settings: { ...v.settings, lastTest: r.data } }));
    if (r.data.ok) toast.success('Test email accepted by the SMTP server');
    else toast.error('Test email was not sent', { description: r.data.detail });
  };

  return (
    <div className="space-y-5">
      {view.deliveryMode === 'capture' ? (
        <p className="rounded-xl border border-warn/35 bg-warn/5 p-3 text-sm text-warn" data-testid="mail-mode">
          <span className="font-semibold">Capture mode:</span> this environment stores outgoing emails in the local outbox and does not send them. Test emails below still use SMTP. Set <code>EMAIL_DELIVERY=smtp</code> to send invitations and resets.
        </p>
      ) : (
        <p className={`rounded-xl border p-3 text-sm ${s.configured ? 'border-gain/30 bg-gain/5 text-gain' : 'border-loss/35 bg-loss/5 text-loss'}`} data-testid="mail-mode">
          {s.configured ? (
            <>
              <span className="font-semibold">SMTP delivery is on.</span> Invitations, password resets and notices are sent with these settings.
            </>
          ) : (
            <>
              <span className="font-semibold">SMTP is not configured.</span> Invitations, password resets and notices cannot be delivered until you save the settings below.
            </>
          )}
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <form onSubmit={(e) => void save(e)} noValidate>
          <Card title="SMTP server" description="Use the settings from your email provider. The password is stored encrypted and is never shown again.">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
              <TextField label="SMTP host" value={form.host} onChange={(v) => set('host', v)} error={errors.host} placeholder="smtp.example.com" autoComplete="off" spellCheck={false} />
              <TextField label="Port" value={form.port} onChange={(v) => set('port', v.replace(/[^\d]/g, ''))} error={errors.port} inputMode="numeric" />
            </div>
            <div className="mt-4">
              <SegmentedControl<SmtpSecurity>
                label="Security"
                value={form.security}
                onChange={(v) => {
                  set('security', v);
                  if (form.port === '587' && v === 'TLS') set('port', '465');
                  if (form.port === '465' && v === 'STARTTLS') set('port', '587');
                }}
                options={[
                  { value: 'STARTTLS', label: 'STARTTLS' },
                  { value: 'TLS', label: 'Implicit TLS' }
                ]}
                hint="STARTTLS usually uses port 587; implicit TLS (SSL) usually uses port 465. Unencrypted SMTP is not offered."
                error={errors.security}
              />
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <TextField label="Username" value={form.username} onChange={(v) => set('username', v)} error={errors.username} autoComplete="off" spellCheck={false} />
              <TextField
                label="Password or app password"
                type="password"
                value={form.password}
                onChange={(v) => setForm((f) => ({ ...f, password: v, clearPassword: false }))}
                error={errors.password}
                autoComplete="new-password"
                placeholder={s.passwordConfigured && !form.clearPassword ? '•••••••• (unchanged)' : ''}
                hint={
                  <span className="flex flex-wrap items-center gap-2" data-testid="mail-password-state">
                    {form.clearPassword ? (
                      <StatusPill tone="warn">Will be removed on save</StatusPill>
                    ) : s.passwordConfigured ? (
                      <StatusPill tone="gain" icon={KeyRoundIcon}>
                        Password configured
                      </StatusPill>
                    ) : (
                      <StatusPill tone="neutral">No password stored</StatusPill>
                    )}
                    {s.passwordConfigured && <span>Leave empty to keep it.</span>}
                    {s.passwordConfigured && !form.clearPassword && (
                      <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={() => setForm((f) => ({ ...f, password: '', clearPassword: true }))}>
                        Remove
                      </button>
                    )}
                  </span>
                }
              />
            </div>
            <div className="mt-6 border-t border-line pt-4">
              <p className="text-sm font-semibold text-ink">Sender</p>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <TextField label="Sender name" value={form.senderName} onChange={(v) => set('senderName', v)} error={errors.senderName} />
                <TextField label="Sender email" type="email" value={form.senderEmail} onChange={(v) => set('senderEmail', v)} error={errors.senderEmail} placeholder="no-reply@example.com" />
                <TextField label="Reply-To (optional)" type="email" value={form.replyTo} onChange={(v) => set('replyTo', v)} error={errors.replyTo} placeholder="support@example.com" className="sm:col-span-2" />
              </div>
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button type="submit" variant="primary" icon={SaveIcon} loading={saving} disabled={!dirty && s.configured}>
                Save Settings
              </Button>
              {dirty && (
                <Button type="button" variant="ghost" onClick={() => { setForm(saved); setErrors({}); }}>
                  Discard changes
                </Button>
              )}
              <span className="text-xs text-subtle">{s.updatedAt ? `Last saved ${fmt(s.updatedAt, timezone)}` : 'Not saved yet'}</span>
            </div>
          </Card>
        </form>

        <div className="space-y-5">
          <Card title="Send Test Email" description="Sends one message with the saved settings and shows the SMTP server's reply.">
            <TextField label="Test recipient" type="email" value={recipient} onChange={setRecipient} error={testError} />
            <Button
              className="mt-3 w-full"
              variant="secondary"
              icon={SendIcon}
              loading={testing}
              disabled={!s.configured || dirty || !recipient.trim()}
              onClick={() => void sendTest()}
            >
              Send Test Email
            </Button>
            {(!s.configured || dirty) && <p className="mt-2 text-xs text-subtle">{s.configured ? 'Save your changes first; the test uses the saved settings.' : 'Save the settings first.'}</p>}
            <div className="mt-4">
              <p className="mb-2 text-xs font-medium text-muted">Last test</p>
              <TestResult t={s.lastTest} timezone={timezone} />
            </div>
          </Card>

          <Card title="Delivery" description="Outgoing invitations, password resets and notices.">
            <dl className="grid grid-cols-2 gap-2 text-sm" data-testid="mail-deliveries">
              <dt className="text-subtle">Sent</dt>
              <dd className="text-right tabular-nums text-ink">{view.deliveries.sent}</dd>
              <dt className="text-subtle">Queued</dt>
              <dd className="text-right tabular-nums text-ink">{view.deliveries.queued}</dd>
              <dt className="text-subtle">Failed</dt>
              <dd className={`text-right tabular-nums ${view.deliveries.failed ? 'font-semibold text-loss' : 'text-ink'}`}>{view.deliveries.failed}</dd>
              <dt className="text-subtle">Captured (not sent)</dt>
              <dd className="text-right tabular-nums text-ink">{view.deliveries.captured}</dd>
            </dl>
            {view.recentFailures.length > 0 && (
              <ul className="mt-4 space-y-2" data-testid="mail-failures">
                {view.recentFailures.map((f) => (
                  <li key={f.id} className="rounded-lg border border-loss/35 bg-loss/5 p-2.5 text-xs">
                    <p className="font-semibold text-loss">
                      {f.template} to {f.to}
                    </p>
                    <p className="text-subtle">{fmt(f.createdAt, timezone)}</p>
                    <p className="mt-1 break-words text-ink">{f.error}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
