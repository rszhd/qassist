import { useState } from 'react';
import { Button } from './ui.jsx';
import { api } from './api.js';
import { formatWhen } from './status.js';

// Subscription billing (US-022). Rendered only when /api/health says
// `billing` — on a self-hosted instance this component never mounts and the
// Settings dialog is exactly what it was.
//
// There is no payment UI of our own: Checkout takes the card and the Customer
// Portal handles changes, invoices and cancellation, so the whole surface here
// is a status line and a button that leaves for Stripe.
//
// The status is App's (US-053): the onboarding wall renders off the same
// answer, and two components fetching it would eventually disagree about one
// account.

/**
 * Send the browser to Stripe Checkout. Exported because the 402 notice in
 * RunView offers the same CTA — a refused run and Settings must not drift into
 * two different ways to subscribe.
 */
export async function startCheckout() {
  const { url } = await api('/api/billing/checkout', { method: 'POST' });
  window.location.assign(url);
}

/** What each status means to the person reading it, not to Stripe. */
function describe({ status, entitled, current_period_end: until, cancel_at: cancelAt }) {
  if (status === 'past_due') {
    return entitled
      ? `Last payment failed — Stripe is retrying. Runs keep working until ${formatWhen(until)}.`
      : 'Last payment failed and the period you paid for has ended. Runs are paused.';
  }
  if (status === 'active' || status === 'trialing') {
    const label = status === 'trialing' ? 'Trial' : 'Subscription';
    // Cancelling through the Portal schedules rather than cancels, so the
    // status is still active. Saying "renews" to someone who has just
    // cancelled invites a second attempt, or a chargeback.
    if (cancelAt) return `${label} active · ends ${formatWhen(cancelAt)}`;
    return `${label} active${until ? ` · renews ${formatWhen(until)}` : ''}`;
  }
  if (status === 'canceled') return 'Subscription cancelled. Runs are paused; your history stays.';
  if (status) return `Subscription ${status}. Runs are paused.`;
  return 'No subscription yet. Subscribe to start running tests.';
}

export default function Billing({ state, keyStatus }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Subscribing without a stored key buys a product that cannot run (US-053):
  // the server refuses the checkout, so offering the button would only produce
  // a 409 the customer can't act on from here.
  const keyMissing = !keyStatus?.set;

  async function go(action) {
    setBusy(true);
    setError(null);
    try {
      if (action === 'checkout') await startCheckout();
      else {
        const { url } = await api('/api/billing/portal', { method: 'POST' });
        window.location.assign(url);
      }
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="billing">
      <div className="field-label">Billing</div>
      {state?.exempt ? (
        // An asserted, visible bypass rather than a hidden one: someone on the
        // exempt list should be able to see why they are never asked to pay.
        <p className="field-hint">
          This account runs without a subscription (it is on the instance&apos;s exempt list).
        </p>
      ) : (
        <>
          <p className="field-hint">
            Runs on this instance need an active subscription. Your OpenAI key is separate — tokens
            are always billed to you.
          </p>
          {state && (
            <div className="billing-state">
              <span>{describe(state)}</span>
              <div className="billing-actions">
                {state.manageable && (
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => go('portal')}>
                    Manage billing
                  </Button>
                )}
                {!state.entitled && (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy || keyMissing}
                    title={keyMissing ? 'Add your OpenAI key below first' : undefined}
                    onClick={() => go('checkout')}
                  >
                    {state.status ? 'Resubscribe' : 'Subscribe'}
                  </Button>
                )}
              </div>
            </div>
          )}
          {state && !state.entitled && keyMissing && (
            <p className="field-hint">
              Add your OpenAI key below before subscribing — runs are funded by it, so a
              subscription without one buys nothing you can use.
            </p>
          )}
        </>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
