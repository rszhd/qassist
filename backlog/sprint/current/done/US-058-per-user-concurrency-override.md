# US-058 — Raise one user's concurrency cap without raising everyone's

**As the** operator of an instance, **I want** to set a concurrent-run cap on a
*specific* account, **so that** one team (or one paying customer, or my own
smoke-test account) can be given more or less of the box than the instance
default without changing what everyone else gets.

- **Status:** ✅ Shipped (2026-07-27)
- **Priority:** P2, pulled into the current sprint on 2026-07-27 — the missing
  operator lever. US-028 shipped the cap deliberately as *one env number for
  everyone including the operator*, and said so; this is the refinement it
  named. It sits with US-056 because production is what makes it real: that box
  is sized to a budget, so the number is a rationing decision, and today it can
  only be made for the whole instance at once.
- **Estimate:** ~half a day
- **Depends on:** US-028 (the cap, the fair-share dequeue and the seam this
  fills), US-021 (real users to differentiate between), US-009 (the `users` row
  the override hangs on). **Not** US-022 — a plan-driven cap is one *consumer*
  of this (see "Later"), not the reason it exists; a self-hosting org has the
  same need with no billing configured at all.

## Background

`getUserConcurrencyCap(userId)` (`server/src/runs.js:82`) takes a user id and
throws it away — `void userId`, then return `MAX_CONCURRENT_PER_USER`. That is
not an oversight: it is US-028's v1, pinned as decision **D6** in
`concurrency-cap.test.js:117` ("returns the env number, per user — v1 ignores
the id"), and the function exists at all so a later per-user lookup could land
without threading a new argument through the run engine. This story is that
lookup.

Nothing else in the system carries a per-user limit. `users` (`001_init.sql`)
holds email, timestamps and the encrypted BYOK key. So today the only lever is
`MAX_CONCURRENT_PER_USER` plus a restart, and it moves every account on the box
at once — including the direction that matters most in practice, *down*: an
operator who wants to throttle one abusive account has to throttle everyone.

## Design

1. **`users.max_concurrent_runs`, nullable int** (migration `012_*.sql`). Null =
   no override, which is the state every existing row is in — the column adds
   nothing to a self-host that never sets it.
2. **One resolution order, in one place.** `getUserConcurrencyCap` returns the
   override, else `MAX_CONCURRENT_PER_USER`, else null (uncapped). Nothing else
   reads the constant; that is already true and must stay true.
3. **The lookup has to be synchronous, and that is a constraint, not a
   preference.** `canStart` (`runs.js:108`) and the fair-share scan inside
   `startNext` (`runs.js:744`) both run on every slot release and are sync;
   `createRun` (`runs.js:264`) is sync too. None of them can await a query. So
   the override is served from an in-memory `Map<userId, cap>` in `runs.js`,
   loaded at boot and written through by whatever sets the value. A cache miss
   falls back to the env number rather than blocking — a missing override is
   indistinguishable from no override, which is the safe direction.
4. **`startNext`'s branch has to stop asking the wrong question.** It currently
   picks the plain FIFO drain when the module-level `MAX_CONCURRENT_PER_USER ==
   null` (`runs.js:735`). With overrides that test is wrong in the exact case
   this story exists for: an override on a box whose env is unset would be
   silently ignored, cap and all. It becomes "is any cap in force" — and when
   nothing is capped anywhere it must still collapse to byte-for-byte FIFO,
   which is what `concurrency-off.test.js` guards.
5. **Both counting sites, or neither.** Admission counts running **+ queued**
   (`runs.js:275`); the start-gate and dequeue count **running only**
   (`runs.js:97`). That asymmetry is load-bearing — US-028's register row spells
   out what breaks each way. An override that reaches one site and not the other
   lets a raised-cap user park runs in the queue and beat the FIFO.

## Decisions to make while implementing

- **How the operator writes it.** Three shapes: a documented `psql` UPDATE, a
  small server-side script, or an authenticated endpoint. The cache in step 3
  decides more of this than it looks: a hand-written UPDATE is invisible until
  the next restart, so if the answer is "document some SQL", the story owes
  either a reload trigger or an honest line in `DEPLOY.md` saying a restart is
  part of the procedure. An endpoint avoids that and costs an admin concept we
  do not have — `BILLING_EXEMPT_EMAILS` is the closest thing to a staff list and
  it is an env var, not a role.
- **The alternative to caching: stamp the cap on the run.** Resolve once in the
  route (async, already has the user) and pass it in `createRun`'s fields; the
  run then carries its own cap and every later gate reads `run.cap`. No cache,
  no invalidation, and a queued run keeps the cap it was admitted under — which
  is arguably more correct than having a mid-queue override change the rules.
  The cost is a new argument at three `createRun` call sites plus the scheduler
  path, i.e. exactly what US-028's docstring set out to avoid. **Recommend the
  cache**, but this is a real fork and it should be settled before the first
  assertion is written, because the two produce different test surfaces.
- **Does an override raise past `MAX_CONCURRENT_SESSIONS`?** A per-user cap
  above the global one is meaningless (the global always wins in `canStart`) but
  not harmful. Decide whether to reject it at write time or let it be a no-op —
  rejecting is friendlier, accepting keeps one truth in one gate.
- **Zero.** `max_concurrent_runs = 0` reads naturally as "this account may not
  run", which is a *suspension* feature wearing a capacity feature's clothes. If
  it is allowed, the 429 copy has to say something other than "wait for one to
  finish". Simplest v1: constrain the column to `> 0` and leave suspension to
  its own story.

## Assertion-first

Per-user concurrency already has a row in
[`correctness-critical.md`](../../../correctness-critical.md), and this story changes
three of the four surfaces that row names (`canStart`, `startNext`'s fair-share,
`createRun` admission). So the assertions are written and reviewed **before** the
implementation, and the existing row is updated rather than a second one added.
The three existing files are the starting point, not a template to copy:
`concurrency-cap.test.js` (whose D6 this story deliberately breaks — that
assertion is *meant* to change, and the commit says so), `concurrency-fairshare.test.js`
and `concurrency-off.test.js`.

## Acceptance criteria

- [x] With no overrides set and `MAX_CONCURRENT_PER_USER` unset, behaviour is
      byte-for-byte today's: one global FIFO queue, no per-user accounting
- [x] With no overrides set and the env set, behaviour is byte-for-byte US-028's
- [x] An override **raises** one user past the env cap while every other account
      stays on the env number
- [x] An override **lowers** one user below the env cap, and their runs are
      refused/queued at the lower number
- [x] An override with the env **unset** is enforced — the FIFO fast path does
      not swallow it
- [x] The override is honoured at admission (running + queued), at the start
      gate and at the fair-share dequeue, not at one of the three
- [x] A user at their overridden cap does not block another user's queued run
      from starting when a slot frees
- [x] The 429 message names the *effective* cap, not the env one
- [x] `cd server && npm test` and `npm run check` clean; the `correctness-critical.md`
      row is updated in the same commit

## Results

Shipped 2026-07-27. 405/405 server tests green (20 of them new), `npm run check`
clean, both against real Postgres as well as pg-mem.

**The cache won the fork, and for a reason the story did not have.** Stamping
the cap on the run reads more correct — a queued run keeping the cap it was
admitted under — right up until you notice which direction this lever is
actually pulled in. The case it exists for is throttling one account *down*, and
a stamp means the burst that provoked the throttle is exactly the burst the
throttle cannot reach. Written down here because "the queued run keeps its own
cap" will look like the better design again the next time someone reads it.

**The "invisible until restart" problem the story flagged did not need to be
accepted.** It offered two ways out — a reload trigger, or an honest line in
`DEPLOY.md` — and took the second as likely. The third was cheaper than either:
the run-start paths re-read *the caller's own* override before admission, so a
write from the script's separate process lands on that account's next submit. A
restart was never really available anyway; it kills every run in flight, which
on the box this story is about is the thing you were trying to protect.

**Zero and the above-global case both stopped being preference questions once
looked at.** Rejecting a cap above `MAX_CONCURRENT_SESSIONS` at write time
cannot work: the check would have to live in a database constraint, and a
constraint cannot see an env var. So it is accepted, never binds, and the script
warns — one truth in one gate, and the "friendlier" option was not on the table.

**pg-mem cannot hold this feature up in either direction, and found that out by
breaking.** It fails to parse an inline `check` inside `alter table add column`
against this schema at all ("Corrupted alias" — it takes down *every* test that
migrates in memory, not just the new ones), and having been split into the named
two-statement form it parses fine and then does not enforce the constraint. So
`> 0` is only ever provable against a real server, which is where the assertion
went. A bare-table probe said the inline form was fine; the real schema said
otherwise. Probe against the schema you actually have.

**The middleware was deliberately not fused the way US-054's was.** Activation
was folded into the billing gate so "one of the seven start paths missed it"
could not happen by omission. This one is its own `withUserCap` on the six
run-start routes plus the scheduler, because the failure is not the same shape:
a missed billing gate is free service, a missed cap refresh is a stale number
that is still a cap. Different price, different rule.

**What is now true that US-028 promised:** `getUserConcurrencyCap(userId)` no
longer throws the id away, and it did so without a new argument at any
`createRun` call site — which is the whole reason the seam was built as a
function in the first place. The one behavioural change outside the override
path is `startNext` branching on `anyCapInForce()` instead of the env constant,
and `concurrency-override-off.test.js` pins that the eligibility scan drains
uncapped users in byte-for-byte FIFO order — asserted on drain *order*, since
counts cannot see the difference.

## Later

- **Plan-driven caps (US-022).** With this column in place, "the Team plan buys
  4 concurrent" is a write to it at subscription time rather than a second
  mechanism — the resolution order already answers what happens when a plan and
  a manual override disagree (whichever wrote last), which is worth revisiting
  deliberately rather than inheriting.
- **Horizontal scaling (US-015).** The accounting stays in one process's memory.
  Enforcing any per-user cap across a fleet is that story's shared-state
  problem, and this one does not make it harder.
