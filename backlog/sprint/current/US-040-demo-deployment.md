# US-040 — The demo sandbox, deployed at `demo.qassist.run`

**As a** visitor who has never heard of us, **I want** to click "Try the demo"
and be inside the working product in a second, with no signup and no key, **so
that** I can decide whether to sign up; and **as the** operator, **I want** that
surface to be a third isolated stack that can neither reach production's data
nor spend anything.

- **Status:** 🧱 Repo side done (2026-07-26) — the image carries `demo/`,
  `TRUST_PROXY` makes the per-IP throttle per-*visitor* behind the proxy
  (assertion-first), and `.env.demo.example` + `DEPLOY.md`'s Demo section
  document the stand-up. What is left is the box: DNS, a tag built after
  `v0.2.0`, and the criteria only a live deployment can close.
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
      fixture dirs; the `exec` half re-checks it on the box, on the first tag
      built after `v0.2.0`
- [x] A visitor is throttled by *their* address, not by Traefik's — the
      `TRUST_PROXY` fix above, without which `DEMO_IP_MAX` caps the whole
      deployment (2026-07-26; the box half is two networks, e.g. a laptop and a
      phone off wifi, since one machine sees the same refusal either way)
- [ ] `https://demo.qassist.run` serves the UI on its own Let's Encrypt
      certificate through the shared proxy, `http` 308s to `https`, and
      `printenv PUBLIC_BASE_URL` inside the container says `demo.qassist.run`
      (US-038's failure-that-looks-like-success check)
- [ ] A visitor with no cookie lands and is inside a seeded tenant with no login
      wall: History, Projects, Suites, Schedules and Settings all populated
- [ ] Pressing Run streams a replay over the WebSocket through Traefik and
      writes a run into *their* history — and `docker stats` shows no Chromium,
      `/api/health` reports `agent_ready:false`, and no LLM call is made
- [ ] Two browsers (or one plus a private window) get two tenants that cannot
      see each other's tests or runs
- [ ] The demo banner names the expiry and its CTA links to the real signup page
- [ ] After `DEMO_TTL_SECONDS`, the reaper has deleted an expired tenant's rows
      **and** its `runs-demo/<id>/` directories — verified on the box, since this
      is the one US-036 assertion whose real-world half is disk
- [ ] Enabling failure emails inside a sandbox and running a failing test sends
      **nothing** (no `notifications` row reaches `status=sent`)
- [ ] The three stacks are isolated: a demo session cookie and a demo API key are
      refused by production and by staging, `qassist-demo_pgdata` is its own
      volume, and `docker compose -p qassist-demo down -v` touches neither of the
      others
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
