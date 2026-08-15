import { useState, type FormEvent } from 'react';

import { api, storeToken, type PublicUser } from '../lib/api';
import { apiBase, isDemo, setApiBase } from '../lib/backend';

interface Props {
  onSignedIn: (user: PublicUser) => void;
}

export function Login({ onSignedIn }: Props) {
  const demo = isDemo();
  const [extension, setExtension] = useState(demo ? '100' : '');
  const [password, setPassword] = useState(demo ? 'demo' : '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showBackend, setShowBackend] = useState(false);
  const [backend, setBackend] = useState(apiBase());

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const { token, user } = await api.login(extension.trim(), password);
      storeToken(token);
      onSignedIn(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login__card" onSubmit={submit}>
        <h1 className="login__title">Switchboard</h1>
        <p className="login__subtitle">
          {demo ? 'Demo — any password works' : 'Sign in with your extension'}
        </p>

        {demo && (
          <p className="alert alert--warning login__demo">
            This is a UI demo with no phone system behind it. Calls are simulated
            and <strong>there is no audio</strong>. To drive a real PBX, add
            <code> ?api=https://your-server</code> to the URL.
          </p>
        )}

        <label className="field">
          <span className="field__label">Extension</span>
          <input
            className="field__input"
            value={extension}
            onChange={(e) => setExtension(e.target.value)}
            inputMode="numeric"
            autoComplete="username"
            placeholder="101"
            required
            autoFocus
          />
        </label>

        <label className="field">
          <span className="field__label">Password</span>
          <input
            className="field__input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        {error && (
          <p className="alert alert--error" role="alert">
            {error}
          </p>
        )}

        <button className="button button--primary button--block" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        {/*
          Only worth showing where it is actually needed: a static deployment
          has no /api to proxy and must be told which PBX it belongs to.
        */}
        {showBackend ? (
          <div className="login__backend">
            <label className="field">
              <span className="field__label">Control server</span>
              <input
                className="field__input"
                value={backend}
                onChange={(e) => setBackend(e.target.value)}
                placeholder="https://pbx.example.com"
                autoComplete="url"
              />
            </label>
            <button
              type="button"
              className="button button--block"
              onClick={() => {
                setApiBase(backend);
                // A full reload is the honest way to re-resolve the backend
                // and drop any demo state left in this tab.
                window.location.search = backend ? `?api=${encodeURIComponent(backend)}` : '';
              }}
            >
              Use this server
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="button button--quiet button--small login__backend-toggle"
            onClick={() => setShowBackend(true)}
          >
            {demo ? 'Connect to a real server' : 'Change server'}
          </button>
        )}
      </form>
    </div>
  );
}
