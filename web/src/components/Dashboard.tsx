import { useState } from 'react';

import { api, type ActiveCall, type Snapshot, type TrackedChannel } from '../lib/api';

interface Props {
  snapshot: Snapshot | null;
  directory: { extension: string; name: string }[];
  /** Only an admin sees other people's calls, and only an admin may act. */
  canControl: boolean;
}

function seconds(since: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(since).getTime()) / 1000));
}

function duration(since: string): string {
  const total = seconds(since);
  const minutes = String(Math.floor(total / 60)).padStart(2, '0');
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

function describeParty(channel: TrackedChannel, names: Map<string, string>): string {
  if (!channel.external) {
    return names.get(channel.endpoint) ?? `Extension ${channel.endpoint}`;
  }
  return channel.callerName || channel.callerNumber || 'Outside line';
}

function describeCall(call: ActiveCall, names: Map<string, string>): string {
  if (call.channels.length >= 2) {
    return call.channels.map((channel) => describeParty(channel, names)).join('  ↔  ');
  }
  const only = call.channels[0];
  if (!only) return 'Call';
  const where = only.exten ? ` → ${only.exten}` : '';
  return `${describeParty(only, names)}${where}`;
}

export function Dashboard({ snapshot, directory, canControl }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transferTarget, setTransferTarget] = useState<Record<string, string>>({});

  const names = new Map(directory.map((entry) => [entry.extension, entry.name]));

  async function act(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (!snapshot) {
    return <p className="empty">Connecting to the switchboard…</p>;
  }

  const degraded = !snapshot.sources.ari || !snapshot.sources.ami;

  return (
    <div className="dashboard">
      {degraded && (
        <p className="alert alert--warning">
          Partial view: {!snapshot.sources.ari && 'channel events'}
          {!snapshot.sources.ari && !snapshot.sources.ami && ' and '}
          {!snapshot.sources.ami && 'queue state'} unavailable. Reconnecting to Asterisk.
        </p>
      )}
      {error && <p className="alert alert--error">{error}</p>}

      <section className="panel">
        <h2 className="panel__title">
          Active calls <span className="panel__count">{snapshot.calls.length}</span>
        </h2>

        {snapshot.calls.length === 0 ? (
          <p className="empty">No calls in progress.</p>
        ) : (
          <ul className="calls">
            {snapshot.calls.map((call) => (
              <li key={call.id} className="calls__item">
                <div className="calls__main">
                  <span className="calls__parties">{describeCall(call, names)}</span>
                  <span className="calls__meta">
                    {call.bridged ? 'connected' : 'ringing'} · {duration(call.startedAt)}
                  </span>
                </div>

                {canControl && (
                  <div className="calls__actions">
                    <input
                      className="calls__transfer-input"
                      placeholder="Ext"
                      inputMode="numeric"
                      value={transferTarget[call.id] ?? ''}
                      onChange={(e) =>
                        setTransferTarget((current) => ({ ...current, [call.id]: e.target.value }))
                      }
                      aria-label={`Transfer ${describeCall(call, names)} to extension`}
                    />
                    <button
                      className="button button--small"
                      disabled={busy !== null || !(transferTarget[call.id] ?? '').trim()}
                      onClick={() => {
                        // Transfer the outside leg, not the extension's own
                        // channel — moving the wrong one drops the caller.
                        const leg =
                          call.channels.find((channel) => channel.external) ?? call.channels[0];
                        if (!leg) return;
                        void act(call.id, () =>
                          api.transferChannel(leg.id, (transferTarget[call.id] ?? '').trim()),
                        );
                      }}
                    >
                      Transfer
                    </button>
                    <button
                      className="button button--small button--danger"
                      disabled={busy !== null}
                      onClick={() => {
                        const leg = call.channels[0];
                        if (leg) void act(call.id, () => api.hangupChannel(leg.id));
                      }}
                    >
                      End
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2 className="panel__title">Queues</h2>

        {snapshot.queues.length === 0 ? (
          <p className="empty">No queues configured.</p>
        ) : (
          <ul className="queues">
            {snapshot.queues.map((queue) => (
              <li key={queue.name} className="queues__item">
                <header className="queues__header">
                  <h3 className="queues__name">{queue.name}</h3>
                  <span className="queues__stats">
                    {queue.callers.length} waiting · {queue.members.filter((m) => !m.paused).length}
                    /{queue.members.length} agents on
                  </span>
                </header>

                {queue.callers.length > 0 && (
                  <ol className="queues__callers">
                    {queue.callers.map((caller) => (
                      <li key={caller.channelId}>
                        <span className="queues__position">#{caller.position}</span>
                        {caller.callerName || caller.callerNumber || 'Caller'}
                        <span className="queues__wait">
                          waiting {Math.floor(caller.waitSeconds / 60)}m{' '}
                          {caller.waitSeconds % 60}s
                        </span>
                      </li>
                    ))}
                  </ol>
                )}

                <ul className="queues__members">
                  {queue.members.map((member) => (
                    <li key={member.extension} className="queues__member">
                      <span className={`status-dot status-dot--${member.paused ? 'offline' : member.status}`} />
                      <span className="queues__member-name">
                        {names.get(member.extension) ?? member.name}
                      </span>
                      <span className="queues__member-meta">
                        {member.paused ? 'paused' : member.status} · {member.callsTaken} taken
                      </span>
                      {canControl && (
                        <button
                          className="button button--small"
                          disabled={busy !== null}
                          onClick={() =>
                            void act(`${queue.name}:${member.extension}`, () =>
                              api.setQueuePause(queue.name, member.extension, !member.paused),
                            )
                          }
                        >
                          {member.paused ? 'Resume' : 'Pause'}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2 className="panel__title">Extensions</h2>
        <ul className="extensions">
          {snapshot.extensions.map((extension) => (
            <li key={extension.extension} className="extensions__item">
              <span className={`status-dot status-dot--${extension.status}`} />
              <span className="extensions__name">{extension.name}</span>
              <span className="extensions__number">{extension.extension}</span>
              <span className="extensions__status">{extension.status}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
