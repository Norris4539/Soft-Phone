import { useCallback, useEffect, useState } from 'react';

import { CallPanel } from './components/CallPanel';
import { Dashboard } from './components/Dashboard';
import { Dialpad } from './components/Dialpad';
import { Directory } from './components/Directory';
import { IncomingCall } from './components/IncomingCall';
import { Login } from './components/Login';
import { usePhone } from './hooks/usePhone';
import { useSwitchboard } from './hooks/useSwitchboard';
import { api, clearToken, storedToken, type PublicUser } from './lib/api';
import { isDemo } from './lib/backend';

type Tab = 'phone' | 'switchboard';

const REGISTRATION_LABEL = {
  unregistered: 'Offline',
  registering: 'Connecting…',
  registered: 'Ready',
  failed: 'Not connected',
} as const;

export function App() {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [tab, setTab] = useState<Tab>('phone');

  // A stored token survives a page reload; verify it rather than trusting it,
  // so a revoked account does not get a half-working UI.
  useEffect(() => {
    if (!storedToken()) {
      setCheckingSession(false);
      return;
    }
    void api
      .me()
      .then(({ user: me }) => setUser(me))
      .catch(() => clearToken())
      .finally(() => setCheckingSession(false));
  }, []);

  const signedIn = user !== null;
  const { state, error, dismissError, actions } = usePhone(signedIn);
  const { snapshot, directory } = useSwitchboard(signedIn);

  const signOut = useCallback(() => {
    clearToken();
    setUser(null);
  }, []);

  // Ask for notification permission once the user is in, not on page load —
  // an unprompted permission dialog on a login screen is hostile.
  useEffect(() => {
    if (signedIn && 'Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
  }, [signedIn]);

  if (checkingSession) {
    return <div className="loading">Loading…</div>;
  }

  if (!user) {
    return <Login onSignedIn={setUser} />;
  }

  const ringing = state.calls.find((call) => call.status === 'ringing');
  // The consultation leg takes the foreground while an attended transfer is
  // being set up; otherwise show whichever call is not on hold.
  const foreground =
    state.calls.find((call) => call.consultation && call.status !== 'ringing') ??
    state.calls.find((call) => call.status === 'active') ??
    state.calls.find((call) => call.status === 'connecting') ??
    state.calls.find((call) => call.status === 'held');

  const background = state.calls.filter((call) => call !== foreground && call !== ringing);
  const canDial = state.registration === 'registered';

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__identity">
          <span className="topbar__name">{user.name}</span>
          <span className="topbar__extension">Ext {user.extension}</span>
        </div>

        <nav className="topbar__tabs">
          <button
            className={`tab ${tab === 'phone' ? 'tab--active' : ''}`}
            onClick={() => setTab('phone')}
          >
            Phone
          </button>
          <button
            className={`tab ${tab === 'switchboard' ? 'tab--active' : ''}`}
            onClick={() => setTab('switchboard')}
          >
            Switchboard
          </button>
        </nav>

        <div className="topbar__right">
          <span className={`registration registration--${state.registration}`}>
            {REGISTRATION_LABEL[state.registration]}
          </span>
          <button className="button button--quiet button--small" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      {isDemo() && (
        <p className="alert alert--warning" role="status">
          <strong>Demo mode.</strong> Calls are simulated and there is no audio —
          this is the real interface with no phone system behind it. Sign out and
          choose “Connect to a real server” to point it at a PBX.
        </p>
      )}

      {state.registrationError && (
        <p className="alert alert--error" role="alert">
          {state.registrationError}
        </p>
      )}
      {state.microphoneError && (
        <p className="alert alert--warning" role="alert">
          {state.microphoneError}
        </p>
      )}
      {error && (
        <p className="alert alert--error" role="alert">
          {error}{' '}
          <button className="button button--quiet button--small" onClick={dismissError}>
            Dismiss
          </button>
        </p>
      )}

      {ringing && (
        <IncomingCall
          call={ringing}
          onAnswer={() => void actions.answer(ringing.id)}
          onReject={() => void actions.reject(ringing.id)}
        />
      )}

      <main className="content">
        {tab === 'phone' ? (
          <div className="phone-layout">
            <div className="phone-layout__main">
              {foreground ? (
                <CallPanel
                  call={foreground}
                  directory={directory}
                  pendingTransfer={Boolean(state.pendingTransfer)}
                  onHangup={() => void actions.hangup(foreground.id)}
                  onMute={(muted) => actions.setMuted(foreground.id, muted)}
                  onHold={(held) => void actions.setHold(foreground.id, held)}
                  onTone={(tone) => actions.sendDtmf(foreground.id, tone)}
                  onBlindTransfer={(to) => void actions.blindTransfer(foreground.id, to)}
                  onAttendedTransfer={(to) =>
                    void actions.startAttendedTransfer(foreground.id, to)
                  }
                  onCompleteTransfer={() => void actions.completeAttendedTransfer()}
                  onCancelTransfer={() => void actions.cancelAttendedTransfer()}
                />
              ) : (
                <Dialpad onDial={(destination) => void actions.call(destination)} disabled={!canDial} autoFocus />
              )}

              {background.length > 0 && (
                <section className="held-calls">
                  <h2 className="panel__title">Also on the line</h2>
                  <ul className="held-calls__list">
                    {background.map((call) => (
                      <li key={call.id} className="held-calls__item">
                        <span>{call.remoteName || call.remoteNumber}</span>
                        <span className="held-calls__status">{call.status}</span>
                        <button
                          className="button button--small"
                          onClick={() => void actions.setHold(call.id, false)}
                        >
                          Resume
                        </button>
                        <button
                          className="button button--small button--danger"
                          onClick={() => void actions.hangup(call.id)}
                        >
                          End
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>

            <aside className="phone-layout__side">
              <Directory
                entries={directory}
                selfExtension={user.extension}
                onCall={(extension) => void actions.call(extension)}
                disabled={!canDial}
              />
            </aside>
          </div>
        ) : (
          <Dashboard snapshot={snapshot} directory={directory} canControl={user.role === 'admin'} />
        )}
      </main>
    </div>
  );
}
