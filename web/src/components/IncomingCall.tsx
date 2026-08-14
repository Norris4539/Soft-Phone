import { useEffect, useRef } from 'react';

import type { CallView } from '../lib/phone';

interface Props {
  call: CallView;
  onAnswer: () => void;
  onReject: () => void;
}

/**
 * Ringing is generated rather than shipped as an audio file: one fewer asset,
 * and it cannot fail to load. Two tones at the North American cadence — one
 * second on, three off.
 */
function useRingtone(active: boolean): void {
  const contextRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    if (!active) return;

    // Constructing the AudioContext here (inside an effect triggered by an
    // inbound call) rather than at module load avoids a suspended context.
    const context = new AudioContext();
    contextRef.current = context;

    const gain = context.createGain();
    gain.gain.value = 0;
    gain.connect(context.destination);

    const oscillators = [440, 480].map((frequency) => {
      const oscillator = context.createOscillator();
      oscillator.frequency.value = frequency;
      oscillator.type = 'sine';
      oscillator.connect(gain);
      oscillator.start();
      return oscillator;
    });

    let stopped = false;

    const ring = () => {
      if (stopped) return;
      const now = context.currentTime;
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.setValueAtTime(0, now + 1);
    };

    ring();
    const interval = window.setInterval(ring, 4000);

    return () => {
      stopped = true;
      window.clearInterval(interval);
      for (const oscillator of oscillators) {
        try {
          oscillator.stop();
        } catch {
          // Already stopped; nothing to do.
        }
      }
      void context.close();
    };
  }, [active]);
}

export function IncomingCall({ call, onAnswer, onReject }: Props) {
  useRingtone(true);

  useEffect(() => {
    // A ringing tab is easy to miss behind a browser window.
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      const notification = new Notification('Incoming call', {
        body: call.remoteName || call.remoteNumber,
        tag: call.id,
      });
      return () => notification.close();
    }
    return undefined;
  }, [call.id, call.remoteName, call.remoteNumber]);

  return (
    <div className="incoming" role="dialog" aria-label="Incoming call">
      <div className="incoming__card">
        <p className="incoming__label">Incoming call</p>
        <h2 className="incoming__party">{call.remoteName || call.remoteNumber}</h2>
        {call.remoteName && <p className="incoming__number">{call.remoteNumber}</p>}

        <div className="incoming__actions">
          <button className="button button--call" onClick={onAnswer}>
            Answer
          </button>
          <button className="button button--hangup" onClick={onReject}>
            Decline
          </button>
        </div>
      </div>
    </div>
  );
}
