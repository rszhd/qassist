# Repo model: open-source product vs. paid cloud

Decided 2026-07-22. This note records how the codebase splits (or doesn't)
between open source and the paid offering, so feature-placement decisions stay
consistent. The backlog holds *what* we build; this holds *where* it goes.

## The model

**This repo is the product, and it is the only repo for now.** Engine
(`agent/`), server, frontend, control plane (Postgres, saved tests,
scheduling, notifications), auth, and even Stripe billing all live here and
ship open source under **AGPL-3.0-only** — settled 2026-07-23, with
contributions under a DCO rather than a CLA; the reasoning and the checklist
are [US-031](../backlog/sprint/current/done/US-031-license-and-public-repo.md).

The paid hosted tier at qassist.run runs this exact codebase. Billing is
**env-gated**: with `STRIPE_*` unset — the self-host default — there is no
billing UI and no gating; everything is free. Self-hosting is always free.
Payment covers hosting only; LLM tokens are BYOK (US-005) on every tier.

**A private cloud repo gets created later**, only when genuinely cloud-only
infrastructure exists: multi-tenant orchestration / managed browser fleet,
included-and-metered LLM usage, managed test inboxes, hosted artifact
storage, billing beyond one Checkout plan. One webhook handler does not
justify a second repo.

## Rules when the private repo exists

1. **Artifacts, not source.** The public repo's CI publishes a versioned
   Docker image per tagged release (`qassist:vX.Y.Z`). The private repo
   pins and deploys that image and talks to it over the same token-authed
   HTTP/WS API a self-hoster uses. Never a source fork, no git submodule,
   no `/ee` folder, no code sync.
2. **Dependency direction is one-way: public → private.** If the cloud needs
   shared types, the public repo publishes them (small npm package or
   OpenAPI file); the private repo consumes. Nothing in this repo may ever
   reference the private repo.
3. **The API contract is the interface.** Additive API changes are free;
   breaking changes must be handled in the private repo when it bumps the
   pinned image tag.
4. **Orchestrate, don't reimplement.** The cloud deploys and operates the
   open-source app; it never grows a second implementation of test
   management. Every cloud customer runs the code self-hosters run.

## Tenancy: the hosted tier is one shared instance

**qassist.run is a single shared deployment** (settled 2026-07-25) — one app
process, one Postgres,
`AUTH_ENABLED=1` — and customers are `users` rows. **The only way to get your
own instance is to self-host**; the cloud never provisions a container per
signup, so there is no per-tenant proxy, no tenant DNS, no per-tenant database.

This is what the code already assumes, and the reason it isn't up for
relitigation: `server/src/runs.js` runs one in-process queue under a global
`MAX_CONCURRENT`, and `MAX_CONCURRENT_PER_USER` exists as a sub-cap purely so
one customer can't fill the shared browser pool and queue everyone else. Give
each customer their own container and that setting protects nobody. The
row-level `user_id` on every table (`tests`, `suites`, `projects`, `runs`,
`schedules`) is the same signal — that is how tenants sharing a database are
separated, not how containers are. A Chromium container per customer is also
the expensive way to buy isolation a self-hoster can already have for free.

The consequence for the private repo: its job is billing, plans and the
marketing site, and it pushes **entitlements** into an instance it deploys but
does not fork. Note that no such API exists yet — every route is tenant-scoped
through `currentUserId()`, and `MAX_CONCURRENT_PER_USER` is one global env var,
so today there is no way to say "this user gets 4 concurrent runs". Per rules 1
and 2 the cloud may not reach into the database to do it either. An additive
operator-scoped entitlements endpoint in *this* repo is therefore a
prerequisite for any paid plan that differs by quota.

## Feature routing rule

Before building anything, ask: **"would a self-hoster want this?"**

- Yes, or ambiguous → this repo (default to public; it strengthens the
  product and prevents scope-smuggling into the private side).
- Only meaningful with our infrastructure or our billing → private repo
  (or env-gated here, while the private repo doesn't exist).

## Going public — done

The repo is public. The pre-flip checklist that lived here is closed:
licensing is DCO not CLA, no tracked file names the deployment host, and the
full git history is scanned by gitleaks — the config and the command to run it
yourself are in [CONTRIBUTING.md](../CONTRIBUTING.md). The decisions are
recorded in
[US-031](../backlog/sprint/current/done/US-031-license-and-public-repo.md).
