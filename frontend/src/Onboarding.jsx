import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Check } from 'lucide-react';
import { Button } from './ui.jsx';
import { api } from './api.js';
import { startCheckout } from './Billing.jsx';
import OpenaiKey from './OpenaiKey.jsx';

// Forced onboarding (US-053): on a billing instance the app is behind this
// checklist until the account can actually run something — a stored OpenAI key
// (runs are funded by it and nothing else, US-039) and a subscription. The demo
// sandbox is where the product is tried, so meeting it here as a refused run
// was only ever the worse introduction.
//
// Nothing is persisted: every step reads server state, so "done" cannot drift
// from true and there is no flag to reset. App decides when to render this at
// all — self-hosted instances (no `health.billing`) never do.

const CONFIRM_TRIES = 15;
const CONFIRM_INTERVAL_MS = 2000;

/** One row of the checklist. `state` drives both the marker and the affordance. */
function Step({ index, title, state, children }) {
  return (
    <li className={`onboard-step is-${state}`}>
      <span className="onboard-mark" aria-hidden="true">
        {state === 'done' ? <Check size={13} strokeWidth={2.5} /> : index}
      </span>
      <div className="onboard-step-body">
        <span className="onboard-step-title">{title}</span>
        {children}
      </div>
    </li>
  );
}

export default function Onboarding({ email, token, keyStatus, onReloadKey, billing, onReloadBilling, onSignOut }) {
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  // Stripe sends the browser back the moment the card clears, which can be
  // before the webhook that grants entitlement lands. Asking for money again
  // on that screen is the one thing this step must never do.
  const returned = params.get('billing');
  const [confirming, setConfirming] = useState(returned === 'success');

  const keyDone = !!keyStatus?.set;
  const paid = !!billing?.entitled;

  const reloadBilling = useRef(onReloadBilling);
  reloadBilling.current = onReloadBilling;
  useEffect(() => {
    if (!confirming || paid) return undefined;
    let tries = 0;
    const timer = setInterval(() => {
      if (++tries > CONFIRM_TRIES) setConfirming(false);
      else reloadBilling.current();
    }, CONFIRM_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [confirming, paid]);

  async function subscribe() {
    setBusy(true);
    setError(null);
    try {
      await startCheckout();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  async function manage() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api('/api/billing/portal', { method: 'POST' });
      window.location.assign(url);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth-card onboard-card">
        <div className="auth-brand">QAssist</div>
        <div className="auth-body">
          <p className="auth-lead">Two things before your first run</p>
          <p className="auth-sub">
            Runs drive a real browser on your own OpenAI key, so the model cost stays yours and the
            browser time is what this instance bills for.
          </p>

          <ol className="onboard-steps">
            <Step index={1} title="Signed in" state="done">
              <span className="onboard-step-note">{email}</span>
            </Step>

            <Step index={2} title="Add your OpenAI key" state={keyDone ? 'done' : 'active'}>
              <span className="onboard-step-note">
                Stored encrypted and never shown again. Model cost and rate limits stay on your
                OpenAI account.
              </span>
              <OpenaiKey token={token} status={keyStatus} onReload={onReloadKey} bare />
            </Step>

            <Step
              index={3}
              title="Subscribe"
              state={paid ? 'done' : keyDone ? 'active' : 'locked'}
            >
              {!keyDone && (
                <span className="onboard-step-note">
                  Available once your key is stored — a subscription is no use without one.
                </span>
              )}
              {keyDone && !paid && (
                <>
                  <span className="onboard-step-note">
                    {confirming
                      ? 'Payment received. Confirming with Stripe — this usually takes a few seconds.'
                      : returned === 'cancelled'
                        ? 'Checkout was cancelled. Nothing was charged.'
                        : billing?.status
                          ? 'Your subscription has lapsed. Resubscribe to start running tests again.'
                          : 'Card details are taken by Stripe — we never see them.'}
                  </span>
                  <div className="onboard-actions">
                    <Button variant="primary" size="sm" disabled={busy || confirming} onClick={subscribe}>
                      {confirming ? 'Confirming…' : billing?.status ? 'Resubscribe' : 'Subscribe'}
                    </Button>
                    {/* The way out of a dead card must not sit behind the
                        paywall it would clear. */}
                    {billing?.manageable && (
                      <Button variant="secondary" size="sm" disabled={busy} onClick={manage}>
                        Manage billing
                      </Button>
                    )}
                  </div>
                </>
              )}
            </Step>
          </ol>

          {error && <p className="auth-error">{error}</p>}

          <div className="onboard-foot">
            <span>Signed in as {email}</span>
            <Button variant="ghost" size="sm" onClick={onSignOut}>
              Sign out
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
