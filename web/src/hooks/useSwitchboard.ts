import { useEffect, useState } from 'react';

import { api, openEventStream, type DirectoryEntry, type Snapshot } from '../lib/api';

/**
 * Live switchboard state.
 *
 * The WebSocket is the primary source; the initial REST fetch only fills the
 * gap before the first frame arrives, so the UI is never briefly empty.
 */
export function useSwitchboard(enabled: boolean) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    void api
      .state()
      .then((initial) => {
        // Do not clobber a live frame that arrived while this was in flight.
        if (!cancelled) setSnapshot((current) => current ?? initial);
      })
      .catch(() => undefined);

    void api
      .directory()
      .then((result) => {
        if (!cancelled) setDirectory(result.users);
      })
      .catch(() => undefined);

    const close = openEventStream((next) => {
      if (!cancelled) setSnapshot(next);
    });

    return () => {
      cancelled = true;
      close();
    };
  }, [enabled]);

  // Presence changes constantly; fold the live snapshot into the directory
  // rather than re-fetching it.
  const withPresence: DirectoryEntry[] = directory.map((entry) => {
    const live = snapshot?.extensions.find((e) => e.extension === entry.extension);
    return live
      ? { ...entry, status: live.status, onCall: live.channelIds.length > 0 }
      : entry;
  });

  return { snapshot, directory: withPresence };
}
