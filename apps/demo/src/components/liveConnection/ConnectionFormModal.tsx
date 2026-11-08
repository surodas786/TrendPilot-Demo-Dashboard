import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2Icon, FlaskConicalIcon, WandSparklesIcon, XCircleIcon } from 'lucide-react';
import { toast } from 'sonner';
import { usePlatform } from '../../contexts/PlatformContext';
import { simNow, formatClock } from '../../utils/clock';
import { DEMO_NOTE, maskKey, OUTCOME_LABELS, sampleCredentials, TEST_MESSAGES } from '../../utils/liveConnection';
import { PasswordField } from '../account/PasswordField';
import { Button } from '../ui/Button';
import { FilterSelect } from '../ui/FilterSelect';
import { Modal } from '../ui/Modal';
import { ModalHeader } from '../ui/ModalHeader';
import { TextField } from '../ui/TextField';
import type { ConnectionTestOutcome, ExchangeConnectionMeta } from '../../types/platform';

export type FormMode = 'add' | 'edit' | 'reconnect';

interface Props {
  mode: FormMode | null;
  subscriberId: string;
  existing?: ExchangeConnectionMeta;
  onClose: () => void;
}

export function ConnectionFormModal({ mode, subscriberId, existing, onClose }: Props) {
  return (
    <Modal open={mode !== null} onClose={onClose} labelledBy="conn-form-title">
      {mode && <ConnectionForm key={`${mode}-${subscriberId}`} mode={mode} subscriberId={subscriberId} existing={existing} onClose={onClose} />}
    </Modal>);

}

const TEST_MS = 900;

/** Typed credentials live only in this component's state and are discarded on close or save. */
function ConnectionForm({ mode, subscriberId, existing, onClose }: Props & {mode: FormMode;}) {
  const { saveConnection, renameConnection } = usePlatform();
  const [name, setName] = useState(existing?.name ?? 'My MEXC Futures');
  const [key, setKey] = useState('');
  const [secret, setSecret] = useState('');
  const [replacing, setReplacing] = useState(mode !== 'edit');
  const [outcome, setOutcome] = useState<ConnectionTestOutcome>('success');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{outcome: ConnectionTestOutcome;at: number;} | null>(null);
  const [touched, setTouched] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  const credsNeeded = replacing;
  const nameError = !name.trim() ? 'Enter a connection name.' : undefined;
  const keyError = credsNeeded && !key.trim() ? 'Enter a demo API key.' : undefined;
  const secretError = credsNeeded && !secret.trim() ? 'Enter a demo API secret.' : undefined;
  const passed = result?.outcome === 'success';
  const canSave = !nameError && (!credsNeeded || !keyError && !secretError && passed);

  // Any credential edit invalidates a previous test result.
  const editKey = (v: string) => {
    setKey(v);
    setResult(null);
  };
  const editSecret = (v: string) => {
    setSecret(v);
    setResult(null);
  };

  const runTest = () => {
    setTouched(true);
    if (!key.trim() || !secret.trim()) return;
    setTesting(true);
    setResult(null);
    const chosen = outcome;
    timer.current = window.setTimeout(() => {
      setTesting(false);
      setResult({ outcome: chosen, at: simNow() });
    }, TEST_MS);
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!canSave) return;
    if (!credsNeeded && existing) {
      renameConnection(subscriberId, name.trim());
      toast.success('Connection name saved');
    } else if (result) {
      saveConnection({
        id: existing?.id ?? `conn-${subscriberId}-${result.at.toString(36)}`,
        subscriberId,
        name: name.trim(),
        exchange: 'mexc-futures',
        maskedKey: maskKey(key),
        status: 'connected',
        lastTestAt: result.at,
        createdAt: existing?.createdAt ?? result.at
      });
      toast.success(mode === 'reconnect' ? 'Reconnected — simulated' : 'Connected — simulated');
    }
    setKey('');
    setSecret('');
    onClose();
  };

  const title = mode === 'add' ? 'Add Exchange Connection' : mode === 'reconnect' ? 'Reconnect exchange' : 'Edit connection';

  return (
    <form onSubmit={save} noValidate autoComplete="off" className="flex min-h-0 flex-col">
      <ModalHeader id="conn-form-title" title={title} description="In the production platform, each subscriber connects their own exchange account." onClose={onClose} />
      <div className="scrollbar-thin space-y-4 overflow-y-auto px-5 py-5 sm:px-6">
        <p className="rounded-lg border border-warn/35 bg-warn/10 px-3 py-2 text-xs text-warn">{DEMO_NOTE}</p>
        <TextField label="Connection name" value={name} onChange={setName} error={touched ? nameError : undefined} />
        <TextField label="Exchange" value="MEXC Futures" readOnly />

        {mode === 'edit' && existing &&
        <div className="rounded-lg border border-line bg-inset p-3 text-sm">
            <p className="text-xs text-subtle">Current demo API key</p>
            <p className="mt-0.5 font-mono text-ink">{existing.maskedKey}</p>
            {!replacing ?
          <button type="button" onClick={() => setReplacing(true)} className="mt-2 text-xs font-semibold text-accent hover:underline">
                Replace credentials
              </button> :

          <button
            type="button"
            onClick={() => {
              setReplacing(false);
              setKey('');
              setSecret('');
              setResult(null);
            }}
            className="mt-2 text-xs font-semibold text-muted hover:text-ink">
            
                Keep current credentials
              </button>
          }
          </div>
        }

        {replacing &&
        <>
            <div className="flex items-end justify-between gap-2">
              <p className="text-sm font-medium text-ink">{mode === 'add' ? 'Demo credentials' : 'Replacement demo credentials'}</p>
              <Button
              size="sm"
              icon={WandSparklesIcon}
              onClick={() => {
                const c = sampleCredentials();
                setKey(c.key);
                setSecret(c.secret);
                setResult(null);
              }}>
              
                Use Sample Credentials
              </Button>
            </div>
            <TextField label="Demo API key" value={key} onChange={editKey} spellCheck={false} autoComplete="off" error={touched ? keyError : undefined} />
            <PasswordField label="Demo API secret" value={secret} onChange={editSecret} autoComplete="new-password" error={touched ? secretError : undefined} />
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <FilterSelect label="Demo test outcome" value={outcome} onChange={(v) => setOutcome(v as ConnectionTestOutcome)} options={(Object.keys(OUTCOME_LABELS) as ConnectionTestOutcome[]).map((o) => ({ value: o, label: OUTCOME_LABELS[o] }))} />
              <Button icon={FlaskConicalIcon} onClick={runTest} loading={testing}>
                {testing ? 'Testing…' : 'Test Connection'}
              </Button>
            </div>
            <div role="status" aria-live="polite">
              {result &&
            <p className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${passed ? 'border-gain/30 bg-gain/10 text-gain' : 'border-loss/35 bg-loss/10 text-loss'}`}>
                  {passed ? <CheckCircle2Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <XCircleIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
                  <span>
                    {TEST_MESSAGES[result.outcome]} <span className="text-xs opacity-80">· {formatClock(result.at)}</span>
                  </span>
                </p>
            }
              {!result && !testing && touched && key.trim() && secret.trim() && <p className="text-xs text-subtle">Run a successful demo test before saving.</p>}
            </div>
            <p className="text-xs text-subtle">The demo test does not contact MEXC or verify real exchange permissions.</p>
          </>
        }
      </div>
      <footer className="flex flex-col-reverse gap-2 border-t border-line px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!canSave || testing}>
          Save
        </Button>
      </footer>
    </form>);

}