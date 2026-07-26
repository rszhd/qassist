-- 010_account_activation.sql — US-054: the activation window. A paid account
-- waits until the operator has given this instance room for it. Inert on a
-- self-hosted instance exactly as 008's tables and 009's column are: with
-- STRIPE_* unset, or ACTIVATION_SLA_HOURS unset, nothing reads either column.

-- The operator's fact, and only theirs: null means no capacity has been
-- allocated to this account yet, a timestamp means it has. On `users` rather
-- than `subscriptions` because a webhook rewrites that row as a unit (US-022
-- decision 2) and this must survive every rewrite — a customer who cancels and
-- resubscribes is not re-provisioned. Written by exactly one statement in the
-- codebase (activation.js `activateByEmail`) and cleared by none.
alter table users add column activated_at timestamptz;

-- When the promise was made, from the entitling Stripe event's own `created`.
-- Stamped once and never moved: a deadline recomputed per event, or taken from
-- updated_at, slides forward every time Stripe sends anything and the window
-- silently never closes.
alter table subscriptions add column activation_requested_at timestamptz;

-- Everyone already here has already been served by this box, so switching the
-- window on must not wall them. Without this, the day ACTIVATION_SLA_HOURS is
-- first set every existing customer is walled at once — the same failure the
-- stickiness rule above exists to prevent, arriving by deployment instead of by
-- webhook. Any subscription counts, including a lapsed one: they had capacity.
-- A no-op on a self-host, where the table is empty.
update users
   set activated_at = now()
 where activated_at is null
   and id in (select user_id from subscriptions);
