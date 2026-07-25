# US-039 — Every user brings their own key; the server holds none

**As the** operator of any QAssist instance, **I want** the agent to run only on
a key the *caller* supplied, **so that** standing the app up in front of other
people cannot spend my tokens — and so that "BYOK on every tier" is a property
of the code rather than a promise in a README.

- **Status:** ✅ Shipped 2026-07-26. Assertion-first as required
  (`resolveRunKey` is a listed correctness-critical surface): the specs —
  `server/test/byok-only.test.js` (refusals, multi-user), `byok-solo.test.js`
  (refusals, auth off), `byok-postgres.test.js` (the positive half — needs a
  real server, see below), `boot.test.js` (the two newly mandatory env vars)
  and a tightened `openai-key.test.js` — were written, reviewed (decisions
  `D1`–`D14` in their headers) and red before the implementation. All six
  acceptance criteria hold; the last one (key restored with no effect) is
  structural — every spec file runs with a live-looking `OPENAI_API_KEY` in the
  environment. **Deployed to staging 2026-07-26** as `v0.2.0`: with the old
  server key restored to the container env on purpose, `/api/health` carries no
  `agent_ready` and a run POST from the seeded tenant answered exactly
  `503 {"error":"no OpenAI key: add yours in Settings"}` — AC #6 observed on
  the real box, then the inert variable was re-blanked in `.env.staging`.
- **Priority:** P1 (current sprint) — staging is live and publicly registrable
  today, and the interim mitigation is a blank `OPENAI_API_KEY` in
  `.env.staging`, which silently disables its scheduler. That is a workaround
  standing in for this story.
- **Estimate:** ~3–4 h. Mostly deletion, but it crosses config, runs, scheduler,
  health, two routers, the Settings UI, `.env.example`, README and DEPLOY.
- **Depends on:** nothing. Supersedes the "cheap mitigation" note in
  [US-038](US-038-staging-environment.md) (line ~160).

## Why now

US-038 stood staging up and wrote the hole down rather than fixing it:

> signup *is* login, so staging accepts registrations from anyone who finds the
> hostname, and with `STRIPE_*` empty `requireEntitled` gates nothing — a
> stranger could register and spend the server's `OPENAI_API_KEY`.

The reasoning there was that Stripe test keys would close it, because the
billing gate sits in front of every run-start path. That is true and also the
wrong shape: it makes *not being robbed* contingent on billing being configured.
Self-host is always free (`CLAUDE.md`), so on the deployment that is most likely
to be shared with a team — a free, self-hosted, multi-user instance — there is
no gate at all and the operator's key is the default funding source for every
stranger.

The fallback made sense when there was exactly one user and one key, and the
`.env` key *was* that user's key. It stopped making sense the moment US-021
introduced real users and US-005 gave them somewhere to put their own.

## Approach: delete the server key, not gate it (decided 2026-07-25)

The narrower fix — keep `OPENAI_API_KEY` but skip the fallback when
`authEnabled()` — was considered and rejected. It leaves two ways to fund a run
and a rule about which applies when, and the rule is invisible at the moment
someone edits `.env`. One concept is better than two plus a condition.

So: **`OPENAI_API_KEY` is removed from the product.** A run's key is the
caller's, resolved as per-request > stored, and nothing else. `resolveRunKey`
keeps its precedence and loses its third tier.

This is only coherent because **auth-off mode already has a user row.** The
seeded operator (`db.js` `seedOperator`) owns everything created before auth
existed, and `currentUserId()` returns it whenever no request context is open —
its own docstring calls it "the sole user whenever auth is off". So the single
operator of a no-auth self-host can store an encrypted key exactly like a
multi-user tenant; the surfaces are merely gated shut today.

Two consequences follow, both accepted deliberately:

**1. `DATABASE_URL` becomes required — the legacy in-memory mode is removed.**
Without the control plane there is no `users` row and so nowhere for a key to
live. That mode's entire remaining value was "ad-hoc runs still work", which is
precisely what it can no longer do. It was also never a mode anyone chose: both
documented paths set `DATABASE_URL` for you (compose points at its own `db`,
`npm run dev` at the same container on :5433). In practice `db=off` meant *the
database failed to come up* — degrading silently to a half-app. Refusing to boot
is the better failure, and it is what `SESSION_SECRET` and auth already do.

**2. `KEY_ENCRYPTION_SECRET` becomes required.** Blank currently means "stored
keys are disabled — per-request BYOK and the server key still work." With the
server key gone, blank would mean the UI field 503s and the only way to run is
to hand-craft POST bodies. It joins `SESSION_SECRET` as a generate-once value,
with the same `openssl rand -hex 32` line in the quickstart. Auto-generating it
into the data volume was considered and rejected: it puts a secret outside
`.env`, and losing the volume would silently make every stored key
undecryptable.

## Details

- **`config.js`** — `OPENAI_API_KEY` deleted. `DATABASE_URL` and
  `KEY_ENCRYPTION_SECRET` join the boot preconditions in `server.js`.
- **`openaiKey.js`** — `resolveRunKey` drops to `requestKey || storedKey`, and
  its JSDoc stops promising a server fallback. **Correctness-critical.**
- **`routes/helpers.js`** — `requireAgentKey` refuses with 503 whenever neither
  key exists, and the message points at Settings rather than at `.env`. The
  `demoMode()` waiver stays: a demo deployment runs no agent (US-036).
- **`routes/account.js:16`** — the `authEnabled()` gate on the whole router
  goes; `requireDb` stays and is now always satisfied. The key becomes the
  operator's in auth-off mode via the existing `currentUserId()`.
- **`App.jsx`** — `<OpenaiKey />` renders outside the `multi`-only branch.
- **`runs.js`** — the `run.openai_api_key || OPENAI_API_KEY` fallback becomes
  `run.openai_api_key`. Containment is unchanged: still child-env only, never a
  column, event or `report_data.json` field.
- **`scheduler.js`** — stops refusing to start. Instead, a slot whose owner has
  no stored key is **skipped and logged**, not fired: firing it would burn a
  browser slot on a run guaranteed to die at the first LLM call, which is the
  same reasoning the old boot-time refusal used, applied per-schedule where it
  belongs.
- **health / UI** — `agent_ready` no longer describes the instance, because
  readiness is now per-user. Either drop it and let the Settings key state say
  it, or redefine it as "the calling user has a key". The `RunView` banner
  ("Add it to `.env` and restart") must not survive either way.
- **Docs** — `.env.example`, README's env table and in-memory-mode notes,
  `DEPLOY.md`, and US-038's mitigation paragraph.

## What writing the assertions surfaced (2026-07-25)

Three things the plan above did not account for. The first is a live defect the
story would otherwise have shipped:

**1. Deleting the fallback from `runs.js` is not enough.** `startRun` spawns the
agent with `env: { ...process.env, OPENAI_API_KEY: run.openai_api_key || … }`.
Changing that expression to `run.openai_api_key` alone leaves the spread in
place, so a null key means the child inherits the *server's own* ambient
`OPENAI_API_KEY` — the fallback survives at the exact layer where the money is
spent, and every assertion above it still passes. Confirmed against today's
code: the child receives the ambient key. The key must be set explicitly and
removed when there is none.

**2. pg-mem cannot store an encrypted key**, so the positive half of the claim
needs a real Postgres. It round-trips `bytea` through a string: a 72-byte
AES-GCM ciphertext comes back 120 bytes with UTF-8 replacement characters, and
`decryptSecret` throws. Nothing on pg-mem can assert on a *stored* key, which
means an implementation could pass a refusals-only test file while being unable
to run a keyed user at all. Hence the split: refusals on pg-mem
(`byok-only`/`byok-solo`), everything that needs a key to decrypt on a real
server (`byok-postgres`). Same class of discovery as US-022's ledger claim —
found by writing the assertion first, and not findable any other way.

**3. The ripple through the existing suite was wider than "mostly deletion" —
and narrower than feared.** Every test that started a run over HTTP funded it
with the server key. The way out of the pg-mem trap for *them* (not for the
spec files): the corruption is in the bytea **parameter** path only, so a
registered `decode(hex)` function returns a Buffer that pg-mem stores intact —
`test/helpers/stored-key.js`. Harnesses with a DB now seed their user a stored
key (`api`, the control-plane helper, `billing-gate`, `billing-off`, `notify`,
`scheduler.test.js` — whose schedules have no request to carry a key); DB-less
files pass a per-request key (`concurrency-cap-route`, `verdict`).
`first-run.test.js` changed subject entirely: with `DATABASE_URL` mandatory, "a
fresh clone with no `.env`" no longer boots, so it now pins the documented
minimum config instead. All meant-to-change, and the commit says which and why.
One true regression caught red: the scheduler's keyless skip had to be waived
in demo mode (`demo-interceptor.test.js` failed) — a demo run is a replay, so
there is no LLM call for a key to fund, same waiver as `requireAgentKey`.

## Acceptance criteria

- [ ] No `OPENAI_API_KEY` anywhere in `server/`, `frontend/`, `.env.example`,
      README or DEPLOY, and `grep -ri openai_api_key` returns only the
      per-request body field and the agent's own child env
- [ ] A user with no stored key gets 503 from **every** run-start path
      (ad-hoc, saved test, module, suite, retry, CI/API), with a message naming
      Settings — no row created, no slot claimed, no Python spawned
- [ ] A no-auth self-host (`AUTH_ENABLED` unset) can store a key in Settings and
      run, the key landing on the seeded operator
- [ ] A schedule whose owner has no key is skipped with a log line and does not
      claim a slot; a schedule whose owner has one still fires
- [ ] The server refuses to boot without `DATABASE_URL` or
      `KEY_ENCRYPTION_SECRET`, naming the missing one
- [ ] Staging can have a key restored to `.env.staging` with no effect — proving
      the fallback is gone rather than merely unconfigured
