# US-053 — Onboarding: key, then subscribe, before the app

**As a** new customer on a billing instance, **I want** the app to tell me the
two things it needs from me the moment I sign in, **so that** I never meet the
product as a run that was refused.

- **Status:** ✅ Built, unproven on a box
- **Priority:** High — it is the first screen a paying customer sees
- **Estimate:** ~0.5 day
- **Depends on:** US-021 (login), US-022 (billing), US-039 (BYOK-only), US-036 (the demo that makes the wall affordable)

## Why now

Today a new account lands on the Run view and finds out what it owes by being
refused: a 503 for the missing OpenAI key, a 402 for the missing subscription.
Both notices are correct and both are late — the first thing the product does
is fail. The demo sandbox (US-036) is what makes the alternative affordable:
"see how it behaves" is a link, not a free run, so a signed-in account can be
asked for the key and the card *before* the app.

The order is not cosmetic. Runs are funded by the caller's own key and by
nothing else (US-039), so a subscription bought by someone with no key stored
buys a product they cannot use — a refund conversation, not a customer.

## Details

Three steps, presented as a checklist, derived entirely from server state —
there is no "onboarded" flag to set, drift from, or reset:

1. **Signed in** — already true to be reading this (US-021 owns getting here).
2. **OpenAI key** — `GET /api/account/openai-key` → `{ set }`. The step is the
   existing `OpenaiKey` component, not a second key form.
3. **Subscription** — `GET /api/billing/status` → `{ entitled }`. Locked until
   step 2 is done, in the UI *and* on the server.

**Forced.** The wall *is* the app while it stands, the way the login screen is
(multi-user mode only). Two escapes stay open, because a forced flow that is
also a trap is worse than no flow: **Sign out**, and **Manage billing** for
anyone who already has a Stripe customer — a lapsed subscriber's way to fix a
card must never be behind the paywall it is trying to clear.

**Entitlement alone raises it.** The wall shows while `entitled` is false, and
the key is step 2 *inside* it rather than a second condition on it. A new
account is never entitled, so it always meets the full checklist; but an
account that has paid is never sent back here — a key removed later is the Run
view's existing "Setup needed" banner to raise, not grounds to lock a customer
out of the history and reports they paid for.

**Only where the instance charges.** The wall is gated on `health.billing`. A
self-hosted deployment (`STRIPE_*` unset) keeps exactly today's behaviour: the
non-blocking "Setup needed" banner on the Run view, and no new screen. Self-host
is always free, and it does not acquire an onboarding gate as a side effect of
the hosted tier having one.

**Returning from Checkout.** Stripe redirects to `/?billing=success` before the
webhook has necessarily landed, so at that instant the account is still not
entitled and the wall would show the same Subscribe button to someone who has
just paid. The step therefore reads as *confirming* and polls `/api/billing/status`
for a short window instead of asking for money twice.

**The server side of step 3** is the load-bearing half: `POST /api/billing/checkout`
refuses with 409 when the caller has no stored key, before any call to Stripe.
The disabled button is an affordance; this is the rule. Correctness-critical
(it is a billing gate) — the assertion is `server/test/checkout-key-gate.test.js`,
written and reviewed before the implementation, and a row is added to
`backlog/correctness-critical.md`.

**What this deliberately does not do.** The key is checked for shape only —
nothing calls OpenAI to see whether it authenticates. So step 2 goes green for a
typo'd or revoked key, and the account pays on the strength of a string starting
with `sk-`. Raised and consciously deferred (2026-07-26): validating at save time
means a network call on the BYOK surface with a fail-open branch for instances
that cannot reach OpenAI, which is its own story and its own assertion.

## Acceptance criteria

- [ ] A fresh account on a billing instance sees the checklist, not the Run view
- [ ] Step 3 is locked while no key is stored; storing one unlocks it in place,
      with no reload
- [ ] `POST /api/billing/checkout` with no stored key returns 409 and makes no
      request to Stripe
- [ ] Subscribing drops the wall for good, with nothing persisted client-side to
      make that true, and an entitled account is never walled again
- [ ] Sign out is reachable from the wall; so is Manage billing for an account
      that has a Stripe customer
- [ ] `STRIPE_*` unset: no wall, no `/api/billing` request, Run view unchanged
- [ ] Returning from Checkout shows a confirming state, not a second Subscribe
