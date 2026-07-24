# US-022 — Paid tier: Stripe subscription billing

**As the** operator, **I want** users to pay a subscription before running tests on the hosted instance, **so that** the cloud version has revenue from day one without me invoicing anyone.

- **Status:** 📋 Planned (moved to next sprint on 2026-07-23 with the rest of the
  hosted tier)
- **Priority:** P1 (next sprint) — last story before the hosted launch
- **Estimate:** ~1–2 days
- **Depends on:** US-021 (auth), US-007 (public HTTPS — Stripe webhooks),
  US-005 (BYOK — the paid plan covers hosting, not LLM tokens)

## Design decisions (2026-07-22)

- **Minimal paid v1**: one subscription plan, Stripe Checkout + Customer
  Portal (no custom payment UI), BYOK for LLM usage. Metered/included LLM
  usage, multiple plans, and per-tenant instances are all future cloud work.
- **Lives in the public repo, env-gated.** `STRIPE_*` env vars unset (the
  self-host default) = billing entirely off, everything free — self-hosters
  never see it. This defers the private cloud repo: it gets created when
  genuinely cloud-only infra exists (managed fleet, included LLM usage,
  multi-tenant orchestration), not for one webhook handler. Stripe Checkout
  glue is not secret sauce.

## Details

- Schema: `subscriptions` table (or columns on `users`): stripe_customer_id,
  stripe_subscription_id, status, current_period_end. New migration.
- `POST /api/billing/checkout` → Stripe Checkout session;
  `POST /api/billing/portal` → Customer Portal (cancel/update card);
  `POST /api/stripe/webhook` (signature-verified) syncs subscription status.
- Gate: creating runs (and schedules firing) requires an active subscription
  when billing is enabled; viewing past runs/reports stays allowed.
- Free trial: use Stripe's trial-days on the subscription rather than
  app-side logic.
- Concurrency/fair-use caps per user (runs/day or concurrent runs) — a
  simple constant is fine for v1; the VPS's `MAX_CONCURRENT_SESSIONS=4` is
  the real global ceiling and oversubscription risk to watch at launch.

## Acceptance criteria

- [ ] User can subscribe via Checkout and immediately run tests
- [ ] Cancelled/past-due subscription blocks new runs but not viewing history
- [ ] Webhook replay/signature attacks are rejected
- [ ] Self-host with no `STRIPE_*` env vars: no billing UI, no gating
- [ ] Stripe test-mode end-to-end flow documented for development
