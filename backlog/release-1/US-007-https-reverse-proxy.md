# US-007 — Public HTTPS via reverse proxy

**As a** user or CI pipeline, **I want** to reach the QAssist UI/API over HTTPS without an SSH tunnel, **so that** the service is usable from anywhere and integrations become possible.

- **Status:** 📋 Planned
- **Priority:** P1 (Release 1) — hard dependency of US-008 tier 1 (CI must reach the API); unblocks any external users
- **Estimate:** ~2 h (plus domain/DNS)
- **Depends on:** app domain is **qassist.run** (decided 2026-07-22) — point it
  at the VPS. `arang.space` stays dedicated to US-013's catch-all test mail via
  Cloudflare Email Routing

## Details

- Caddy on the VPS terminating TLS on 443 (auto Let's Encrypt), reverse-proxying
  to `localhost:8080` (HTTP + WebSocket upgrade for `/ws`).
- ufw already allows 443; **keep 8080 firewalled** (current design) so the only
  path in is through Caddy.
- Token auth stays mandatory (`WORKER_API_TOKEN` on every API/WS call) — HTTPS
  is transport, not auth.
- Consider basic rate limiting at Caddy for `/api/runs`.

Current workaround being replaced: `ssh -L 8090:localhost:8080 qagent-vps`.

## The DNS trip also finishes US-012 (added 2026-07-23)

[US-012](done/US-012-email-reports.md) shipped with one thing outstanding: no
mail has ever gone through Resend, because Resend only delivers to the account
owner's own address until the sender domain is verified — and verifying it
means adding SPF/DKIM records to qassist.run, which is the same DNS panel this
story is already in for the A record. So the proof lands here rather than
re-opening a finished story: the story stays in `done/`, and the criteria below
carry the send.

`PUBLIC_BASE_URL` needs setting to `https://qassist.run` in the same pass — it
is what puts a working recording link in the PDF and a working run link
([US-030](done/US-030-run-permalink.md)) in the mail, and until this story
there was no URL to give it.

## Acceptance criteria

- [ ] `https://qassist.run` serves the UI; API + WebSocket live view work through it
- [ ] Port 8080 remains unreachable externally
- [ ] Unauthenticated requests still get 401
- [ ] Certificate auto-renews (Caddy default)
- [ ] qassist.run is verified in Resend (SPF + DKIM), and a real failing run
      mails its report to an address that is **not** the Resend account owner's
- [ ] `PUBLIC_BASE_URL` is set, and the run link in that mail opens the run
