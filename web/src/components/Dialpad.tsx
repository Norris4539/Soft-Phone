import { useEffect, useRef, useState, type FormEvent } from 'react';

const KEYS = [
  ['1', ''],
  ['2', 'ABC'],
  ['3', 'DEF'],
  ['4', 'GHI'],
  ['5', 'JKL'],
  ['6', 'MNO'],
  ['7', 'PQRS'],
  ['8', 'TUV'],
  ['9', 'WXYZ'],
  ['*', ''],
  ['0', '+'],
  ['#', ''],
] as const;

interface Props {
  /** Called with the assembled number when the user places a call. */
  onDial: (destination: string) => void;
  /**
   * When set, keys send DTMF into the live call instead of building a number.
   * This is the in-call keypad — for IVRs, conference PINs and the like.
   */
  onTone?: (tone: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}

export function Dialpad({ onDial, onTone, disabled, autoFocus }: Props) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const inCall = Boolean(onTone);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  function press(key: string) {
    if (onTone) {
      onTone(key);
      // Show what was sent, so a long conference PIN is verifiable.
      setValue((current) => current + key);
      return;
    }
    setValue((current) => current + key);
    inputRef.current?.focus();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const destination = value.trim();
    if (!destination || disabled) return;
    onDial(destination);
    setValue('');
  }

  return (
    <form className="dialpad" onSubmit={submit}>
      <div className="dialpad__display">
        <input
          ref={inputRef}
          className="dialpad__input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // Typing into the field during a call should also send tones,
            // otherwise a keyboard user silently does nothing.
            if (onTone && /^[0-9*#]$/.test(e.key)) {
              e.preventDefault();
              press(e.key);
            }
          }}
          placeholder={inCall ? 'Keypad' : 'Extension or number'}
          inputMode="tel"
          aria-label={inCall ? 'Send tones' : 'Number to dial'}
          disabled={disabled}
        />
        {value && (
          <button
            type="button"
            className="dialpad__clear"
            onClick={() => setValue((v) => v.slice(0, -1))}
            aria-label="Delete last digit"
          >
            ⌫
          </button>
        )}
      </div>

      <div className="dialpad__keys">
        {KEYS.map(([key, letters]) => (
          <button
            key={key}
            type="button"
            className="dialpad__key"
            onClick={() => press(key)}
            disabled={disabled}
          >
            <span className="dialpad__digit">{key}</span>
            {letters && <span className="dialpad__letters">{letters}</span>}
          </button>
        ))}
      </div>

      {!inCall && (
        <button
          type="submit"
          className="button button--call button--block"
          disabled={disabled || value.trim().length === 0}
        >
          Call
        </button>
      )}
    </form>
  );
}
