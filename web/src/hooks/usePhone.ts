import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, type PhoneConfigResponse } from '../lib/api';
import { Phone, type PhoneState } from '../lib/phone';

const EMPTY: PhoneState = { registration: 'unregistered', calls: [] };

/**
 * Owns the single Phone instance for the session and mirrors its state into
 * React. The Phone is created once per mount and torn down on sign-out —
 * recreating it on every render would drop live calls.
 */
export function usePhone(enabled: boolean) {
  const phoneRef = useRef<Phone | null>(null);
  if (phoneRef.current === null) phoneRef.current = new Phone();
  const phone = phoneRef.current;

  const [state, setState] = useState<PhoneState>(EMPTY);
  const [config, setConfig] = useState<PhoneConfigResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => phone.subscribe(setState), [phone]);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    void (async () => {
      try {
        const loaded = await api.phoneConfig();
        if (cancelled) return;
        setConfig(loaded);

        await phone.connect({
          websocketUrl: loaded.sip.websocketUrl,
          domain: loaded.sip.domain,
          username: loaded.sip.username,
          password: loaded.sip.password,
          displayName: loaded.sip.displayName,
          iceServers: loaded.ice.iceServers,
        });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      void phone.disconnect();
    };
  }, [enabled, phone]);

  const actions = useMemo(
    () => ({
      call: (destination: string) => phone.call(destination),
      answer: (id: string) => phone.answer(id),
      reject: (id: string) => phone.reject(id),
      hangup: (id: string) => phone.hangup(id),
      setMuted: (id: string, muted: boolean) => phone.setMuted(id, muted),
      setHold: (id: string, held: boolean) => phone.setHold(id, held),
      sendDtmf: (id: string, tone: string) => phone.sendDtmf(id, tone),
      blindTransfer: (id: string, to: string) => phone.blindTransfer(id, to),
      startAttendedTransfer: (id: string, to: string) => phone.startAttendedTransfer(id, to),
      completeAttendedTransfer: () => phone.completeAttendedTransfer(),
      cancelAttendedTransfer: () => phone.cancelAttendedTransfer(),
    }),
    [phone],
  );

  const dismissError = useCallback(() => setError(null), []);

  return { state, config, error, dismissError, actions };
}
