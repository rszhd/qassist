-- 008_subscriptions.sql — US-022: Stripe subscription billing, env-gated.
-- Both tables are inert on a self-hosted instance: with STRIPE_* unset nothing
-- ever writes to them and nothing ever reads them (billing.js), so the schema
-- costs a free deployment two empty tables and no behaviour.

-- One row per user rather than columns on `users` (decision 2): Stripe's ids
-- and status are one cohesive lifecycle that a webhook rewrites as a unit, and
-- `users` already carries BYOK and demo columns.
create table subscriptions (
  user_id                uuid primary key references users(id) on delete cascade,
  -- Both unique: they are Stripe's identity for this account, and the webhook
  -- resolves a customer.subscription.* event back to a user through the first.
  stripe_customer_id     text unique,
  stripe_subscription_id text unique,
  -- Deliberately NO check constraint. The value is whatever Stripe sends
  -- ('active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete',
  -- 'paused', …); a check here would make Stripe adding a status a 500 in the
  -- webhook. Which of them may run is billing.js's `entitledFrom`, one place.
  status                 text not null,
  -- What `past_due` gets its grace against (decision 3): Stripe retries a
  -- declined card for ~2 weeks, and a customer keeps the period they paid for.
  current_period_end     timestamptz,
  -- The event clock, from the Stripe event's own `created`. Webhooks are not
  -- ordered: without this, a `subscription.updated` generated before a
  -- cancellation but delivered after it would resurrect the cancelled sub.
  last_event_at          timestamptz,
  updated_at             timestamptz not null default now()
);

-- The idempotency ledger: Stripe retries deliveries, so an insert that
-- conflicts means "already processed" and the event is dropped. Rows are tiny
-- and their whole value is being a permanent record of what was applied.
create table stripe_events (
  id          text primary key,   -- Stripe's evt_… id
  type        text,
  received_at timestamptz not null default now()
);
