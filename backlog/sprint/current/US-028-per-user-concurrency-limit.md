# US-028 — Per-user concurrent run limit

**As the** operator of an instance (a self-hosting organization, or later the
hosted service), **I want** each user capped to a few concurrent runs, **so
that** one user cannot fill all the worker slots and leave everyone else on the
instance staring at a queue.

- **Status:** 📋 Planned (moved to current sprint on 2026-07-25)
- **Priority:** P2 — the fair-use cap that makes a shared instance usable by
  more than one person at a time. Primary use case is an **organization
  self-hosting for its team**: several people share one box and no single
  person should be able to monopolize it. The hosted paid tier (US-022) is a
  *later* consumer of the same mechanism, not the reason it exists.
- **Estimate:** ~half a day to a day
- **Depends on:** US-021 (real users — until then every run belongs to the one
  seeded operator, so any per-user cap is a no-op), US-027 (the queued state
  this reports through). **Not** US-022 — this ships as an env-gated self-host
  feature; plan-driven caps are a later refinement (see "Later").

## Background

`MAX_CONCURRENT_SESSIONS=4` is a **global** ceiling on one VPS, and the queue
behind it is strict FIFO (`runs.js:305`). Nothing is per-user. Today that is
correct — `createRun()` stamps every run with `getOperatorUserId()`
(`runs.js:144`), a single seeded operator. The moment US-021 admits real
users — whether an org's team on a self-hosted box or subscribers on the
hosted one — one person triggering a 12-test module takes all four slots and
puts everyone else behind twelve runs.

**Off by default, so self-host stays exactly as it is.** With the cap env
unset, behaviour is byte-for-byte today's — one global queue, no per-user
accounting. An org that wants the cap sets one env var; a solo self-hoster
never touches it. Same gating shape as `STRIPE_*`, but this one is not tied to
billing at all.

## Design

1. **`MAX_CONCURRENT_PER_USER` in `config.js`, unset = off.** Default is unset.
   Read at import time like every other env. One instance-wide number: every
   user on the box gets the same cap. Resolve it through a function
   (`getUserConcurrencyCap(userId)`) rather than reading the constant at the
   call site — that keeps the door open for a later per-plan lookup (US-022)
   without threading a new argument through the run engine when it lands.
2. **Cap counts running + queued, not just running.** Capping only in-flight
   runs lets a user park twenty in the queue and win the FIFO anyway.
3. **Reject over the cap, don't queue.** `POST /api/runs` returns **429** with
   a message naming the cap ("you already have 2 runs in flight — wait for one
   to finish"). Queueing silently would make the wait unbounded and make
   US-027's position number meaningless. Batch endpoints (module/suite runs)
   are the awkward case: a 12-test module against a cap of 2 must either
   partially accept or reject wholesale — **decide before implementing**, and
   whichever way, the response has to say what did and didn't start.
4. **Fair-share dequeue.** `startNext()` becomes "next queued run whose user
   is under their cap" instead of `queue.shift()`. Without this the cap is
   only enforced at submit time and a user who queued early still drains the
   worker in order. Keep it a linear scan over the queue — the queue is small
   and this is not the place for a scheduler.
5. **UI.** The 429 needs to render as its own message, not the generic error
   banner — this is a "wait a moment", not a failure. It sits next to US-027's
   queued state and should read as the same family of copy.

## Decisions to make while implementing

- **What the cap actually is.** 2 concurrent per user against a global 4 means
  two users saturate the box; 1 is harsh for anyone running a module. This
  wants a number picked against the real plan price and the VPS size, not
  guessed here.
- **Does the operator get a cap?** The seeded operator and ordinary users share
  the same code path. Simplest answer: the cap is one env number applied to
  every user including the operator; unset = no cap, which keeps a solo
  self-hoster untouched by construction. If an org wants the operator exempt,
  that is a later refinement, not v1.
- **Scheduled runs (US-010) fire in bursts** and will hit this cap without a
  human watching. A 429 to a scheduler must not silently drop the run — decide
  whether schedules bypass the cap, retry, or surface a skipped-run record.
- **Per-user accounting is in-memory** today (`active`, `queue` in
  `runs.js`), which is fine for one worker and wrong for US-015's fleet. Don't
  build a distributed counter here; note the boundary.

## Acceptance criteria

- [ ] With `MAX_CONCURRENT_PER_USER` unset, behaviour is byte-for-byte today's:
      one global queue, no per-user limit, self-host untouched
- [ ] With it set, a user at their cap gets 429 with a message naming the cap,
      while another user's run starts normally
- [ ] Queued runs count toward the cap, not just running ones
- [ ] A user at their cap does not block a second user's queued run from
      starting when a slot frees
- [ ] Batch (module/suite) runs over the cap behave as decided above and the
      response says what started
- [ ] The UI shows the 429 as a wait, not as a run failure
- [ ] `cd server && npm test` covers accept / 429 / fair-share dequeue;
      `npm run check` clean

## Later

- **Per-plan caps (US-022).** When the hosted paid tier exists, different plans
  may buy different caps. `getUserConcurrencyCap(userId)` becomes a lookup on
  the user's subscription instead of returning the one env number — the reason
  step 1 resolves the cap through a function rather than a bare constant.
- **Horizontal scaling (US-015).** Scaling to ~100 concurrent moves the queue
  out of one process; the per-user cap then has to be enforced across workers,
  which is a shared-state problem this story deliberately does not solve.
