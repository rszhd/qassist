# US-007 — Public HTTPS via reverse proxy

**As a** user or CI pipeline, **I want** to reach the QAgent UI/API over HTTPS without an SSH tunnel, **so that** the service is usable from anywhere and integrations become possible.

- **Status:** 📋 Planned
- **Priority:** P1 — unblocks US-008 (CI/CD) and any external users
- **Estimate:** ~2 h (plus domain/DNS)
- **Depends on:** a domain name pointed at the VPS

## Details

- Caddy on the VPS terminating TLS on 443 (auto Let's Encrypt), reverse-proxying
  to `localhost:8080` (HTTP + WebSocket upgrade for `/ws`).
- ufw already allows 443; **keep 8080 firewalled** (current design) so the only
  path in is through Caddy.
- Token auth stays mandatory (`WORKER_API_TOKEN` on every API/WS call) — HTTPS
  is transport, not auth.
- Consider basic rate limiting at Caddy for `/api/runs`.

Current workaround being replaced: `ssh -L 8090:localhost:8080 qagent-vps`.

## Acceptance criteria

- [ ] `https://<domain>` serves the UI; API + WebSocket live view work through it
- [ ] Port 8080 remains unreachable externally
- [ ] Unauthenticated requests still get 401
- [ ] Certificate auto-renews (Caddy default)
