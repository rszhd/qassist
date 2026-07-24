# US-036 — Demo sandbox: the whole app, per-visitor, on fake data

**As a** visitor who has not signed up, **I want** to walk through the entire
product — history, projects, suites, schedules, a run playing out live —
against realistic data I can click and edit freely, **so that** I understand
what I'd be paying for before I sign up; and **as the** operator, **I want**
every visitor isolated and self-cleaning so one sandbox never costs a real
browser slot, an API token, or another visitor's session.

- **Status:** 🚧 In progress. Supersedes US-033. Backend steps 1–4 shipped
  (2026-07-24): the `demo` auth mode + config + `007_demo_tenants.sql` migration;
  per-visitor provision+seed (`demoTenant.js`, `POST /api/demo/session`); the
  run interceptor (`runs.js` `createRun`→`startReplay`, no-cost pinned in
  `demo-interceptor.test.js`); the reaper (`demoReaper.js`, completeness pinned
  in `demo-reaper-postgres.test.js`). **Remaining: step 5** (per-IP rate limit +
  total-tenant cap on the bootstrap — `liveTenantCount()`/config already in
  place) **and step 6** (frontend banner/expiry/CTA + US-033 shell removal).
  Deviation from the plan, agreed with maintainer: seed is a JS seeder, not
  `demo/seed.sql`; the interceptor's no-cost assertion runs on pg-mem (it is
  DB-independent), only the reaper needs real Postgres.
- **Priority:** P2 — same conversion slot as US-033, but a full product tour
  instead of one clip.
- **Estimate:** ~3–4 days
- **Supersedes:** [US-033](US-033-live-demo-replay.md) — keeps its `replayDemo`
  engine and fixtures, replaces its shell. See "What US-033 leaves behind".
- **Depends on:** US-021 (session-cookie + multi-tenant auth this builds a
  third mode onto), US-006 + US-026 (the recordings/steps the replay plays),
  US-033's engine (`server/src/demo.js`).

## Background

US-033 put the demo *inside the production app*: one unauthenticated `/demo`
route replaying a canned run in the Run stage. Everything hard about it —
no DB row (or it pollutes History and pass-rate), an unauthenticated surface
carved before token handling, read-only everything — was a consequence of the
demo living inside the real, single deployment. And the payoff was thin: the
visitor watched one clip and never saw History, Projects, Suites, Schedules or
Settings.

The realisation that redirects the story: **those constraints exist only
because the demo shares the prod app and its DB.** Give the demo its own
deployment with its own throwaible data and they evaporate. And the schema is
already built for it — every table is `user_id … references users(id) on
delete cascade` (`001_init.sql`, `002_projects_modules.sql`,
`003_schedules.sql`). So the demo is not a special surface bolted onto the app;
it is **the real app, run as a deployment where every visitor is a fresh,
short-lived tenant, and every run is a replay.**

## Design

1. **A separate deployment (`demo.qassist.run`), one new auth mode: `demo`.**
   Beside single-token (`WORKER_API_TOKEN`) and magic-link (`multi`), a third
   `AUTH_MODE=demo`. No login wall. The **first** request from a visitor with
   no session mints an anonymous `users` row, drops the same HTTP-only session
   cookie US-021 already issues, and seeds that user (below). Every subsequent
   API/WS call authenticates as that tenant through the *existing* cookie path
   — no bearer token handed to the browser, no special demo query param on the
   socket. From the app's point of view the visitor is just a logged-in user
   who happens to expire.

2. **Per-visitor ephemeral tenant.** A shared demo account cannot survive
   concurrency — visitor B deletes the test visitor A is mid-edit on. So each
   new visitor gets their **own** user and their **own** copy of the seed data.
   Isolation is free: the schema already scopes every row by `user_id`, so a
   tenant only ever sees and mutates their own rows. They can create, edit,
   delete, run — it's a sandbox — and it touches no one else.

3. **Seed = rows, not files.** Seeding clones a fixed fake dataset (a few
   tests, a project + module, a suite, a schedule, and some finished runs so
   History isn't empty) as rows owned by the new user. It does **not** copy
   artifacts: recordings, PDFs and step PNGs stay **shared, read-only fixtures**
   under `demo/` (US-033's `register-account/`, `discount-broken/`, plus new
   ones), referenced by every tenant. A seed is a handful of `INSERT`s — cheap
   enough to do inline on first request.

4. **Every run is a replay — a global interceptor, not a special endpoint.**
   On a `demo`-mode deployment, `runs.trigger` short-circuits: instead of
   spawning `run_agent.py`, it drives US-033's `replayDemo` over the normal WS
   relay, picking the fixture that matches the test (or a default). This means a
   real `runs` row **is** written, owned by the visitor, and shows up in *their*
   History and *their* pass-rate — which is the point; it looks real — but it
   spawns no Python, takes no queue slot, and makes no LLM call. The
   no-cost assertion from US-033 now guards the whole run engine, not one route.

5. **A reaper deletes expired tenants — mind the one non-cascade.** A cron
   deletes demo users past their TTL. Cascade removes their tests, projects,
   suites and schedules. **But `runs.user_id` is `on delete set null`
   (`001_init.sql:102`), not cascade** — a naive user delete orphans their run
   rows forever and leaks their artifact dirs. So the reaper must, per expiring
   user: delete their run rows and `rm -rf` their `runs/<id>/` artifact dirs
   *explicitly*, then delete the user (cascading the rest). TTL is
   `created_at + DEMO_TTL` (default 1h) for simplicity; a `last_seen` bump on
   activity is the upgrade if cutting an active visitor off proves annoying.

6. **A ceiling, because it's writable and public.** Rate-limit tenant creation
   per IP, and cap total live demo tenants (reject/queue past the cap). An idle
   tenant is a few rows plus a cookie and no real run ever fires, so the cost of
   accumulation is small and the reaper bounds it — but a public, writable,
   auto-provisioning endpoint needs a hard cap regardless.

7. **Honesty is still the bar.** A full app streaming fabricated verdicts is a
   fabricated record unless it says so. The whole deployment reads as a demo: a
   persistent `Demo — simulated results` banner, the same "recorded session,
   not a live run" note on the stage, and no claim that the agent is reachable.
   The session's expiry is stated ("this sandbox resets in ~1h"). The signup
   CTA is present throughout, not just at a replay's end.

## What US-033 leaves behind

**Keep** (the engine is the reason this supersedes rather than restarts):
- `server/src/demo.js` — `replayDemo` + fixture reader, now driven by the
  interceptor (4) instead of a demo route.
- `demo/*` fixtures + `server/test/fixtures/demo/*`.
- `.env.example` / `config.js` demo vars (`DEMO_SPEED`; `DEMO_MODE` folds into
  `AUTH_MODE=demo` + `DEMO_TTL`).

**Remove** (superseded shell — one clean deletion commit so the diff shows what
the redirect dropped):
- `frontend/src/DemoView.jsx` — visitors use the real `RunView`.
- `App.jsx` `/demo` route + the public-render-before-login-wall; `TopBar.jsx`
  Demo nav entry — replaced by `demo` auth mode.
- `server/src/server.js` `/ws?demo=<slug>` unauthenticated branch — replaced by
  cookie auth.
- `routes/demo.js` cards endpoint + the `readOnly` `TestDialog` mode in
  `RunDialogs.jsx` — visitors get the real, editable app.

## Correctness-critical surfaces

Two pieces belong on the assertion-first list (`correctness-critical.md`) — the
maintainer writes the assertion first:
- **The run interceptor's no-cost guarantee** — in `demo` mode, *no* trigger
  path (UI, suite, module, schedule, retry) spawns Python, claims a slot, or
  calls an LLM. A leak here spends the operator's key on a stranger.
- **The reaper's completeness** — an expired tenant leaves zero rows in *any*
  table and zero artifact dirs on disk, given the `runs` set-null gotcha (5).
  A leak here accumulates unbounded.

## Acceptance criteria

- [ ] With `AUTH_MODE` ≠ `demo`, none of this exists: no auto-provisioning, no
      seed, no interceptor — self-host and the magic-link app are byte-for-byte
      unchanged.
- [ ] In `demo` mode, a visitor with no cookie lands, is silently provisioned a
      seeded tenant, and can browse History, Projects, Suites, Schedules and
      Settings populated with fake data.
- [ ] The visitor can create, edit, delete and run, and every action is scoped
      to their tenant — a second concurrent visitor sees none of it.
- [ ] Pressing Run replays a fixture in the real Run stage, writes a run row in
      *their* History, and spawns no Python, no queue slot, no LLM call
      (asserted).
- [ ] After `DEMO_TTL`, the reaper leaves zero rows for that user in every
      table and zero artifact dirs on disk (asserted, incl. the `runs`
      set-null case).
- [ ] Tenant creation is rate-limited per IP and total live tenants are capped.
- [ ] Every screen is labelled a simulated demo and states the session expiry;
      the signup CTA is reachable throughout.
- [ ] `cd server && npm test` covers: mode-off no-op, provision+seed, tenant
      isolation, the interceptor no-cost assertion, and the reaper completeness
      assertion; `npm run check` clean. Interceptor + reaper get a real-Postgres
      test (pg-mem won't model the cascade/set-null correctly).

## Decisions to make while implementing

- **Seed data: SQL fixture vs. a seed module?** A checked-in `demo/seed.sql`
  templated per `user_id` vs. a JS seeder reusing the route handlers. The SQL
  is simpler and testable; the JS stays in sync with validation. Lean SQL.
- **Provision on first HTML load vs. first API call?** A tiny bootstrap
  endpoint the SPA hits on mount is explicit and lets the cap reject cleanly;
  lazy-on-first-API is fewer moving parts but scatters the mint across every
  handler. Prefer an explicit bootstrap.
- **`last_seen` now or later?** Absolute TTL ships first; add activity-bump only
  if hard cutoffs annoy real visitors.
- **Which fixtures, and does the seed's test list map 1:1 to them?** A run
  should replay a fixture that plausibly matches the test the visitor pressed
  Run on. Needs at least one pass and one real fail (US-033's outstanding real
  fail capture carries over as a dependency here).
