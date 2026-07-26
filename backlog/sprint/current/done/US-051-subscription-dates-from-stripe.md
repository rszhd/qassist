# US-051 — The subscription dates Stripe sends and we don't read

**As a** subscriber whose card just failed, **I want** my runs to keep working
until the end of the period I already paid for, **so that** one declined charge
does not stop tonight's scheduled tests while Stripe is still retrying. **And as
a** subscriber who has cancelled, **I want** the app to say when my access ends,
**so that** I can see the cancellation took.

Two gaps, one cause: dates on the Stripe subscription object that we either read
from a location Stripe abandoned, or never read at all. They share an event, a
migration and a panel, so they are one story.

- **Status:** ✅ Done 2026-07-26, shipped in `v0.2.3` and proven on staging
  against real Stripe events (evidence below). Defect, found the same day on
  staging during US-038's Stripe test-mode round trip — the first time the
  webhook path ran against a real Stripe account rather than a fixture.
- **Priority:** P1, **pulled into the current sprint 2026-07-26** (written
  straight into it, as US-038 was). It is a live defect in shipped billing
  (US-022), it fails in the direction that costs a paying customer their
  product, and it is cheap. It also belongs to this sprint's work rather than
  beside it: US-038 owes a Stripe round trip, and a round trip that leaves a
  column NULL has not proven what the criterion says it proves.
- **Estimate:** ~1–2 h. The code change is a few lines; the cost is the reviewed
  assertion, since this is a listed correctness-critical surface.
- **Depends on:** [US-022](done/US-022-stripe-billing.md)
  (shipped). No dependants.

## What is wrong

`subscriptions.current_period_end` is NULL for every real subscription, so
decision 3 of US-022 — *`past_due` keeps running until the period it paid for
ends* — is unreachable in production. `entitledFrom` (`server/src/billing.js:77`)
grants the grace period only up to that timestamp and fails closed without it,
so a `past_due` customer is cut off on the first failed retry. That is precisely
the outcome the story chose against, and the code's own comment calls it "the
worse of the two bugs".

The cause is upstream: **Stripe moved `current_period_end` off the Subscription
object onto the subscription item** in API version `2025-03-31.basil`.
`applySubscriptionEvent` reads `object.current_period_end`
(`server/src/billing.js:240`), which is now `undefined` on every event, so
`periodEnd` is null and the `coalesce($5::timestamptz, current_period_end)` in
`writeSubscription` correctly preserves a column that was never written.

There is a second, visible symptom on the same field. `Billing.jsx:32` drops the
renewal date from an active subscription's line silently, and `:29` tells a
`past_due` customer "the period you paid for has ended. Runs are paused" — a
false statement that happens to agree with the wrong gate decision.

## Evidence from the box (2026-07-26)

Staging on Stripe test keys, endpoint API version `2026-06-24.dahlia`:

- Two subscriptions, both `status=active`, both `current_period_end` **NULL**,
  written from `checkout.session.completed` ×2, `customer.subscription.created`
  ×2 and `customer.subscription.updated` ×2 — every event delivered, verified
  and applied. Nothing failed; the field simply never arrives.
- Read back live from `GET /v1/subscriptions`: top-level `current_period_end`
  **absent**, `items.data[0].current_period_end` = `1787708058`. The only
  top-level key matching `period` is `cancel_at_period_end`.

## Second gap: a scheduled cancellation is invisible

Found the same day, testing the cancel path. Cancelling through the Customer
Portal does not cancel immediately — it schedules. On `mharith.dev@gmail.com`:
cancellation requested `2026-07-26T01:29:56Z`, `cancellation_details.reason =
cancellation_requested`, and `cancel_at = 1787707626` — exactly 31 days after
`start_date`, i.e. the period end. `status` stays `active` until then.

The webhook half works: that request fired a `customer.subscription.updated`
which was delivered, verified and applied, leaving the status `active` —
correct, because the customer keeps what they paid for. What is missing is that
we store neither `cancel_at` nor `cancel_at_period_end`, so `billingStateFor`
cannot return it and `Billing.jsx:31-33` renders a bare "Subscription active".
A customer who has just cancelled sees a panel indistinguishable from one who
has not, with no end date and no confirmation — which invites a second
cancellation attempt, a support message, or a chargeback.

Note this is **not** an entitlement bug. `entitledFrom` is right to keep a
scheduled cancellation entitled until it takes effect, and the fix must not
change that. It is only about what the panel is able to say.

Worth recording because it cost time: `cancel_at_period_end` was **False** on
this subscription while a cancellation was genuinely scheduled — on API version
`2026-06-24.dahlia` the schedule is expressed as a concrete `cancel_at`
timestamp. So the boolean is not the field to test, which is the same class of
mistake as the period-end half: reading the shape Stripe used to send.

## Why the tests are green

They are green and self-consistent, which is what makes this worth writing down.
`billing-gate.test.js:373` pins *fail closed on a NULL period end* (D5) and is
correct — it is the right rule for a row with no known paid-for period. What no
test pins is that a real event **produces** a non-NULL one, and the webhook
fixture at `billing-webhook.test.js:149` builds its subscription object with a
top-level `current_period_end` — an API shape Stripe stopped sending over a year
ago. The fixture is where the defect hides, so the fix must move the fixture as
well as the reader, or the next round trip finds this again.

The general lesson belongs in `docs/testing.md` if it is not there already: a
fixture we wrote is evidence about our parser, never about the wire format.

## Approach

Read the period end from the subscription item, keeping the old location as a
fallback: Stripe replays historical events at the version they were created
with, and an endpoint pinned to an older version still sends the top-level
field. So `items.data[0].current_period_end ?? object.current_period_end`,
not a swap. Taking the first item is right for us because Checkout is created
with exactly one line item (`createCheckoutSession`); a multi-item subscription
is not a shape this product can currently produce.

For the cancellation half, store `cancel_at` as a timestamp rather than the
`cancel_at_period_end` boolean: the boolean was observed False on a genuinely
scheduled cancellation, and a date is what the panel needs to render anyway. It
needs a column, so a new migration — `009_…`, since `008_subscriptions.sql` is
applied on every deployment and migrations are immutable once out.

Out of scope: backfilling the two staging rows (staging data is disposable) and
any wider audit of fields that moved in the same Stripe release — worth a look
while in there, but this story is the two fields with a gate and a panel behind
them.

## Assertion-first

Covered by the existing billing row in
[`correctness-critical.md`](../../../correctness-critical.md) (`applySubscriptionEvent`
and `entitledFrom` are both named there), so no new row is needed — the
maintainer writes or reviews the assertion before the implementation. The claim
to pin:

> A `customer.subscription.updated` event in the **current** API shape — period
> end present only on `items.data[0]` — writes a non-NULL
> `current_period_end`; the same event in the **legacy** shape still does; and a
> `past_due` row so written is entitled strictly before that instant and refused
> at or after it.

The third clause is the one that matters: it is D5's boundary approached from
the other side, and today nothing reaches it because no row ever has the value.

The cancellation half is ordinary test-alongside work — storing a date and
rendering it — with one exception that belongs in the reviewed set, because it
is the way a well-meant fix would break the gate:

> A subscription with a `cancel_at` in the future is entitled. Only
> `customer.subscription.deleted` — or a status Stripe actually sends — ends
> entitlement; a scheduled cancellation never does.

## Acceptance criteria

- [x] A `customer.subscription.*` event carrying the period end on
      `items.data[0]` writes a non-NULL `subscriptions.current_period_end`
- [x] The legacy top-level shape still writes the same value, so replayed and
      older-version events are unaffected
- [x] A `past_due` row with a future period end is entitled; the same row at or
      after that instant is refused — D5's fail-closed-on-NULL case still holds
- [x] `billing-webhook.test.js`'s fixture builds the current API shape, and a
      test would fail if the reader went back to the top-level field alone
- [x] Verified on staging with a real Stripe test event, not only in tests: a
      subscription written after the fix has a non-NULL period end, and the
      Settings panel shows the renewal date
- [x] A cancellation scheduled at period end is stored, from the
      `customer.subscription.updated` that schedules it — `cancel_at` present,
      not inferred from the `cancel_at_period_end` boolean
- [x] Settings distinguishes "active, renews `<date>`" from "active, ends
      `<date>`", so a customer who cancelled can see that it took
- [x] Resuming a scheduled cancellation clears it, and the panel stops saying
      the subscription ends
- [x] Entitlement is unchanged throughout: a scheduled cancellation is entitled
      until it takes effect, and only `customer.subscription.deleted` ends it

## Verified on staging (2026-07-26, `v0.2.3`)

The criterion this story could not tick from a test. Staging on Stripe test
keys, endpoint API version `2026-06-24.dahlia`, `mharith.dev@gmail.com`
cancelling and then resuming through the Customer Portal — two real events, two
new event ids, so neither was dropped by `claimEvent` the way a dashboard resend
would have been.

After the cancellation:

```
status | current_period_end     | cancel_at              | last_event_at
active | 2026-08-26 01:27:06+00 | 2026-08-26 01:27:06+00 | 2026-07-26 04:12:43+00
```

`current_period_end` is non-NULL for the first time — read off `items.data[0]`,
where the same event a day earlier wrote nothing. `cancel_at` equals the period
end exactly, as observed when the defect was found, and `cancel_at_period_end`
was False on this very event. Status stayed `active`: entitlement untouched.
Settings read *Subscription active · ends Aug 26, 09:27 AM*.

After the resume:

```
status | current_period_end     | cancel_at | last_event_at
active | 2026-08-26 01:27:06+00 |           | 2026-07-26 04:14:41+00
```

One event cleared one date and preserved the other, which is the asymmetric
write rule below proven live — the half no fixture could establish. Had the two
columns shared a rule, this event would either have left the cancellation stuck
forever or wiped the entitlement gate's input.

The second staging account, touched by no new event, still carries NULL in both
columns. That is correct: the fix reads events, and backfilling is out of scope.

## Reviewed decisions (2026-07-26)

The assertions were written first and reviewed before any of `billing.js`
changed; the three decisions they encoded and that were signed off:

- **When both shapes carry the period end, the item wins.** Stripe should never
  send both; newest-location-wins is the safer default for a transitional or
  hand-rolled payload. Pinned in `billing-webhook.test.js` (W8).
- **The two dates get different write rules, deliberately** (W9).
  `current_period_end` keeps its `coalesce`: it is the gate's input, so an event
  we cannot read a period out of preserves the last known one rather than
  cutting off every `past_due` customer at once. `cancel_at` is authoritative
  whenever the event carries it — `customer.subscription.*` always does, null
  included, and that null is exactly how a resume through the Customer Portal
  arrives. `checkout.session.completed` knows nothing about it and writes
  nothing to it.
- **`>` not `>=` at the period-end instant** (D9). A period that has ended has
  ended, and Stripe's next event is a second away either way. This was already
  the behaviour — the assertion is a pin, not a fix, and it is the first one
  able to reach the boundary now that rows have the value.
