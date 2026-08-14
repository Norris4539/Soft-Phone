import { useEffect, useState } from 'react';

import type { CallView } from '../lib/phone';
import { Dialpad } from './Dialpad';
import { TransferControls } from './TransferControls';

interface Props {
  call: CallView;
  /** Every other extension, for the transfer picker. */
  directory: { extension: string; name: string; status: string }[];
  pendingTransfer: boolean;
  onHangup: () => void;
  onMute: (muted: boolean) => void;
  onHold: (held: boolean) => void;
  onTone: (tone: string) => void;
  onBlindTransfer: (extension: string) => void;
  onAttendedTransfer: (extension: string) => void;
  onCompleteTransfer: () => void;
  onCancelTransfer: () => void;
}

/** Ticking duration, so the user can see how long they have been talking. */
function useElapsed(since: number | undefined): string {
  const [, force] = useState(0);

  useEffect(() => {
    if (since === undefined) return;
    const timer = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [since]);

  if (since === undefined) return '';
  const total = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, '0');
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

const STATUS_LABEL: Record<CallView['status'], string> = {
  ringing: 'Incoming call',
  connecting: 'Calling…',
  active: 'In call',
  held: 'On hold',
  ended: 'Ended',
};

export function CallPanel({
  call,
  directory,
  pendingTransfer,
  onHangup,
  onMute,
  onHold,
  onTone,
  onBlindTransfer,
  onAttendedTransfer,
  onCompleteTransfer,
  onCancelTransfer,
}: Props) {
  const [keypadOpen, setKeypadOpen] = useState(false);
  const elapsed = useElapsed(call.answeredAt);
  const established = call.status === 'active' || call.status === 'held';

  return (
    <section className={`call-panel call-panel--${call.status}`}>
      <header className="call-panel__header">
        <div>
          <p className="call-panel__status">
            {STATUS_LABEL[call.status]}
            {call.consultation && ' · consultation'}
          </p>
          <h2 className="call-panel__party">{call.remoteName || call.remoteNumber}</h2>
          {call.remoteName && <p className="call-panel__number">{call.remoteNumber}</p>}
        </div>
        {elapsed && <span className="call-panel__timer">{elapsed}</span>}
      </header>

      {established && (
        <div className="call-panel__controls">
          <button
            className={`control ${call.muted ? 'control--on' : ''}`}
            onClick={() => onMute(!call.muted)}
            aria-pressed={call.muted}
          >
            {call.muted ? 'Unmute' : 'Mute'}
          </button>
          <button
            className={`control ${call.status === 'held' ? 'control--on' : ''}`}
            onClick={() => onHold(call.status !== 'held')}
            aria-pressed={call.status === 'held'}
          >
            {call.status === 'held' ? 'Resume' : 'Hold'}
          </button>
          <button
            className={`control ${keypadOpen ? 'control--on' : ''}`}
            onClick={() => setKeypadOpen((open) => !open)}
            aria-pressed={keypadOpen}
          >
            Keypad
          </button>
        </div>
      )}

      {keypadOpen && established && (
        <div className="call-panel__keypad">
          <Dialpad onDial={() => undefined} onTone={onTone} />
        </div>
      )}

      {established && !call.consultation && (
        <TransferControls
          directory={directory}
          pendingTransfer={pendingTransfer}
          onBlind={onBlindTransfer}
          onAttended={onAttendedTransfer}
          onComplete={onCompleteTransfer}
          onCancel={onCancelTransfer}
        />
      )}

      <button className="button button--hangup button--block" onClick={onHangup}>
        {call.status === 'connecting' ? 'Cancel' : 'Hang up'}
      </button>
    </section>
  );
}
