import { useState } from 'react';
import { Button } from './ui.jsx';
import { api } from './api.js';

// Magic-link sign-in (US-021), shown only when the server is in multi-user mode
// and the visitor has no session yet — App gates on `auth_mode === 'multi'`, so
// self-host without auth never reaches here and looks exactly as before.
//
// Two states: the email form, and the "check your email" confirmation. There is
// deliberately no password and no signup step — a first login creates the
// account, so the same form covers both.
export default function Login({ invalid }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/request-link', { method: 'POST', body: { email: email.trim() } });
      setSent(true);
    } catch (err) {
      setError(err.message || 'Something went wrong — try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-brand">QAssist</div>
        {sent ? (
          <div className="auth-body">
            <p className="auth-lead">Check your email</p>
            <p className="auth-sub">
              A sign-in link is on its way to <strong>{email.trim()}</strong>. It works once and
              expires in 15 minutes.
            </p>
            <Button variant="ghost" size="sm" onClick={() => setSent(false)}>
              Use a different email
            </Button>
          </div>
        ) : (
          <form className="auth-body" onSubmit={submit}>
            <p className="auth-lead">Sign in</p>
            <p className="auth-sub">Enter your email and we&rsquo;ll send you a link — no password.</p>
            {(error || invalid) && (
              <p className="auth-error" role="alert">
                {error || 'That sign-in link is invalid or has expired. Request a new one.'}
              </p>
            )}
            <input
              type="email"
              autoFocus
              required
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Button
              type="submit"
              variant="primary"
              className="btn-block"
              disabled={busy || !email.trim()}
            >
              {busy ? 'Sending…' : 'Send sign-in link'}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
