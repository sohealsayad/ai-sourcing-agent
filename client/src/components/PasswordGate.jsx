import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, AUTH_REQUIRED_EVENT, getPassword, setPassword } from '../api.js';
import { Icon, Spinner } from './ui.jsx';

/**
 * Shows a password screen when the server has APP_PASSWORD set (a deployed app), and the app otherwise.
 * Locally, with no password configured, the check passes at once and nothing is shown.
 */
export default function PasswordGate({ children }) {
  const queryClient = useQueryClient();
  // checking → locked | open
  const [state, setState] = useState('checking');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .checkPassword(getPassword())
      .then(() => setState('open'))
      // A server that is down is reported by the pages themselves; only a 401 locks the app.
      .catch((err) => setState(err.status === 401 ? 'locked' : 'open'));
    const lock = () => setState('locked');
    window.addEventListener(AUTH_REQUIRED_EVENT, lock);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, lock);
  }, []);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.checkPassword(value);
      setPassword(value);
      setValue('');
      setState('open');
      queryClient.invalidateQueries();
    } catch (err) {
      setError(err.status === 401 ? 'Wrong password.' : err.message);
    } finally {
      setBusy(false);
    }
  }

  if (state === 'open') return children;
  if (state === 'checking') {
    return (
      <div className="grid min-h-screen place-items-center text-slate-400">
        <Spinner className="size-6" />
      </div>
    );
  }

  return (
    <div className="grid min-h-screen place-items-center bg-slate-50 px-4">
      <form onSubmit={submit} className="card w-full max-w-sm p-7">
        <div className="mb-5 flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-lg bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-sm">
            <Icon name="layers" className="size-4" />
          </span>
          <div>
            <h1 className="text-[15px] font-semibold text-slate-900">Sourcing Desk</h1>
            <p className="text-xs text-slate-500">AI procurement workflow</p>
          </div>
        </div>
        <label htmlFor="app-password" className="field-label">
          Password
        </label>
        <input
          id="app-password"
          type="password"
          className="field-input"
          autoComplete="current-password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={error ? 'true' : undefined}
        />
        {error ? <p className="field-error">{error}</p> : <p className="field-hint">Ask the owner of this demo for the password.</p>}
        <button type="submit" className="btn-primary mt-5 w-full justify-center" disabled={busy || !value}>
          {busy && <Spinner />}
          {busy ? 'Checking…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
