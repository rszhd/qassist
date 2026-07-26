# US-054 — The activation window: capacity before the first run

**As the** operator of a box I upgrade by hand, **I want** a paid account to
wait in a stated activation window before it can run, **so that** I have time
to add the capacity it just bought instead of selling a subscription to a
server that cannot serve it.

- **Status:** 🟡 Built 2026-07-26 — every criterion but the staging round trip
- **Priority:** High — it is the difference between a slow first run and a bad one
- **Estimate:** ~0.5–1 day
- **Depends on:** US-022 (billing), US-053 (the checklist this extends), US-021 (accounts), US-012 (mail)

## Why now

A run is a real Chromium under a real box, and the box is sized to the budget,
not to demand. Today the moment a card clears the account is entitled and its
first run competes for whatever `MAX_CONCURRENT` was set to for the accounts
already there. The honest fix for a one-person operation is not autoscaling —
it is **an hour of my time**, spent resizing the server, and the product
currently has nowhere to put that hour.

So the subscription stops meaning "you may run now" and starts meaning "you may
run once this instance has room for you". The customer is told that before they
pay, not after, and told when it ends. A wait that was promised is an
onboarding step; the same wait discovered as a queued run that never starts is
a refund.

US-053 built exactly the surface this needs. The checklist is already the app
on a billing instance, already derived from server state, and already falls
away for good once the account is ready. This adds a fourth step to it.

## Details

**One new fact, and it is the operator's:** `users.activated_at`. Null means
this account has no capacity allocated to it yet; a timestamp means it does.
It is written by nobody but the operator, never by Stripe — which is why it
lives on `users` and not on `subscriptions`, the row a webhook rewrites as a
unit (US-022 decision 2). A customer who cancels and resubscribes is not
re-provisioned, so activation is **sticky**: once granted it is never cleared
by any code path in this story.

**The clock is Stripe's, and it is written once.** `subscriptions.activation_requested_at`
is stamped from the entitling event's own `created` — coalesced, so the first
one wins and every later `customer.subscription.updated` leaves it alone. This
is the load-bearing detail: a deadline computed from `updated_at`, or
recomputed per event, slides forward every time Stripe sends anything and the
window quietly never closes. Migration `010_account_activation.sql` adds both
columns, inert on a self-hosted instance exactly as `008`'s tables are.

**Pending is a fourth step on the US-053 wall,** not a new screen: "Preparing
your workspace", active once step 3 goes green, showing the deadline in the
customer's own words — *ready by Mon 27 Jul, 14:20; we'll email you.* The wall
therefore falls on `entitled && activated`, which amends US-053's "entitlement
alone raises it" by exactly one condition and nothing else. Because
`activated_at` is sticky, an account that has ever been activated is never
walled again — a lapse is still the Run view's banner and the 402, not this.

**The gate refuses at submit, like every other one.** All seven run-start paths
go through it, the scheduler claims-and-skips as it already does for a lapsed
owner, and reads stay open — history, reports, recordings, Settings, every
`GET` (US-022 decision 7). The refusal is **503 with `Retry-After` and
`activation_pending: true`**, not the 402: the caller has paid, nothing is
wrong with their request, and the correct instruction to a CI runner is come
back later. The body flag is what distinguishes it from the keyless 503, the
same way `billing_required` distinguishes the 402.

**Off unless the operator asks for it.** `ACTIVATION_SLA_HOURS` unset or `0` =
no fourth step, no gate, no column read — an instance that already charges does
not acquire a hold on its next customer because we upgraded it. `qassist.run`
sets `24`. Self-host is untouched twice over: the whole thing is behind
`billingEnabled()` as well.

**The operator's half is a script, not a screen.** `npm run activate` in
`server/`: no argument lists the accounts waiting and how long each has left,
`-- <email>` sets `activated_at` on exactly one account. That is deliberately
where the work already happens — the operator is on the box resizing it, and
an admin UI would be a new authenticated surface for a one-line UPDATE. The
runbook line goes in `DEPLOY.md` beside the resize it accompanies.

**Two mails, because a promise nobody sees is not one.** On the first entitling
event, `OPERATOR_EMAIL` gets the account, the plan and the deadline. On
activation, the customer gets "your workspace is ready" with a link into the
app. Both through `mail.js`; both no-ops when mail is unconfigured.

**Correctness-critical** (a run-start gate, and it decides what a paying
customer may do). Per the Workflow rule the assertion is written and reviewed
**before** the implementation — `server/test/activation-gate.test.js` — and a
row is added to `backlog/correctness-critical.md` as part of doing the work.
The subtle ways it breaks:

- the gate leaks into the unset path and a self-host — or an existing billing
  instance that never set `ACTIVATION_SLA_HOURS` — grows a wall it did not ask
  for;
- one of the seven start paths misses it, most likely the scheduler, and the
  window is bypassable by anyone who saved a schedule before subscribing;
- an ordinary `customer.subscription.updated` writes over `activated_at` and
  re-walls a customer who has been running for a month;
- the deadline is read from a rewritten timestamp and slides forward on every
  webhook, so "24 hours" is unbounded and nothing ever alerts;
- the script matches an email loosely and activates the wrong account, or two.

## What this deliberately does not do

- **No auto-activation at the deadline.** A timer that flips the flag hands the
  customer a box nobody upgraded, which is the exact failure this story exists
  to prevent — and it would do so silently, at the hour least likely to be
  watched. The 24 hours is a promise made visible (the operator's mail, the
  pending list, the customer's stated time), and if it cannot be met the honest
  lever is Stripe: refund or cancel, not a flag set on an empty room. Making it
  automatic later is a one-line change against these same assertions.
- **No capacity model.** The instance does not know its own size, does not
  count subscribers against it, and does not decide anything for itself. That
  judgement is the operator's, and pretending otherwise would be a scheduler
  for hardware we do not have.
- **No refund or SLA credit path.** An overdue account is visible; what happens
  about it is a conversation in Stripe.
- **Nothing for the demo sandbox.** `AUTH_MODE=demo` leaves `authEnabled()`
  false, so billing is off and this is off with it.

## What was decided while building it

Three things the story did not say, each surfaced by writing the assertions
first and each reviewed before any implementation existed.

**The two gates are one middleware and one database read.** `requireEntitled`
answers entitlement and then activation off a single `billingStateFor`, rather
than a second middleware beside it. The story's own second failure mode is "one
of the seven start paths misses it"; making it structurally impossible for a
route to have the billing check and miss this one is worth more than a name
that reads truer. The scheduler asks the same one question (`runGateFor`).

**`010` backfills.** It sets `activated_at = now()` for every user who already
has a `subscriptions` row — any row, including a lapsed one: this box has
already served them. Without the backfill, the day `qassist.run` sets
`ACTIVATION_SLA_HOURS=24` every existing paying customer is walled at once,
which is this story's third failure mode arriving by deployment instead of by
webhook. A no-op on a self-host, where the table is empty.

**Off releases, it does not strand.** `slaHours` falsy resolves to
`activated: true` for everybody rather than to "skip the check". That is what
lets every call site ask the same question with no `if (enabled)` around it —
and it means an operator who has since bought a box big enough to stop
rationing capacity deletes the line from `.env`, restarts, and everyone
mid-window is released. There is no backlog to work through by hand and no
account left half-provisioned. Asked for explicitly during the build; the
behaviour is pinned in `billing-gate.test.js`, not left to the shape of the
code.

One smaller reading: the webhook stamps `activation_requested_at`
**unconditionally**, and only the operator mail is gated on the window being
on. Recording is a write, not the "no column read" the off path promises, and
it means an instance that switches the window on later finds a correct clock
rather than a null. The gate itself reads nothing when off, and the two columns
ride along in `billingStateFor`'s existing join — so "no new query" holds
literally.

## Acceptance criteria

- [x] With `ACTIVATION_SLA_HOURS=24`, an account that has just subscribed sees
      the fourth step with its deadline, not the Run view
- [x] Every run-start path refuses that account with 503 + `Retry-After` +
      `activation_pending`, and its schedules are claimed but do not fire
- [x] Reads stay open throughout: history, run detail, report, recording,
      Settings
- [x] `npm run activate` lists it as pending; `npm run activate -- <email>`
      activates it, the wall falls with no reload of anything but state, and
      the next run starts
- [x] Activation survives a subsequent `customer.subscription.updated`, a
      cancel and a resubscribe — the account is never walled a second time
- [x] `activation_requested_at` is stamped once: a second entitling event does
      not move the deadline
- [x] `ACTIVATION_SLA_HOURS` unset: byte-for-byte today's behaviour on a
      billing instance — no fourth step, no 503, no new query
- [x] `STRIPE_*` unset: no wall, no gate, no mail, self-host unchanged
- [x] The operator is mailed on subscribe with the deadline; the customer is
      mailed on activation
- [ ] Proven on a live box with a real Checkout round trip: subscribe → walled →
      activate over SSH → run. **Preview, not staging** — this story is what
      showed that US-055's "no Stripe on preview" rule bought nothing and cost
      every billing change the fast loop, so the rule was reversed rather than
      the criterion honoured. Staging still owns what it always did: a
      populated database and a CI-built image
