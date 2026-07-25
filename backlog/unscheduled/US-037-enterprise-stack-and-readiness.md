# US-037 — Enterprise stack & readiness: what to adopt, what to refuse

**As a** maintainer of a 1–3 person, AI-assisted codebase, **I want** a decided position on which "enterprise standard" stack pieces we adopt, **so that** an enterprise buyer's questionnaire is answerable without the codebase acquiring ceremony that a team this size cannot carry.

- **Status:** 📋 Planned (tiered — tiers 1–3 are the real scope; 4–5 are demand-gated)
- **Priority:** P2 overall (tier 1 is P1 the moment anything runs in production for someone else)
- **Estimate:** tier 1 ~2–3 d, tier 2 ~2–3 d, tier 3 ~1 w, tier 4 ~3–5 d, tier 5 ~1 w
- **Depends on:** US-021 (accounts — tiers 3 and 5 have nowhere to hang otherwise),
  US-007 (public HTTPS — tier 5's IdP callbacks)

## The premise this story rejects

"Enterprise stack" and "enterprise-ready" are different purchases, and conflating
them is how a small team ends up maintaining a framework instead of a product.

What actually blocks an enterprise deal is **SSO/SAML + SCIM, an audit log, RBAC,
data residency, an SLA, a security questionnaire, SOC 2**. None of those are
framework choices. Every one of them ships fine on the Express app in this repo
today. The inverse also holds: NestJS + Kubernetes + Kafka loses the same deal if
there is no audit trail.

So this story adopts the common stack only where it buys leverage or legibility,
and says plainly where it does not. The existing entries under **Stack decisions
(settled)** in `CLAUDE.md` are not reopened by this file — a tier that changes one
of them updates `CLAUDE.md` in the same commit, or it is out of scope.

## The decided stack

| Layer | Choice | Why this, over the enterprise default |
|---|---|---|
| Language | **TypeScript strict**, Node 22 LTS | `// @ts-check` + JSDoc is already ~90% of the way. Real `.ts` is worth it for *inference* from Zod/Drizzle, not for the annotations. |
| HTTP | **Fastify**, not NestJS | Buys the legible parts — JSON-Schema validation, OpenAPI generation, `pino` structured logs, plugin encapsulation — without a DI container. NestJS is correct only if we plan to hire past ~5 people who already know it. |
| Contracts | **Zod → generated OpenAPI → typed client** | Highest-leverage single change. One definition drives runtime validation, TS types, API docs and the frontend client. |
| DB | **Postgres + Drizzle** | Keeps the raw-SQL honesty `db/README.md` argues for (SQL-shaped, migrations are reviewable files) while inferring types from schema. Prisma is more common but hides SQL behind an engine — that is a downgrade from where we are. |
| Jobs | **Postgres `SKIP LOCKED`** (or `pg-boss`) | Deliberately *not* BullMQ + Redis. Redis is a second stateful component to operate for no gain at our scale, and it breaks the one-image self-host story. |
| Frontend | **Vite SPA + TanStack Query/Router + Tailwind + shadcn/ui** | Not Next.js. This is a live-WebSocket dashboard served by Express as one image; SSR buys nothing and costs a second deploy target. shadcn is copy-in components we own — it composes with `docs/design-system.md` rather than replacing it. |
| Auth | Magic link (self-host) + **WorkOS** for enterprise SSO/SCIM | Hand-rolling SAML is a trap. Keycloak only if a customer contractually demands a self-hosted IdP. |
| Observability | **OpenTelemetry + pino → one vendor** (Grafana Cloud / Axiom), Sentry | Cheap, and it is what security questionnaires ask about. |
| Python agent | Stays Python — **uv + ruff + mypy strict** | `browser-use` settles the language. The gap is packaging hygiene, not runtime. |
| Deploy | Compose for self-host; **Fly / Render / ECS** hosted | Kubernetes is the classic 1–3 person tarpit. Revisit only if per-run browser isolation outgrows a process boundary (see US-015). |
| CI | GitHub Actions + Renovate + signed images + SBOM | SBOM and signing show up in real security reviews. Extends US-032 rather than replacing it. |

### Explicitly refused

NestJS DI, GraphQL, microservices, Kubernetes, Kafka, Nx/Turborepo (pnpm
workspaces suffices), event sourcing, hexagonal/clean-architecture layering.
Each carries a fixed tax per feature and repays only at team sizes we do not
have. This is the same list as `CLAUDE.md`'s **Avoid**, restated with reasons so
it survives the next person who asks why we are not on NestJS.

## Why AI-assisted coding changes the calculus

Not decoration — these are the reasons several rows above differ from advice
written for a human-only team of the same size.

- **Over-invest in types and schemas.** A model produces plausible-but-wrong
  field names confidently. A strict compiler catches that in seconds; a human
  reviewer catches it in an hour or misses it. Types convert review burden into
  build errors, which is the best trade available at this headcount.
- **Training-data density is a legitimate selection criterion.** Models write
  Tailwind/shadcn/Drizzle/Zod/Fastify unusually well. A niche-but-elegant library
  now costs real output quality.
- **Generated artifacts beat hand-kept parallel code.** An OpenAPI client and DB
  types generated from one source remove the drift bugs AI edits are most likely
  to introduce.
- **Flat, explicit, local code edits better than clever indirection.** Decorator
  magic and DI graphs make model output worse — a second, independent reason for
  Fastify over NestJS.
- **One verify command is an architectural property.** Its speed is the agent's
  feedback loop. Today that is `npm test` + `npm run check`; merging them behind
  one script is cheap and belongs in tier 1.
- The existing "split by feature, ≤~300 lines per file" rule in `CLAUDE.md` is
  already an AI-legibility rule. Keep it.

## Tiers

Ordered by payoff, not by how modern they sound. Tiers 1–3 are additive to the
current stack and need no migration; tier 4 is the only rewrite; tier 5 waits for
a named customer.

1. **Observability** — OTel traces + `pino` structured logs to one vendor, Sentry
   for errors. Also merges the verify commands into one script.
2. **Zod at every HTTP boundary** — works as-is under Express; no framework change
   required. Generated OpenAPI falls out of it and feeds US-008/US-029.
3. **Audit log + RBAC** — the actual procurement blockers, and pure additive work
   on top of US-021's tenants.
4. **TypeScript migration** — mechanical from the existing JSDoc. Do it when it
   stops feeling optional, not before.
5. **Enterprise SSO/SCIM via WorkOS** — env-gated exactly like Stripe
   (`WORKOS_*` unset ⇒ magic link only, no UI, no gating), per
   `docs/repo-model.md`. When a customer asks, not before.

**Opportunistic or never:** Fastify, Drizzle, Tailwind + shadcn. These are where
a greenfield build would land; they are not worth a migration on ~10k lines that
already work. Adopt only if a tier above happens to open the relevant file
anyway.

### Assertion-first surfaces

Tier 3 is correctness-critical under `CLAUDE.md`'s workflow rule: an RBAC check
that fails open, or an audit row that silently does not get written, is exactly
the class of bug that reads fine and is wrong. Tier 5 joins it — an SSO
assertion that maps an unverified email onto an existing tenant is a
cross-tenant breach. Both get reviewed assertions before implementation, and a
row each in [`correctness-critical.md`](../correctness-critical.md) when the
work is scheduled.

## Acceptance criteria

### Tier 1 — observability

- [ ] Every HTTP request and every run emits an OTel trace; a run's spans cover
      spawn → agent steps → report render
- [ ] Logs are structured JSON (`pino`) with a run id / tenant id on every line,
      and no secret ever reaches a log line (reuses `agent/redact.py`'s rules)
- [ ] Traces and logs land in one vendor, configured by env; unset ⇒ local
      stdout only, no vendor dependency for a self-hoster
- [ ] Unhandled errors reach Sentry with the run id attached
- [ ] One command (`npm run verify`) runs typecheck + tests for the server

### Tier 2 — Zod at the boundary

- [ ] Every `routes/*.js` endpoint validates its body/params/query against a Zod
      schema; invalid input yields a 400 with a field-level error shape
- [ ] The schemas are the only definition — request types are inferred from them,
      not restated in JSDoc
- [ ] An OpenAPI document is generated from the schemas and served (or committed),
      and US-008's documented `curl` snippet is checked against it
- [ ] The frontend's `api.js` consumes generated types rather than hand-written ones

### Tier 3 — audit log + RBAC

- [ ] An `audit_log` table records actor, tenant, action, target, timestamp and
      source IP for every state-changing API call; entries are append-only
- [ ] Roles (at minimum owner / member / viewer) gate every mutating endpoint;
      a viewer cannot start, edit or delete anything
- [ ] Authorization is asserted centrally — no endpoint can be added without a
      role decision (a route missing one fails a test, not a review)
- [ ] The reviewed assertions for tenant isolation and fail-closed default exist
      **before** the implementation, and `correctness-critical.md` carries a row
- [ ] The audit log is exportable (CSV or JSON) by an owner

### Tier 4 — TypeScript

- [ ] `server/src/` is `.ts` under `strict`, and `npm run check` is `tsc --noEmit`
      over real types rather than JSDoc
- [ ] No `any` in the diff; no build step is added to production start
      (`tsx`/`node --experimental-strip-types`, decided in the story)
- [ ] `CLAUDE.md`'s "plain JS with `// @ts-check` + JSDoc; no TS build step" line
      is rewritten in the same commit
- [ ] Test and dev-server ergonomics do not regress (`node --watch` still works)

### Tier 5 — enterprise SSO/SCIM

- [ ] `WORKOS_*` unset ⇒ magic-link auth exactly as today, no SSO UI, no gating
- [ ] With it set, an org admin can connect an IdP and their users sign in via SSO
- [ ] SCIM provisioning creates and deactivates users against the right tenant
- [ ] A deactivated user's session and API keys stop working immediately
- [ ] Reviewed assertion first: an SSO identity may never be joined to an existing
      tenant on an unverified email match

## Tradeoffs to record when this ships

- Which tiers were taken and which were declined, with the demand signal that
  decided each — this file's value is mostly the refusals.
- Whether OTel's overhead is measurable on a run (record the number; US-006 left
  its recording CPU cost unmeasured and that gap has been awkward since).
- If tier 4 happens: how long the migration actually took, against the ~3–5 d
  estimate. That number decides whether the frontend follows.
