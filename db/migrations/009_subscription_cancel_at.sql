-- 009_subscription_cancel_at.sql — US-051: the cancellation Stripe has
-- scheduled but not yet carried out. Inert on a self-hosted instance, exactly
-- as 008's tables are: with STRIPE_* unset nothing writes it and nothing reads
-- it.

-- Cancelling through the Customer Portal SCHEDULES: the status stays 'active'
-- until the period ends, and this is the only field that says the cancellation
-- took. A date rather than Stripe's `cancel_at_period_end` boolean, which was
-- observed False on a genuinely scheduled cancellation — on API version
-- 2026-06-24.dahlia the schedule is expressed as this timestamp.
--
-- Deliberately NOT an input to entitlement (billing.js `entitledFrom`): the
-- customer keeps the period they paid for, and the customer.subscription.deleted
-- Stripe sends when the schedule fires is what ends it.
alter table subscriptions add column cancel_at timestamptz;
