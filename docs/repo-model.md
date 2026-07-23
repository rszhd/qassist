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
are [US-031](../backlog/release-1/US-031-license-and-public-repo.md).

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
4. **Orchestrate, don't reimplement.** The cloud provisions/manages
   instances of the open-source app; it never grows a second implementation
   of test management. Every cloud customer runs the code self-hosters run.

## Feature routing rule

Before building anything, ask: **"would a self-hoster want this?"**

- Yes, or ambiguous → this repo (default to public; it strengthens the
  product and prevents scope-smuggling into the private side).
- Only meaningful with our infrastructure or our billing → private repo
  (or env-gated here, while the private repo doesn't exist).

## Before flipping this repo public

Owned by [US-031](../backlog/release-1/US-031-license-and-public-repo.md); two
of the three are already answered.

- gitleaks/trufflehog scan of full git history; if anything is found,
  prefer a fresh squashed initial commit over history scrubbing. **Still to
  do** — a by-hand check on 2026-07-23 found no key in `git log --all -p`, no
  committed `.env`, and no host IP in any tracked markdown, but a grep is not
  a scanner.
- ~~Decide whether README/backlog keep the deployment host's IP.~~ Moot: no
  tracked file names it.
- ~~Decide CLA/DCO~~ **DCO** (2026-07-23) — `Signed-off-by`, copyright stays
  with the author. A CLA is what you need to relicense unilaterally later; the
  repo has one author, so that is not a problem it has yet.
