# US-040 — The demo sandbox, deployed at `demo.qassist.run`

**As a** visitor who has never heard of us, **I want** to click "Try the demo"
and be inside the working product in a second, with no signup and no key, **so
that** I can decide whether to sign up; and **as the** operator, **I want** that
surface to be a third isolated stack that can neither reach production's data
nor spend anything.

- **Status:** 🟢 **Live at `https://demo.qassist.run`** (2026-07-26) on
  `ghcr.io/rszhd/qassist:0.2.1` — the tag cut for this, since `v0.2.0` predates
  the fixture `COPY` and would have booted healthy and failed every run. Ten of
  eleven criteria closed on the box, including the two only a deployment can
  prove: the reaper's disk half, and the per-visitor throttle (which a passing
  stranger proved for us — see below).

  **One thing open, and it is the point of the story: the CTA is dead.**
  `DEMO_CTA_URL=https://qassist.run` and that apex has no DNS record, so the
  banner renders a "Sign up free" button that leads nowhere. The conversion
  surface is live with its conversion path broken, which argues for not
  publicising the demo until it points somewhere real. It is a one-line `.env`
  change, no rebuild — see the CTA criterion below.
- **Priority:** P1 — [US-036](done/US-036-demo-sandbox.md) shipped the whole
  sandbox on 2026-07-24 and **nothing runs it**. `AUTH_MODE=demo` is set on no
  deployment, so the provisioner, the seeder, the interceptor and the reaper are
  dead code in production today. This story is the difference between built and
  live, and it is the cheapest conversion surface we own.
- **Estimate:** ~2 h on the box, plus one small repo change (the image is
  missing the fixtures — see *What the repo still owes*)
- **Depends on:** [US-036](done/US-036-demo-sandbox.md) (the sandbox itself),
  [US-007](US-007-https-reverse-proxy.md) (the proxy and the overlay this
  reuses), [US-038](US-038-staging-environment.md) (which proved a second stack
  from the same two files; this is the third),
  [US-032](US-032-release-pipeline-and-image.md) (the tag it runs)

## The hostname: `demo.qassist.run`

Settled, not a coin flip. US-036 wrote `demo.qassist.run` into the story, and
the shipped code agrees with it everywhere a name is baked in: `AUTH_MODE=demo`,
the six `DEMO_*` variables, `POST /api/demo/session`, `demoTenant.js`,
`demoReaper.js`, the `demo/<slug>/` fixture directories, `DemoBanner.jsx`.
Renaming the deployment to `sandbox.` would leave every one of those saying
"demo" and buy nothing.

The two words also aren't synonyms here. **Demo** is what the visitor is looking
for — it is the word on the button, in the nav, and in the search query. **Sandbox**
describes the mechanism they discover once inside: writable, per-visitor,
throwaway. That is the banner's job, not the URL's.

`sandbox.qassist.run` as a redirect to `demo.` is a one-line Traefik router if
anyone ever types it. Not part of this story; a second hostname is a second
certificate, and there is no evidence anyone wants it.

## Approach: a third compose project on the same box

Exactly US-038's shape, one more time — which is the point. If the demo needs a
branch in `docker-compose.prod.yml`, the overlay is wrong:

```sh
export ENV_FILE=.env.demo
docker compose -p qassist-demo \
  -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file "$ENV_FILE" up -d
```

`-p qassist-demo` gives it its own network, its own `db`, its own `pgdata`, its
own `runs-demo/` and — through `${COMPOSE_PROJECT_NAME}` in the labels — its own
Traefik router, middleware and Let's Encrypt certificate on the shared proxy.
The `export` on its own line is load-bearing for the reason US-038 documents.

**It is the cheapest of the three stacks to host.** A demo run spawns no
Chromium, claims no queue slot and makes no LLM call (`runs.js` `createRun`
short-circuits to `startReplay` before the concurrency branch), so the marginal
cost of a visitor is a few rows, a cookie, and a static file being streamed.
What has to be bounded is tenants, and US-036 already bounds them.

## The config that must differ

| Setting | Production | Demo |
|---|---|---|
| `APP_HOST` / `PUBLIC_BASE_URL` | `app.qassist.run` | `demo.qassist.run` |
| `AUTH_MODE` | unset | **`demo`** — the whole story in one variable |
| `AUTH_ENABLED` | `1` | unset. Demo mode is cookie tenants without a login wall; `authEnabled()` false is also what makes the billing gate a no-op |
| `SESSION_SECRET` | production's | **distinct**, and **required** — `demoMode()` ANDs it in, so an unset secret silently boots the magic-link app on the demo hostname |
| `RESEND_API_KEY` | set | **unset.** A visitor can enable failure emails on their sandbox project and type a stranger's address; `mailEnabled()` false is what stops a public writable deployment from mailing PDFs on request. Not `MAIL_DEV_CONSOLE` — no reason to compose mail at all |
| `STRIPE_*` | live keys | **empty** (all three), so billing is off and the sandbox never shows a paywall to someone who hasn't signed up |
| `DEMO_CTA_URL` | — | the signup page the banner points at — the whole conversion path |
| `DEMO_TTL_SECONDS` | — | `3600` to start. Absolute, no `last_seen` bump (US-036's deferred upgrade) |
| `DEMO_MAX_TENANTS` / `DEMO_IP_MAX` | — | defaults (200 / 5 per hour) unless the box says otherwise |
| `RUNS_DIR` | `./runs` | `./runs-demo` |
| `ROBOTS_TAG` | `all` | **`all`** — unlike staging. This one is *meant* to be found; it is the only public surface that shows the product working |
| `MAX_CONCURRENT_SESSIONS` | the box's cap | `1`. Nothing here consumes a slot; a non-zero value is just honesty about the box |
| `KEY_ENCRYPTION_SECRET` | production's | distinct. Required at boot since US-039, and a demo tenant must never be able to decrypt anything of production's |
| `OPENAI_API_KEY` | — | **not a variable any more** (US-039). `requireAgentKey` waives the gate in demo mode, which is what lets a keyless deployment run |

## What the repo still owes

**The image has no fixtures.** ✅ Done 2026-07-26. `Dockerfile` copied `agent/`,
`db/`, `server/` and the built frontend — not `demo/`. `DEMO_DIR` defaults to
`/app/demo`, so on a published tag the fixture reader had nothing to read and
every demo run failed in a way no test catches (the suite runs from a checkout,
where the directory is there). Fixed with one `COPY demo/ /app/demo/` line —
additive and useful to a self-hoster who wants their own sandbox. It needs a
tag, so it reaches the box with the next release, not before. Checked while in
there: both fixtures are 284 KB total against a Chromium-carrying image, and
`.dockerignore` never excluded them (proven by building the context against a
busybox stub rather than waiting 20 minutes for the real one).

**`req.ip` is Traefik's, so the per-IP mint throttle is a global one.** Express
`trust proxy` is not set anywhere, so behind the proxy every request's `req.ip`
is the Traefik container's address. `routes/demoSession.js` keys `DEMO_IP_MAX`
on that value — meaning the demo would mint **5 tenants an hour in total**, and
answer every visitor after that with "too many sandboxes from this address".
That is the story's own purpose failing on the sixth visitor of the hour.

No test catches it, and the test that *looks* like it would is the reason why:
`demo-ip-throttle.test.js` drives the app in-process, where every request really
does come from one address. It passes; the deployment is still broken.

✅ Fixed 2026-07-26. `app.set('trust proxy', TRUST_PROXY)`, gated on a
`TRUST_PROXY` env var **defaulting to off** — a plain `docker compose up`
self-host publishes 8080 directly, where honouring `X-Forwarded-For` would let
any client claim any address. A proxied deployment sets its hop count; the
overlay itself stays branchless, so this is an env value like `APP_HOST` and not
a second thing that knows which environment it is. `routes/auth.js`'s magic-link
limiter reads `req.ip` too, keyed on `email|ip`, so it degraded to per-email
rather than dangerously — same fix, no extra code.

`1` and `true` are deliberately different answers: one hop counts the address
the proxy vouched for, `true` counts whatever the client wrote. So numeric
strings stay numbers and `true` is only reachable by writing it out.

**Correctness-critical** (`backlog/correctness-critical.md`), and handled
assertion-first: `trust-proxy.test.js` (the parse) and
`demo-ip-throttle-proxy.test.js` (the throttle counting the right address) were
written before the implementation, and both were **confirmed to fail against
the shipped code** — the two proxy tests go red with the `app.set` line removed,
while the untrusted-default assertions stay green either way, which is the shape
that says the test is measuring the fix rather than agreeing with it.

`.env.demo.example` beside `.env.staging.example`, in the same shape: the diff
from production, not a second copy. ✅ Written 2026-07-26. `DEPLOY.md` gains a
**Demo** section next to Staging — same steps, and the table above.
✅ Written 2026-07-26, plus the four-project table and the DNS record.

## Acceptance criteria

- [x] The published image contains `demo/`, and `DEMO_DIR` resolves inside the
      container (`docker compose exec qassist ls /app/demo` lists both fixtures)
      — the `COPY` landed 2026-07-26 and the context was proven to carry both
      fixture dirs; the `exec` half was re-checked on the box against `0.2.1`
      the same day and lists `discount-broken` and `register-account`
- [x] A visitor is throttled by *their* address, not by Traefik's — the
      `TRUST_PROXY` fix above, without which `DEMO_IP_MAX` caps the whole
      deployment. **Proven on the box 2026-07-26, and the second network arrived
      on its own.** Within six minutes of the Let's Encrypt cert hitting the
      public CT logs, four tenants were minted from an address that was not
      mine. So the sequence through one Traefik container was: 2 mine, 4
      theirs, then 3 more mine — my sixth mint refused at exactly `DEMO_IP_MAX`
      while a stranger's succeeded in between. Under a deployment-wide bucket
      the seventh mint overall would have been refused and those visitors would
      have been turned away by *my* testing. That is the criterion, measured.

      The same run also shows the cap is not spoofable: `X-Forwarded-For`
      headers I wrote myself did **not** open new buckets (201, 201, then 429 on
      an address I claimed was fresh), because one hop counts the address the
      proxy vouched for. This is why `TRUST_PROXY=1` and not `true` — see above.

      Operational note for whoever announces this: a new public hostname is
      found through certificate transparency within minutes, and each scanner
      that executes the SPA burns a tenant. `DEMO_MAX_TENANTS=200` against a
      1 h TTL has the headroom, but the baseline is not zero.
- [x] `https://demo.qassist.run` serves the UI on its own Let's Encrypt
      certificate through the shared proxy, `http` redirects to `https`, and
      `printenv PUBLIC_BASE_URL` inside the container says `demo.qassist.run`
      (US-038's failure-that-looks-like-success check) — 2026-07-26. Cert
      `CN = demo.qassist.run`, issuer Let's Encrypt, expires 2026-10-23.
      The redirect is **301, not the 308 this line and US-038's claimed**;
      staging returns 301 too, so the deployments agree and the number in both
      stories was the guess. Traefik's `redirectScheme` with `permanent: true`
      is a 301 — nothing to fix but the docs
- [x] A visitor with no cookie lands and is inside a seeded tenant with no login
      wall: History, Projects, Suites, Schedules and Settings all populated
      (2026-07-26 — `POST /api/demo/session` 201s with an `expiresAt`, and all
      five collections come back populated on the cookie it sets)
- [x] Pressing Run streams a replay over the WebSocket through Traefik and
      writes a run into *their* history — and no Chromium, and no LLM call is
      made (2026-07-26). The WS upgrade through Traefik needs HTTP/1.1: over
      HTTP/2 the handshake headers are meaningless and Express 404s the path,
      which looks like a routing bug and isn't. On 1.1 it is `101 Switching
      Protocols` followed by the fixture's `recording`, five `step`s and
      `{"type":"end","status":"passed","demo":true}`. Process names inside the
      container during a live replay are exactly `sh` and `node` — no Chromium,
      no agent, so no key was ever needed. Artifacts are symlinks into
      `/app/demo` (2 runs = 12 KB) and `report.pdf` still serves, 79 KB, through
      the app. **`/api/health` no longer carries `agent_ready`** — US-039 removed
      it, so that clause of this criterion was stale when written
- [x] Two browsers (or one plus a private window) get two tenants that cannot
      see each other's tests or runs (2026-07-26 — two cookie jars, 4 tests /
      5 runs / 1 project each, **zero shared ids**, and a run started by one is
      absent from the other's history)
- [ ] The demo banner names the expiry and its CTA links to the real signup page
      — **half.** `POST /api/demo/session` returns the `expiresAt` the banner
      phrases, and `/api/health` carries `cta_url`, so the banner renders. But
      `DEMO_CTA_URL=https://qassist.run` and the apex **has no DNS record at
      all** — the one button the deployment exists to drive is dead. Nothing to
      fix here: it is a one-line `.env` change the moment a signup page exists,
      and until then this is the story's "where does the CTA point?" decision
      with neither of its two answers built
- [x] After `DEMO_TTL_SECONDS`, the reaper has deleted an expired tenant's rows
      **and** its `runs-demo/<id>/` directories — verified on the box, since this
      is the one US-036 assertion whose real-world half is disk. 2026-07-26: one
      tenant's `demo_expires_at` was back-dated a minute (rather than idling an
      hour — the sweep is what is under test, not the clock), and the next
      quarter-hourly sweep took it. Rows **and** all four `runs-demo/<id>/`
      directories went in the same pass, and it was surgical: the other 8 live
      tenants untouched, and `select count(*) from runs where user_id is null`
      still **0** — the orphan the reaper's delete-ordering exists to prevent.

      The half nobody wrote down: **the fixtures survived.** Every artifact in
      those directories is a symlink into `/app/demo`, so a recursive delete
      that followed links would have taken `recording.mp4` and `report.pdf` with
      it and broken every later run on the deployment — silently, since the
      reaper is the only thing that would have touched them and it runs
      unattended. `fs.rmSync` removes the links; `/app/demo/register-account`
      still lists all four files. Checked because the disk half is the reason
      this criterion says "on the box".
- [x] Enabling failure emails inside a sandbox and running a failing test sends
      **nothing** (no `notifications` row reaches `status=sent`) — 2026-07-26,
      and done as the attack it models: a visitor PUT their sandbox project to
      `notify=failure`, `notify_emails=["stranger@example.com"]` (accepted, 200),
      then ran the `discount-broken` fixture to a real `failed`. `notifications`
      holds **zero rows of any status**, and the only mail-shaped line in the
      logs is the name of migration `004_notifications.sql`. Worth knowing for
      the next person: the fixture only replays on an *exact* goal match, so a
      truncated goal falls through to `DEFAULT_FIXTURE` and passes — a failing
      run needs the seeded test's full goal string
- [x] The three stacks are isolated: a demo session cookie and a demo API key are
      refused by production and by staging, `qassist-demo_pgdata` is its own
      volume (2026-07-26 — both credentials 401 against staging; volumes are
      `qassist-demo_pgdata` and `qassist-staging_pgdata`). The **production half
      is untestable and stays unticked in spirit**: production does not exist,
      exactly as this story's last "decisions" bullet anticipated. Re-run the two
      curls when it does; `down -v` was not exercised, since proving it destroys
      the deployment it proves
- [x] `DEPLOY.md` documents standing it up and `.env.demo.example` carries the
      config table; nothing about the deployment lives only on the box
      (2026-07-26)

## Decisions to make while doing it

- **Does the demo run the production tag, or the promotion candidate?** Staging
  runs the candidate by definition. The demo is a public surface, so it should
  probably track production — but it is also the lowest-stakes place a bad tag
  can be discovered. Lean production's tag; revisit if that makes it a third
  thing to remember on every release.
- **Where does the CTA point?** `qassist.run` (marketing) or straight at the
  signup form on `app.qassist.run`. Depends on whether the marketing page exists
  by then; the variable makes it a one-line change either way.
- **1 h TTL, or longer?** An hour is US-036's default and is aimed at a single
  sitting. If the reset lands mid-evaluation for real visitors, the fix is
  US-036's deferred `last_seen` bump, not a bigger number.
- **Does production need standing up first?** Three of this story's isolation
  criteria mention production, and production deliberately does not exist yet
  (US-038). The demo does **not** depend on it — it can go up as the second live
  stack — but those criteria then carry the same "needs production" caveat
  US-038's do.
