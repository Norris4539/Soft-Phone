import { useMemo, useState } from 'react';

import type { DirectoryEntry } from '../lib/api';

interface Props {
  entries: DirectoryEntry[];
  /** Hide the signed-in user; calling yourself is never the intent. */
  selfExtension: string;
  onCall: (extension: string) => void;
  disabled: boolean;
}

const STATUS_LABEL: Record<DirectoryEntry['status'], string> = {
  available: 'Available',
  ringing: 'Ringing',
  busy: 'On a call',
  onhold: 'On hold',
  offline: 'Offline',
  unknown: 'Unknown',
};

export function Directory({ entries, selfExtension, onCall, disabled }: Props) {
  const [filter, setFilter] = useState('');

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return entries
      .filter((entry) => entry.extension !== selfExtension)
      .filter(
        (entry) =>
          !needle ||
          entry.name.toLowerCase().includes(needle) ||
          entry.extension.includes(needle),
      )
      .sort((a, b) => a.extension.localeCompare(b.extension));
  }, [entries, filter, selfExtension]);

  return (
    <section className="directory">
      <header className="directory__header">
        <h2 className="panel__title">Directory</h2>
        <input
          className="directory__search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search"
          aria-label="Search the directory"
        />
      </header>

      {visible.length === 0 ? (
        <p className="empty">No matching extensions.</p>
      ) : (
        <ul className="directory__list">
          {visible.map((entry) => (
            <li key={entry.extension} className="directory__item">
              <span className={`status-dot status-dot--${entry.status}`} aria-hidden="true" />
              <div className="directory__identity">
                <span className="directory__name">{entry.name}</span>
                <span className="directory__meta">
                  {entry.extension} · {STATUS_LABEL[entry.status]}
                </span>
              </div>
              <button
                className="button button--small"
                onClick={() => onCall(entry.extension)}
                disabled={disabled || entry.status === 'offline'}
                title={entry.status === 'offline' ? 'This extension is not signed in' : undefined}
              >
                Call
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
