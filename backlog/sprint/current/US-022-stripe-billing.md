# US-022 — Paid tier: Stripe subscription billing

**As the** operator, **I want** users to pay a subscription before running tests on the hosted instance, **so that** the cloud version has revenue from day one without me invoicing anyone.

- **Status:** 📋 Planned (moved to next sprint on 2026-07-23 with the rest of the
  hosted tier, pulled back into the current sprint on 2026-07-25)
- **Priority:** P1 (current sprint) — last story before the hosted launch
- **Estimate:** ~1–2 days
- **Depends on:** US-021 (auth), US-007 (public HTTPS — Stripe webhooks),
  US-005 (BYOK — the paid plan covers hosting, not LLM tokens)

## Design decisions (2026-07-22)

- **Minimal paid v1**: one subscription plan, Stripe Checkout + Customer
  Portal (no custom payment UI), BYOK for LLM usage. Metered/included LLM
  usage, multiple plans, and per-tenant instances are all future cloud work.
- **Lives in the public repo, env-gated.** `STRIPE_*` env vars unset (the
  self-host default) = billing entirely off, everything free — self-hosters
  never see it. Stripe Checkout glue is not secret sauce; the routing rule in
  [`docs/repo-model.md`](../../../docs/repo-model.md) sends anything a
  self-hoster might want here, env-gated, and an org self-hosting for its team
  can charge its own users with the same switch.

## Why it ships here, now (2026-07-25)

The hosted tier is the reason this story exists, and **not everyone can
self-host** — a paid instance is how those users get the product at all. There
is no free plan, so "can this account run a test?" has exactly one answer to
compute, and the whole of billing v1 is: charge a card, and let an unpaid
account look but not run.

Waiting for cloud-only infrastructure to exist first would mean waiting for
work that is measured in weeks to launch something that is measured in days.
So this repo gets a complete, minimal, env-gated Stripe integration and
qassist.run runs on it. That is inside the model, not a deviation from it:
`docs/repo-model.md` already routes billing here *"or env-gated here, while the
private repo doesn't exist"*, and a self-hosting org gets a real feature out of
it rather than a stub.

## Design decisions (2026-07-25) — settled before implementing

1. **`billingEnabled()` ANDs the runtime preconditions**, like `authEnabled()`
   and `demoMode()` before it: `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` +
   `STRIPE_PRICE_ID` present, **and** the control plane, **and**
   `authEnabled()`. Requiring auth is not decoration — billing charges *users*,
   and without real users the only account is the seeded operator, so a
   single-token or open instance must never be able to gate anything. Missing
   any one leaves the instance byte-for-byte free.
2. **One row per user in a `subscriptions` table**, not columns on `users`:
   Stripe's identifiers and status are one cohesive lifecycle that a webhook
   rewrites as a unit, and `users` is already carrying BYOK and demo columns.
3. **Entitled = `active` | `trialing`, plus `past_due` until
   `current_period_end`.** Stripe retries a declined card for ~2 weeks; cutting
   a paying customer's overnight schedules off on the first failed retry is the
   worse of the two bugs. `canceled` / `unpaid` / `incomplete` / no row block
   immediately.
4. **No trial in v1.** No `trial_period_days` on the Checkout session — the
   card is charged at signup. The demo sandbox (US-036) is already the
   try-before-you-buy path, and it needs no card and no cleanup. `trialing` is
   still an entitled status so turning a trial on later is a Stripe dashboard
   change, not a code change.
5. **`BILLING_EXEMPT_EMAILS`, defaulting to `OPERATOR_EMAIL`.** The operator
   must be able to smoke-test production without subscribing to their own
   product, and a self-hosting org needs to exempt its own staff. An explicit,
   asserted, logged-in-config bypass — not a hidden one.
6. **The gate refuses at submit, and it refuses with 402.** Same shape as
   US-028's over-cap 429: nothing is inserted, nothing is queued, and the
   response says what to do about it. 402 rather than 403 so a CI caller can
   tell "you must pay" from "your token is wrong".
7. **Reads stay open.** History, run detail, steps, the PDF, the recording,
   Settings, and every `GET` remain reachable with a lapsed subscription. A
   customer who stops paying keeps their data and can export it; blocking reads
   would make cancellation a data-loss event.
8. **Schedules are blocked at fire time, not deleted.** A lapsed customer's
   schedules stay configured and simply do not fire (the scheduler's claim is
   already the funnel). Resubscribing resumes them; nothing is destroyed by a
   late invoice.
9. **No SDK.** Stripe is three form-encoded `POST`s and one HMAC, and the
   established pattern in this repo is `mail.js` — *"a dependency that wraps
   that would be more code to audit than the code it replaces"*. `stripe` would
   be the fourth runtime dependency after express/pg/ws.
10. **Per-plan quotas are out of scope.** US-028's `getUserConcurrencyCap()` is
    the seam a later plan-driven cap goes through (`runs.js`); v1 has one plan,
    so it stays one env number for everyone.

## Details

- **Config** (`config.js`): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `STRIPE_PRICE_ID`, `BILLING_EXEMPT_EMAILS` (comma list, defaults to
  `OPERATOR_EMAIL`). `PUBLIC_BASE_URL` (US-007) supplies Checkout's
  success/cancel and the portal's return URL — billing is off without it, since
  Stripe needs somewhere to send the customer back to.
- **Schema** (`db/migrations/008_subscriptions.sql`):
  - `subscriptions` — `user_id` PK → `users(id) on delete cascade`,
    `stripe_customer_id` unique, `stripe_subscription_id` unique, `status`,
    `current_period_end`, `updated_at`, plus `last_event_at` (decision: drop a
    webhook whose event is older than the one already applied, so an
    out-of-order `subscription.updated` can't resurrect a cancelled sub).
  - `stripe_events` — `id text primary key`, `type`, `received_at`. The
    idempotency ledger: an insert that conflicts means "already processed".
- **`src/billing.js`** — `billingEnabled()`, the `fetch` transport, checkout /
  portal session creation, `verifyWebhookSignature()`, `claimEvent()`,
  `applySubscriptionEvent()`, `getSubscription()`, `isEntitled()`.
- **Routes** (`src/routes/billing.js`, 404 as a whole unless
  `billingEnabled()`): `GET /api/billing/status`,
  `POST /api/billing/checkout`, `POST /api/billing/portal`.
- **The webhook** is mounted in `server.js` *before* `express.json()`, with
  `express.raw()` — the signature covers the exact bytes Stripe sent, so a
  re-serialized body cannot be verified. It carries no bearer (Stripe has no
  credential of ours); its signature *is* its authentication.
- **The gate**: an async `requireEntitled` middleware beside
  `requireAgentKey` in `routes/helpers.js`, on every run-starting route, plus
  the scheduler's fire path. Enumerating the paths is the risk, so the
  assertion enumerates them too (below).
- **Health**: `/api/health` gains `billing: billingEnabled()`, so the SPA knows
  whether to render any of this. Null/false on self-host = no billing UI.
- **Frontend**: a Billing section in the Settings dialog (status + Subscribe /
  Manage billing), and 402 handling in `RunView` alongside US-028's 429 notice,
  with the CTA rather than a bare error.
- **Docs**: `.env.example` block, README section (incl. the Stripe test-mode
  flow with `stripe listen` for local webhooks), `db/README.md` table note.

## Assertion-first surfaces

Billing gates are the one row in
[`correctness-critical.md`](../../correctness-critical.md) that has been
assertion-first *from its first line*, so these two get maintainer-reviewed
assertions before the implementation is written. Proposed:

**`billing-gate.test.js`** — the entitlement decision and its reach:
- `STRIPE_*` unset → every start path behaves exactly as today (the self-host
  regression this whole design exists to prevent), and `/api/billing/*` 404s.
- Enumerate **every** path that can start a run — ad-hoc `POST /api/runs`,
  test, suite, module, project, retry, and the scheduler's fire — and assert
  each is refused with no subscription. The US-036 interceptor story is the
  precedent: one forgotten path is the whole defect.
- Refused means **nothing happened**: no `runs` row, no queue entry, no
  `MAX_CONCURRENT` slot, no agent spawn.
- Status table: `active`/`trialing` run; `canceled`/`unpaid`/`incomplete`/no
  row are refused; `past_due` runs before `current_period_end` and is refused
  after it.
- Reads stay open under every blocked status (history, run detail, steps,
  report, recording).
- An exempt email runs with no subscription row; a non-exempt one does not.
- Demo mode is never gated.

**`billing-webhook.test.js`** — the one endpoint on the instance that a
stranger can POST to:
- A body whose signature was computed with the wrong secret, or over different
  bytes, is rejected and changes nothing.
- A signature outside the timestamp tolerance is rejected (replay), and a
  valid, in-tolerance event **id** delivered twice is applied once.
- Signature comparison is timing-safe and never throws on malformed input
  (`t=`/`v1=` missing, empty, non-numeric, multiple `v1=`).
- An event older than the one already applied does not overwrite it.
- `checkout.session.completed` joins the Stripe customer to the right user, and
  a subsequent `customer.subscription.deleted` blocks that user and nobody
  else.

## Acceptance criteria

- [ ] User can subscribe via Checkout and immediately run tests
- [ ] Cancelled subscription blocks new runs but not viewing history; a
      `past_due` one keeps running until the period it paid for ends
- [ ] Webhook replay/signature attacks are rejected, asserted
- [ ] Self-host with no `STRIPE_*` env vars: no billing UI, no gating, no
      behaviour change on any run path
- [ ] A lapsed customer's schedules stop firing and resume on resubscribe,
      without being deleted
- [ ] Stripe test-mode end-to-end flow documented for development
- [ ] `correctness-critical.md`'s billing row names the real files and tests
