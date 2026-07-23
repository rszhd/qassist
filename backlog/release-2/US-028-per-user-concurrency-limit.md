# US-028 — Per-user concurrent run limit (hosted plans)

**As the** operator of the hosted instance, **I want** each paying user capped
to a few concurrent runs, **so that** one user cannot fill all four worker
slots and leave every other subscriber staring at a queue.

- **Status:** 📋 Planned (moved to Release 2 on 2026-07-23 with the rest of the
  hosted tier)
- **Priority:** P2 (Release 2, hosted only) — the fair-use half of US-022's
  open "concurrency/fair-use caps per user" item. **The one to cut** if launch
  scope tightens: it is not required to take payment, only to keep the first
  handful of subscribers from starving each other.
- **Estimate:** ~half a day to a day
- **Depends on:** US-021 (real users — until then every run belongs to the one
  seeded operator, so any per-user cap is a no-op), US-022 (plans), US-027
  (the queued state this reports through)

## Background

`MAX_CONCURRENT_SESSIONS=4` is a **global** ceiling on one VPS, and the queue
behind it is strict FIFO (`runs.js:305`). Nothing is per-user. Today that is
correct — `createRun()` stamps every run with `getOperatorUserId()`
(`runs.js:144`), a single seeded operator. The moment US-021 admits real
users, one person triggering a 12-test module takes all four slots and puts
everyone else behind twelve runs.

US-022 already names this ("a simple constant is fine for v1; the VPS's
`MAX_CONCURRENT_SESSIONS=4` is the real global ceiling and oversubscription
risk to watch at launch"). This story is that item, split out so billing can
ship without it.

**Self-host is unaffected.** Per the design principles, self-host is always
free and ungated: with the cap env unset, behaviour is exactly what it is
today — one global queue, no per-user accounting. Same gating shape as
`STRIPE_*`.

## Design

1. **`MAX_CONCURRENT_PER_USER` in `config.js`, unset = off.** Self-host
   default is unset. Read at import time like every other env. One number for
   v1 (US-022 ships one plan); when plans multiply it becomes a lookup on the
   subscription, which is why the cap should be resolved through a function
   from the start rather than read as a constant at the call site.
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
- **Does the operator get a cap?** Self-host and the operator's own runs on
  the hosted box are the same code path. Simplest answer: the cap is per plan,
  and no plan = no cap, which keeps self-host untouched by construction.
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

US-015 (horizontal scaling to ~100 concurrent) moves the queue out of one
process; the per-user cap then has to be enforced across workers, which is a
shared-state problem this story deliberately does not solve.
