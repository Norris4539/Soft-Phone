import { useState } from 'react';

interface Props {
  directory: { extension: string; name: string; status: string }[];
  /** True once a consultation leg exists and is waiting to be completed. */
  pendingTransfer: boolean;
  onBlind: (extension: string) => void;
  onAttended: (extension: string) => void;
  onComplete: () => void;
  onCancel: () => void;
}

/**
 * Both transfer flavours, because they mean different things:
 *
 *   Blind     — hand the call over and drop out immediately. Fast, but the
 *               destination gets no warning and no chance to decline.
 *   Attended  — hold the caller, speak to the destination first, then join
 *               them. This is what a switchboard operator does by default.
 */
export function TransferControls({
  directory,
  pendingTransfer,
  onBlind,
  onAttended,
  onComplete,
  onCancel,
}: Props) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('');

  if (pendingTransfer) {
    return (
      <div className="transfer transfer--pending">
        <p className="transfer__hint">
          Announcing the call. Complete the transfer once they have agreed to take it.
        </p>
        <div className="transfer__actions">
          <button className="button button--primary" onClick={onComplete}>
            Complete transfer
          </button>
          <button className="button" onClick={onCancel}>
            Back to caller
          </button>
        </div>
      </div>
    );
  }

  if (!open) {
    return (
      <button className="control control--wide" onClick={() => setOpen(true)}>
        Transfer
      </button>
    );
  }

  const chosen = target.trim();

  return (
    <div className="transfer">
      <label className="field">
        <span className="field__label">Transfer to</span>
        <input
          className="field__input"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="Extension or number"
          inputMode="tel"
          list="transfer-targets"
          autoFocus
        />
      </label>

      <datalist id="transfer-targets">
        {directory.map((entry) => (
          <option key={entry.extension} value={entry.extension}>
            {entry.name} — {entry.status}
          </option>
        ))}
      </datalist>

      <div className="transfer__actions">
        <button
          className="button button--primary"
          disabled={!chosen}
          onClick={() => {
            onAttended(chosen);
            setOpen(false);
            setTarget('');
          }}
        >
          Ask first
        </button>
        <button
          className="button"
          disabled={!chosen}
          onClick={() => {
            onBlind(chosen);
            setOpen(false);
            setTarget('');
          }}
        >
          Send now
        </button>
        <button className="button button--quiet" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
