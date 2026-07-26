# US-056 — Production deployment: `app.qassist.run` goes live

**As a** real user — or the demo visitor who just clicked the CTA — **I want**
the production stack standing at `app.qassist.run`, **so that** the product the
repo, the image and the runbook all describe is actually reachable, instead of
the proxy's default certificate.

- **Status:** 📋 Planned (created 2026-07-26). This ticket **is** the production
  stand-up. It is not new work: it collects every acceptance criterion from
  [US-007](done/US-007-https-reverse-proxy.md) and
  [US-038](done/US-038-staging-environment.md) that only a running production
  could meet, so those two stories could close on what they actually shipped and
  proved. One ticket, one box session, instead of two finished stories each held
  open by their last third.
- **Priority:** P1 (current sprint) — US-040's CTA already points here
  (`DEMO_CTA_URL=https://app.qassist.run`, live on the demo), so every demo
  visitor who converts currently lands on a certificate error.
- **Estimate:** ~1–2 h on the box. The runbook exists (`DEPLOY.md`, first-time
  setup + promotion), and its shape has been rehearsed three times — staging,
  demo and preview are the same two compose files with a different `-p` and
  `--env-file`.
- **Depends on:** [US-007](done/US-007-https-reverse-proxy.md) (proxy, overlay,
  DNS, mail — done), [US-038](done/US-038-staging-environment.md) (the
  rehearsal — done),
  [US-052](done/US-052-staging-branch-continuous-deploy.md) (production pins a
  release tag cut from `main`, and the first `--ff-only` promotion was
  deliberately deferred to the first release — standing production up is what
  forces it)

## What already exists

Everything except the stack itself:

- `app.qassist.run` resolves to the VPS (DNS, 2026-07-25), and the shared
  Traefik proxy (`qassist-proxy`) is up with its ACME store on a named volume.
  Production is one more router discovered off Docker labels — the proxy's own
  config does not change.
- qassist.run is verified in Resend (SPF + DKIM), and real mail has left
  through it from staging to a recipient who is not the account owner.
- `DEPLOY.md` documents the exact stand-up and the promotion
  (staging-proven commit → `main` → tagged release → production pins the tag).
- The box runs `qassist-proxy`, `qassist-staging`, `qassist-demo` and the
  preview stack. There is no `qassist` production project; standing it up
  changes nothing for the other four.

## The config that is production's alone

US-038's config table is the reference; the values that make this stack
production rather than a fourth rehearsal:

- `PUBLIC_BASE_URL=https://app.qassist.run`
- **Live** Stripe keys, the live price, and production's **own** webhook
  endpoint with that endpoint's signing secret
- Real recipients (`NOTIFY_EMAILS` / `OPERATOR_EMAIL`)
- `SESSION_SECRET`, `NOTIFY_SECRET`, `KEY_ENCRYPTION_SECRET`,
  `WORKER_API_TOKEN`: distinct from every other stack on the box
- `TRUST_PROXY=1` — behind Traefik, or `req.ip` is the proxy for every request
  (US-040's finding; off is only right for a self-host publishing its own port)
- `QASSIST_IMAGE` pinned to the release tag — **which tag is the release
  decision US-052 deferred**: the first `--ff-only` promotion of `staging` into
  `main` and the tag cut from it happen as part of this stand-up
- `MAX_CONCURRENT_SESSIONS` at the box's real cap (staging keeps its 1)
- While in the DNS panel: DMARC at `p=none` on `_dmarc` — optional, carried
  from US-007, worth it now that mail is flowing

## Acceptance criteria

Carried from US-007 (the stack itself):

- [ ] `https://app.qassist.run` serves the UI on its own Let's Encrypt
      certificate; API + WebSocket live view work through it
- [ ] Port 8080 is not published to the host (Traefik reaches `qassist` over
      the compose network); the box still listens only on 22, 80, 443
- [ ] Unauthenticated requests get 401
- [ ] The certificate renews from the shared proxy's ACME resolver (store on
      the named volume staging's cert already lives in)
- [ ] `PUBLIC_BASE_URL` is set, and a real failing run on production mails its
      report through Resend with a run link that opens and a recording link in
      the PDF

Carried from US-038 (the two-stack proofs that needed a second stack to exist):

- [ ] `docker compose -p qassist-staging down -v` destroys staging's database
      and leaves production's untouched — the production half; the
      project-scoping itself was already proven with a `qassist-scratch` stack
- [ ] A staging session cookie and a staging API key are both refused by
      production, and vice versa — the four signing secrets are already
      distinct values; this observes the 401s
- [ ] Production's live-mode webhook endpoint never sees a staging test event
      (deliver one to staging after production is up and confirm)
- [ ] Before live keys take a real card: an **immediate** cancellation on
      staging (Stripe dashboard, not the Customer Portal — the Portal
      schedules) fires `customer.subscription.deleted` and the account's next
      run-start gets 402. This is the remainder of US-038's Stripe round trip
      after [US-051](done/US-051-subscription-dates-from-stripe.md) closed the
      period-end half — the one billing path that has never run against a real
      event

And the loose end this closes for free:

- [ ] The demo's CTA click lands on the app instead of a certificate error
      (US-040's closing note)
