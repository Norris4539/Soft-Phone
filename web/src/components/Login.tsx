import { useState, type FormEvent } from 'react';

import { api, storeToken, type PublicUser } from '../lib/api';

interface Props {
  onSignedIn: (user: PublicUser) => void;
}

export function Login({ onSignedIn }: Props) {
  const [extension, setExtension] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
        <p className="login__subtitle">Sign in with your extension</p>

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
      </form>
    </div>
  );
}
