# US-056 — Production deployment: `app.qassist.run` goes live

**As a** real user — or the demo visitor who just clicked the CTA — **I want**
the production stack standing at `app.qassist.run`, **so that** the product the
repo, the image and the runbook all describe is actually reachable, instead of
the proxy's default certificate.

- **Status:** 🔄 In progress (2026-07-29). The stack is **live** on
  `v0.3.0` — TLS, routing, auth and mail-send all proven. What is left is the
  half that needs a person: a signed-in account (magic link, BYOK key) for the
  run-and-report criteria, live Stripe keys, and a decision on the two
  destructive/box-level items. Results below. Originally created 2026-07-26 as
  📋 Planned. This ticket **is** the production
  stand-up. It is not new work: it collects every acceptance criterion from
  [US-007](done/US-007-https-reverse-proxy.md) and
  [US-038](done/US-038-staging-environment.md) that only a running production
  could meet, so those two stories could close on what they actually shipped and
  proved. One ticket, one box session, instead of two finished stories each held
  open by their last third.
- **Priority:** P1 (current sprint) — US-040's CTA already points here
  (`DEMO_CTA_URL=https://app.qassist.run`, live on the demo), so every demo
  visitor who converts currently lands on a certificate error.
- **Estimate:** ~1–2 h on the box. The runbook exists
  (`docs/deploy/production.md` first-time setup, `docs/deploy/staging.md`
  promotion), and its shape has been rehearsed three times — staging,
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
- `docs/deploy/production.md` documents the exact stand-up and the promotion
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

- [x] `https://app.qassist.run` serves the UI on its own Let's Encrypt
      certificate; API + WebSocket live view work through it — **partly**: cert
      `CN=app.qassist.run`, issuer Let's Encrypt YR1, valid to 2026-10-27,
      issued on the first request. API returns the UI and `/api/health`. The
      `/ws` upgrade reaches the app and is answered by the app's *own* 401, so
      Traefik forwards it; frame delivery still needs a signed-in run.
- [x] Port 8080 is not published to the host — **the QAssist half holds**;
      `ss -tlnp` finds nothing on 8080 and `docker compose -p qassist ps` shows
      `8080/tcp`, not a host mapping. The rest of that line does **not**: see
      "The box does not listen only on 22, 80, 443" below.
- [x] Unauthenticated requests get 401 (`/api/runs`)
- [ ] The certificate renews from the shared proxy's ACME resolver — issued
      from it, and it is stored on the same named volume; renewal itself is
      unobservable until ~2026-08-27
- [ ] `PUBLIC_BASE_URL` is set, and a real failing run on production mails its
      report through Resend with a run link that opens and a recording link in
      the PDF — `PUBLIC_BASE_URL` is set and the **mail path is proven**
      (`POST /api/auth/request-link` → `{"ok":true}`, no error from Resend), but
      the run half needs a signed-in account with a BYOK key

Carried from US-038 (the two-stack proofs that needed a second stack to exist):

- [ ] `docker compose -p qassist-staging down -v` destroys staging's database
      and leaves production's untouched — **deliberately not run.** The
      project-scoping was already proven with a `qassist-scratch` stack, and
      re-proving it here costs staging's seed and its live Stripe test
      subscription. What was checked instead, non-destructively: every
      `pgdata` volume carries a `com.docker.compose.project` label naming its
      own stack (`qassist`, `qassist-staging`, `qassist-demo`,
      `qassist-preview`), and `down -v` removes only volumes labelled with the
      project it was given. Run the real thing when staging next needs
      re-seeding anyway.
- [ ] A staging session cookie and a staging API key are both refused by
      production, and vice versa — **not yet observed.** The obvious shortcut
      does not work: with `AUTH_ENABLED=1` a bare `WORKER_API_TOKEN` is refused
      on its *own* stack too, so all four directions return 401 and the cross
      refusal proves nothing. This needs a real per-account API key on each
      side, which needs a sign-in on production.
- [ ] Production's live-mode webhook endpoint never sees a staging test event —
      blocked: production has no live-mode endpoint yet
- [ ] Before live keys take a real card: an **immediate** cancellation on
      staging fires `customer.subscription.deleted` and the account's next
      run-start gets 402 — deferred by decision 2026-07-29, and it gates the
      live keys rather than the stand-up

And the loose end this closes for free:

- [x] The demo's CTA click lands on the app instead of a certificate error —
      `DEMO_CTA_URL` still `https://app.qassist.run`, which now answers `200`
      on a verified certificate. Demo was moved to `0.3.0` in the same pass and
      still reports `auth_mode=demo`, `billing=false`, `mail=false`.

## What was found standing it up

**The box does not listen only on 22, 80, 443.** An unrelated stack on the same
box (`self-hosted-mysql`) publishes `0.0.0.0:3306`, and `ufw` has an explicit
`3306/tcp ALLOW Anywhere` rule to match. `mysql:8.0` answers its handshake to
the public internet — confirmed from off-box, banner `8.0.46`. Its
`mysql_backup` sidecar has been crash-looping for two weeks. Nothing here
touched it: it is not QAssist's stack and closing the port may break whatever
uses it. It is recorded because the criterion above is a statement about the
box, and the box is now production's.

Docker publishes a port by writing its own iptables rules, which bypass ufw's
`INPUT` chain — so removing the ufw rule alone would **not** close 3306. The
fix is the port mapping in that stack's compose file (bind `127.0.0.1:3306` or
drop the mapping), not the firewall.

**`TRUST_PROXY` was missing from staging and demo.** US-040 established that
every stack behind the proxy needs it, and production was written with it — but
neither `.env.staging` nor `.env.demo` had ever been given the line, so on both
of them `req.ip` was the proxy container and every per-IP guard (the magic-link
rate limit, the demo's mint throttle) was really a per-deployment guard. Added
to both in this pass and confirmed in the container (`printenv TRUST_PROXY` →
`1`). Preview was not checked.

**The redirect is 308, not 301.** `docs/deploy/production.md`'s verification
snippet expected `301`; Traefik's `redirectscheme` middleware issues a
permanent 308. Corrected in the runbook.

**`main` had 55 commits to catch up.** The `--ff-only` promotion held —
238 files, no merge commit — so the invariant that `main` is nothing but
staging's history survived its first real exercise. The release could not be
cut from `staging` as it stood: `release.yml` fails a tag whose version does
not match the pin in `docker-compose.release.yml`, so the version bump has to
travel the chain like any other commit rather than being done at tag time.
That is worth knowing before the next release, not during it.

## Still to do

1. Sign in on production (link already sent), store a BYOK key, and run a
   deliberately failing test — that closes the run/report/mail criterion and
   the WebSocket half of the first one in the same run.
2. With an account in place, mint a production API key and observe the four
   cross-stack 401s properly.
3. Live Stripe: create production's own endpoint at
   `https://app.qassist.run/api/billing/webhook`, put that endpoint's signing
   secret, the live key and the live price in `.env`, and bring the stack up.
   Do the staging immediate-cancellation test first — it is the one billing
   path that has never seen a real event.
4. DMARC `p=none` on `_dmarc.qassist.run` — still absent (checked 2026-07-29).
5. Decide what to do about 3306.
